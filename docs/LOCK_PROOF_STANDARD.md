# Phase Lock-Proof Standard — `phase-lock-proof/1`

A chain-agnostic standard for proving "these Phase coins are locked" so that
**any** chain, wallet, or exchange can implement an importer without Phase's
permission. Phase ships the first importer (Solana); the standard must never be
Solana-specific.

## 0. The trust caveat (read first)

No two-way peg is ever fully trustless — *something* always attests the lock.
Public roots don't remove that step; they make it **checkable instead of
trusted**. Concretely:

- A verifier never trusts Phase's API. It recomputes every hash itself and
  checks the sequencer's Ed25519 signature against a key it pinned out-of-band.
- What the verifier *does* trust: that the pinned sequencer key is the honest
  one, and that the state roots it sees are the roots everyone else sees
  (no equivocation). §5 (root publication) exists to make equivocation
  detectable.
- One-way exit is therefore trust-minimized: leaving never depends on Phase
  being online, cooperative, or alive. Minting on the destination side trusts
  the destination's own verifier implementation — which is public code you can
  read.

## 1. Locking (Phase side)

Locking is a **normal Phase TRANSFER** — no new transaction type:

- `to`: the chain's deterministic bridge vault address (§2).
- `payload.amount`: integer base units, as a decimal string.
- `payload.memo`: `BRIDGE:<destChain>:<destAddress>` (see §3).

The transfer is sequenced into a block like any other transaction and is
thereafter provable with the standard transaction merkle proof
(see `docs/VERIFYING.md` §7).

## 2. Vault addresses (deterministic, no secrets)

For chain `chainId`:

```
seed    = SHA256( UTF8( "phase-bridge-vault/v1/" + chainId ) )   # 32 bytes
pubkey  = Ed25519 public key for `seed`                         # 32 bytes
address = "ph1" + base58(pubkey)
```

Anyone can recompute any chain's vault address from the chain id. Because the
address is the real address of the derived keypair (same `ph1`+base58(pubkey)
format as every Phase address), signatures made with the vault key verify
under the ledger's normal transfer rules — no consensus changes. The matching
Ed25519 keypair is re-derivable from the same public string (seed used as the
Ed25519 seed via PKCS#8). **This is devnet-only**: on devnet the tokens are
valueless and the re-derivability keeps the system secret-free. **Mainnet MUST
use KMS-held keys** — the bridge refuses to start on mainnet without them
(see `bridge-config.ts`).

## 3. Lock memo format

```
BRIDGE:<destChain>:<destAddress>
```

- `destChain`: 2–20 chars, `[a-z0-9-]` — e.g. `solana`, `base`, `ethereum`.
- `destAddress`: 1–200 chars, `[A-Za-z0-9]` (base58 addresses fit).
- Total memo must fit the ledger's 256-char memo limit; longer memos are
  rejected with `memo_bad_format`.
- Examples:
  - `BRIDGE:solana:9xQeWvG816bUx9EPjHmaT82yvN8X1y2p3q4r5s6t`
  - `BRIDGE:base:0xabc123…` (note: `0x` contains `x`, which is in `[A-Za-z0-9]`)

## 4. The lock-proof certificate

A JSON object. Field names are fixed (camelCase):

```json
{
  "standard": "phase-lock-proof/1",
  "chainId": "ch_6c0929b2-…",
  "lockTxId": "tx_…",
  "locker": "ph1…",
  "amount": "1500",
  "decimals": 6,
  "destination": { "chain": "solana", "address": "9xQe…" },
  "blockHeight": 12,
  "stateRoot": "…64 hex…",
  "tx": { /* full tx wire object, snake_case, as served by the public API */ },
  "txProof": {
    "tx_root": "…64 hex…",
    "proof": ["…64 hex…"],
    "proof_directions": ["right", "left"],
    "leaf_index": 0
  },
  "headerHash": "…64 hex…",
  "sequencerSig": "…128 hex…",
  "sequencerPubkey": "…64 hex, raw 32-byte Ed25519 key…"
}
```

Served by Phase at `GET /api/v1/bridge/locks/:txId`, but a verifier must be
able to assemble it from the public endpoints alone (`/api/v1/public/…`).

## 5. Verification algorithm (normative)

Given a certificate C and a pinned sequencer pubkey P (pinned out-of-band from
`GET /api/v1/public/sequencer`):

1. `C.standard == "phase-lock-proof/1"`, else reject.
2. `C.tx` must satisfy: `tx_id == C.lockTxId`, `chain_id == C.chainId`,
   `type == "TRANSFER"`, `sender == C.locker`.
3. `BigInt(C.tx.payload.amount) == BigInt(C.amount) > 0`.
4. `C.tx.payload.to == vaultAddress(C.chainId)` (recompute per §2).
5. Parse `C.tx.payload.memo` per §3; it must equal `C.destination`.
6. Recompute the tx leaf: `SHA256(UTF8(tx_id) || UTF8(canonical_json(tx_wire)))`
   where `tx_wire` is the snake_case wire object with keys sorted recursively;
   walk `C.txProof` against `C.txProof.tx_root` (§4 of VERIFYING.md logic).
7. `Ed25519_Verify(P, hex_decode(C.headerHash), hex_decode(C.sequencerSig))`.
8. (Verifier-side, needs chain data): `C.blockHeight` exists on-chain and
   `C.stateRoot` equals the block's `state_root`; the state root used is at or
   after the lock's block.

If all pass, the certificate proves: at the pinned sequencer's block H, locker
L locked amount A of chain C's coins into the vault, destined for
`destination`. The reference implementation is `lock-proof-verify.ts` — a
zero-dependency file any third party can copy verbatim.

## 6. Root publication (no single copy)

State roots must be visible in more than one place so a compromised web server
can't rewrite history quietly. The intended combo:

1. **Cheap on-chain anchor** — post just the 32-byte root hash as calldata (or
   an event) on a cheap L1/L2. Small real cost per checkpoint, but the anchor
   can't be denied or back-dated later (same idea OpenTimestamps uses with
   Bitcoin). This is the equivocation detector: if two different roots are
   anchored for the same height, everyone sees the fork.
