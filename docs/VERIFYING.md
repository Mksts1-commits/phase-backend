# Verifying Phase chain data by hand

You don't need an account, an API key, or the phase-backend repo to verify that
a balance on a Phase sovereign chain is real. Everything below uses only the
public endpoints and standard primitives (SHA-256, Ed25519, base58).

Base URL for the examples: `https://phase-backend.onrender.com`
All endpoints below are `GET` and unauthenticated.

## 1. Pin the sequencer key

```
GET /api/v1/public/sequencer
```

Response:

```json
{
  "pubkey_hex": "…64 hex chars, raw 32-byte Ed25519 public key…",
  "pubkey_base58": "…",
  "announcement": {
    "message": "phase-sequencer/v1|<pubkey_hex>",
    "signature_hex": "…128 hex chars…"
  }
}
```

Check the announcement before you trust the key:

- `message` must equal exactly `phase-sequencer/v1|<pubkey_hex>`.
- `signature_hex` must be a valid Ed25519 signature over the UTF-8 bytes of
  `message`, verified with `pubkey_hex`.
- Ed25519 public keys here are raw 32-byte keys. Most libraries want them
  wrapped: prepend the SPKI prefix `302a300506032b6570032100` (hex) to the
  32 raw bytes and import as DER SPKI.

Pin `pubkey_hex` out-of-band (your config, your database). Every check below
reduces to "did the holder of this key sign it?".

## 2. Get a balance proof

```
GET /api/v1/public/chains/<chainId>/proofs/balance/<address>?height=<N>
```

(`height` is optional; omit it for the latest block.)

Response:

```json
{
  "address": "ph1…",
  "balance": "1500",
  "nonce": 3,
  "height": 42,
  "state_root": "…64 hex…",
  "proof": ["…64 hex…", "…"],
  "proof_directions": ["right", "left", "…"],
  "leaf_index": 5,
  "header_hash": "…64 hex…",
  "sequencer_sig": "…128 hex…"
}
```

## 3. Recompute the leaf (exact byte layout)

```
leaf = SHA256( UTF8( chainId + "|" + address + "|" + balance + "|" + nonce ) )
```

- `chainId`, `address`: the literal strings (e.g. `ch_9d68…`, `ph1…`).
- `balance`: the **decimal string** exactly as returned (no commas, no padding).
- `nonce`: the decimal integer, no padding.
- Join the four fields with the ASCII pipe character `|`, UTF-8 encode,
  SHA-256 hash. The result is 32 bytes.

Example (values from the test suite — see §6):

```
chainId  = "ch_test_…"
address  = "ph1…"
balance  = "1500"
nonce    = 3
preimage = "ch_test_…|ph1…|1500|3"
leaf     = SHA256(preimage) = <…>
```

## 4. Walk the merkle proof

Phase uses a binary Merkle tree that **duplicates the last leaf when a level
has an odd number of nodes**. Proof steps come as parallel arrays `proof[i]`
(hex) and `proof_directions[i]` (`"right"` means the sibling goes on the
right).

```
computed = leaf
for i, siblingHex in enumerate(proof):
    sibling = hex_decode(siblingHex)          # 32 bytes
    if proof_directions[i] == "right":
        computed = SHA256(computed || sibling)
    else:
        computed = SHA256(sibling || computed)
assert computed.hex() == state_root
```

If the final hash equals `state_root`, the `(address, balance, nonce)` tuple
was in the state tree at that block height. Forging this requires forging a
SHA-256 preimage.

## 5. Chain the proof to the sequencer

The state root alone is just a hash — you must also check that the block
header it came from was signed by the sequencer key you pinned in §1:

```
assert Ed25519_Verify(
    pubkey    = pinned pubkey_hex (32 bytes),
    message   = hex_decode(header_hash),   # the raw 32-byte header hash
    signature = hex_decode(sequencer_sig),  # 64 bytes
)
```

The sequencer signs the 32-byte header hash directly (not a hash of it, not
a JSON blob). If this verifies, the block — and therefore the state root,
and therefore your balance proof — is attested by the sequencer.

## 6. Worked example (real values from `test-public-verification.ts`)

> The test prints a full worked example on every run. Values below are from a
> representative run — recompute against your own run for a live check.

```
chainId      = ch_6c0929b2-641c-4126-b9d9-9da4453ad2a2
address      = ph182BY4GFDieXEMQTDQxaaWyLQBC4nPMETdnByqkHs5Zre
balance      = "1500"  nonce = 0  height = 1
leaf         = SHA256("ch_6c0929b2-641c-4126-b9d9-9da4453ad2a2|ph182BY4GFDieXEMQTDQxaaWyLQBC4nPMETdnByqkHs5Zre|1500|0")
             = afc565032919b9aa660c3329401574dab7a7013ac69f50fa1436c60883c12769
state_root   = 629cdbbfaaaacfe0ef2a007361b9d2da1a470e0286522eccf803a7ffb73cc613   (walk matches ✓)
header_hash  = c0ba747ba1e82f774be298ce981913ac115a6ed67603fbab7b82ad737dc43a29   (sequencer sig ✓)
```

## 7. Transaction proofs

```
GET /api/v1/public/chains/<chainId>/proofs/transaction/<txId>
```

The transaction leaf is:

```
leaf = SHA256( UTF8(tx_id) || UTF8(canonical_json(tx_wire_object)) )
```

where `tx_wire_object` is the snake_case form:

```json
{
  "chain_id": "…",
  "tx_id": "…",
  "type": "TRANSFER",
  "sender": "ph1…",
  "nonce": 3,
  "payload": { "to": "ph1…", "amount": "1500", "memo": "…" },
  "signatures": [ { "pubkey": "…64 hex…", "signature": "…128 hex…" } ],
  "submitted_at": 1761158400000
}
```

and `canonical_json` means: JSON with object keys sorted recursively
(no whitespace). Walk the proof exactly as in §4 against `tx_root`, then
verify `sequencer_sig` over `header_hash` as in §5.

To check the *sender's* signature on the transaction itself: the signed
message is `UTF8(canonical_json(tx_wire_object minus the signatures field))`,
Ed25519-verified with the `pubkey` in `signatures[0]` (which must itself
decode to the `sender` address: `ph1` + base58(pubkey)).

## 8. What this proves — and what it doesn't

Proves: at block N, attested by the sequencer key you pinned, address A held
balance B with nonce C; transaction T was included in block N.

Doesn't prove: that the sequencer key itself is honest (that's what key
pinning + independent root mirrors are for — see `docs/LOCK_PROOF_STANDARD.md`),
or anything about off-chain agreements. Verification is checkable, not
trustless — which is exactly the point.