2. **Arweave / IPFS for the full data** — root + block header + tx list,
   content-addressed; the CID itself is included in the on-chain anchor so even
   the pointer is immutable.
3. **Public git repo** — an append-only, hash-chained log of
   `(height, stateRoot, anchorTxRef)` commits. Free, trivially mirrorable;
   still one host unless others clone it (they should).
4. **One-call mirror API** — `GET /api/v1/public/roots` serves the full
   checkpoint log as JSON so block explorers and other projects can republish
   the same roots independently with a single call.

Phase's own site is the **convenient default, never the only copy**.
`bridge-config.ts` exposes the anchor interface (`anchorStateRoot(chainId,
height, stateRoot)`); the file/log implementation ships now, chain/IPFS/git
implementations are documented TODOs for Phase 2.

## 7. Unlocking (destination → Phase)

Unlocking mirrors locking:

1. On the destination chain, the holder **burns** the wrapped tokens, attaching
   their Phase address (`ph1…`) in the burn's memo field (chain-native memo
   mechanism, e.g. SPL Memo program on Solana — same transaction as the burn).
2. Phase's importer watches for finalized burns, extracts the `ph1` address,
   and submits a TRANSFER from the vault to that address for the same amount.
3. The burn is recorded idempotently (`unlock:<destChain>:<burnTxSig>`); a burn
   is never honored twice.

## 8. Invariants (all importers must hold)

- `locked on Phase == wrapped circulating on all destinations`, per coin,
  checkable at `GET /api/v1/bridge/reserves`.
- 1 wrapped token == 1 coin, same decimals. The bridge never creates value.
- Every cross-chain step is idempotent; replays are rejected, not double-counted.
- Amounts are integers end-to-end. No floats anywhere.

## 9. Versioning

`phase-lock-proof/1` is the first version. Breaking changes require a new
version string and a migration note here. Verifiers must reject unknown
`standard` values rather than guessing.
