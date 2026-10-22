/**
 * lock-proof-verify.ts — standalone verifier for `phase-lock-proof/1` lock
 * certificates and Phase balance/transaction proofs.
 *
 * DESIGN RULE: this file has ZERO imports from the phase-backend repo — only
 * node:crypto. A third party must be able to copy this file verbatim into
 * their own project and verify Phase proofs without trusting Phase's server.
 * The first-party bridge importer uses this exact code path (no shortcuts).
 *
 * Mirrors the algorithms in sovereign-ledger-core.ts:
 *  - base58 (Bitcoin alphabet), no external deps
 *  - canonical JSON (sorted keys) for signing/hashing
 *  - tx leaf:   sha256(utf8(txId), utf8(canonical(txWireObject(tx))))
 *  - state leaf: sha256(utf8("chainId|address|balance|nonce"))
 *  - merkle: binary, duplicate last leaf when odd; proof steps {hash, isRight}
 *  - block header signatures: Ed25519 over the raw 32-byte headerHash
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET[i]] = i;

export function b58encode(buf: Buffer): string {
  if (buf.length === 0) return "";
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let num = 0n;
  for (const byte of buf) num = num * 256n + BigInt(byte);
  let out = "";
  while (num > 0n) {
    const rem = num % 58n;
    num /= 58n;
    out = B58_ALPHABET[Number(rem)] + out;
  }
  return B58_ALPHABET[0].repeat(zeros) + out;
}

export function b58decode(str: string): Buffer {
  if (str.length === 0) return Buffer.alloc(0);
  let zeros = 0;
  while (zeros < str.length && str[zeros] === B58_ALPHABET[0]) zeros++;
  let num = 0n;
  for (const ch of str) {
    const v = B58_MAP[ch];
    if (v === undefined) throw new Error("invalid base58 character: " + ch);
    num = num * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num /= 256n;
  }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes)]);
}

export function sha256(...bufs: Buffer[]): Buffer {
  const h = crypto.createHash("sha256");
  for (const b of bufs) h.update(b);
  return h.digest();
}

export function canonicalize(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") +
    "}"
  );
}

// ---------------------------------------------------------------------------
// leaves & merkle proofs
// ---------------------------------------------------------------------------

export interface ProofStep {
  hash: string; // hex
  isRight: boolean;
}

/** Wire shape of a transaction (snake_case), as served by the public API. */
export function txWireObject(tx: any): Record<string, unknown> {
  return {
    chain_id: tx.chainId ?? tx.chain_id,
    tx_id: tx.txId ?? tx.tx_id,
    type: tx.type,
    sender: tx.sender,
    nonce: tx.nonce,
    payload: tx.payload,
    signatures: tx.signatures,
    submitted_at: tx.submittedAt ?? tx.submitted_at,
  };
}

export function txMerkleLeaf(tx: any): Buffer {
  const wire = txWireObject(tx);
  const txId = String((wire as any).tx_id);
  return sha256(Buffer.from(txId, "utf8"), Buffer.from(canonicalize(wire), "utf8"));
}

export function stateLeaf(
  chainId: string,
  address: string,
  balance: bigint | string,
  nonce: number
): Buffer {
  return sha256(
    Buffer.from(`${chainId}|${address}|${balance.toString()}|${nonce}`, "utf8")
  );
}

export function verifyMerkleProof(
  leaf: Buffer,
  proof: ProofStep[],
  rootHex: string
): boolean {
  let computed = leaf;
  for (const step of proof) {
    if (typeof step.hash !== "string" || typeof step.isRight !== "boolean")
      return false;
    const sib = Buffer.from(step.hash, "hex");
    if (sib.length !== 32) return false;
    computed = step.isRight
      ? sha256(computed, sib)
      : sha256(sib, computed);
  }
  return computed.equals(Buffer.from(rootHex, "hex"));
}

// ---------------------------------------------------------------------------
// Ed25519 helpers
// ---------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function publicKeyFromRaw(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function verifyEd25519(
  message: Buffer,
  signatureHex: string,
  pubkeyRawHex: string
): boolean {
  try {
    const sig = Buffer.from(signatureHex, "hex");
    const raw = Buffer.from(pubkeyRawHex, "hex");
    if (sig.length !== 64 || raw.length !== 32) return false;
    return crypto.verify(null, message, publicKeyFromRaw(raw), sig);
  } catch {
    return false;
  }
}

export function isValidPhaseAddress(addr: unknown): boolean {
  if (typeof addr !== "string" || !addr.startsWith("ph1")) return false;
  try {
    return b58decode(addr.slice(3)).length === 32;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bridge vault derivation
// ---------------------------------------------------------------------------

const VAULT_DOMAIN = "phase-bridge-vault/v1/";

/**
 * Deterministic vault address for a chain:
 *   seed    = sha256("phase-bridge-vault/v1/" + chainId)
 *   pubkey  = Ed25519 public key for `seed`
 *   address = "ph1" + base58(pubkey)
 * Reproducible by anyone from the chain id alone. The address is the REAL
 * address of the derived keypair (same 'ph1'+base58(pubkey) format as every
 * Phase address), so signatures made with the vault key verify under the
 * ledger's normal transfer rules.
 *
 * DEVNET NOTE: the matching private key is re-derivable from the same public
 * string (see vaultKeypairFromChainId). That is acceptable ONLY for devnet /
 * valueless testing. Mainnet MUST use KMS-held keys; bridge-config.ts refuses
 * to start otherwise.
 */
export function deriveVaultAddress(chainId: string): string {
  return vaultKeypairFromChainId(chainId).address;
}

const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function rawPubkeyOf(publicKey: crypto.KeyObject): Buffer {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(der.length - 32);
}

/**
 * Re-derive the vault Ed25519 keypair from the public derivation string.
 * DEVNET ONLY — see deriveVaultAddress note. Mainnet uses KMS.
 */
export function vaultKeypairFromChainId(chainId: string): {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  address: string;
} {
  const seed = sha256(Buffer.from(VAULT_DOMAIN + chainId, "utf8"));
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = crypto.createPublicKey(privateKey);
  const address = "ph1" + b58encode(rawPubkeyOf(publicKey));
  return { privateKey, publicKey, address };
}

/** Raw 32-byte vault public key as hex (for the {pubkey, signature} shape). */
export function vaultRawPubkeyHex(chainId: string): string {
  return rawPubkeyOf(vaultKeypairFromChainId(chainId).publicKey).toString("hex");
}

/**
 * Sign a message with the vault keypair re-derived from the chain id.
 * DEVNET-ONLY scaffolding: deterministic re-derivation exists so the devnet
 * importer can unlock without stored secrets. Mainnet MUST use KMS-held keys
 * (bridge-config.ts refuses anything else) — this function must not be wired
 * to mainnet.
 */
export function signWithVaultKey(chainId: string, message: Buffer): Buffer {
  const { privateKey } = vaultKeypairFromChainId(chainId);
  return crypto.sign(null, message, privateKey);
}

// ---------------------------------------------------------------------------
// Lock memo format: BRIDGE:<destChain>:<destAddress>
// ---------------------------------------------------------------------------

export interface ParsedLockMemo {
  destinationChain: string;
  destinationAddress: string;
}

const MEMO_RE = /^BRIDGE:([a-z0-9-]{2,20}):([A-Za-z0-9]{1,200})$/;

export function parseLockMemo(
  memo: unknown
): { ok: true; value: ParsedLockMemo } | { ok: false; error: string } {
  if (typeof memo !== "string")
    return { ok: false, error: "memo_missing_or_not_string" };
  if (memo.length > 256) return { ok: false, error: "memo_too_long" };
  const m = MEMO_RE.exec(memo);
  if (!m) return { ok: false, error: "memo_bad_format" };
  return {
    ok: true,
    value: { destinationChain: m[1], destinationAddress: m[2] },
  };
}

// ---------------------------------------------------------------------------
// Lock-proof certificate verification (phase-lock-proof/1)
// ---------------------------------------------------------------------------

export interface LockProofCertificate {
  standard: string;
  chainId: string;
  lockTxId: string;
  locker: string;
  amount: string; // integer, base units
  decimals: number;
  destination: { chain: string; address: string };
  blockHeight: number;
  stateRoot: string;
  tx: Record<string, unknown>; // full tx wire object (snake_case or camelCase)
  txProof: {
    tx_root: string;
    proof: ProofStep[];
    proof_directions?: string[];
    leaf_index: number;
  };
  headerHash: string;
  sequencerSig: string;
  sequencerPubkey: string; // hex, raw 32 bytes
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

function fail(reason: string): VerifyResult {
  return { ok: false, reason };
}

/**
 * Verify a lock-proof certificate using ONLY the certificate contents plus the
 * pinned sequencer key. No network, no repo imports, no trust in Phase's API
 * beyond the pinned key (which the verifier pins out-of-band from
 * GET /api/v1/public/sequencer).
 */
export function verifyLockCertificate(cert: any): VerifyResult {
  if (!cert || typeof cert !== "object") return fail("cert_not_object");
  if (cert.standard !== "phase-lock-proof/1")
    return fail("unsupported_standard");

  for (const f of [
    "chainId",
    "lockTxId",
    "locker",
    "amount",
    "destination",
    "blockHeight",
    "stateRoot",
    "tx",
    "txProof",
    "headerHash",
    "sequencerSig",
    "sequencerPubkey",
  ]) {
    if (cert[f] === undefined || cert[f] === null) return fail(`missing_${f}`);
  }

  if (!isValidPhaseAddress(cert.locker)) return fail("bad_locker_address");

  let amount: bigint;
  try {
    amount = BigInt(cert.amount);
  } catch {
    return fail("bad_amount");
  }
  if (amount <= 0n) return fail("nonpositive_amount");

  if (
    !Number.isInteger(cert.blockHeight) ||
    cert.blockHeight < 0 ||
    !/^[0-9a-f]{64}$/i.test(cert.headerHash) ||
    !/^[0-9a-f]{64}$/i.test(cert.stateRoot) ||
    !/^[0-9a-f]{64}$/i.test(cert.txProof?.tx_root || "")
  )
    return fail("bad_header_fields");

  // 1. The embedded tx must agree with the certificate's claims.
  const tx: any = cert.tx;
  const txId = tx.txId ?? tx.tx_id;
  const txChainId = tx.chainId ?? tx.chain_id;
  const txType = tx.type;
  const txSender = tx.sender;
  if (txId !== cert.lockTxId) return fail("txid_mismatch");
  if (txChainId !== cert.chainId) return fail("chain_mismatch");
  if (txType !== "TRANSFER") return fail("not_a_transfer");
  if (txSender !== cert.locker) return fail("locker_mismatch");

  let txAmount: bigint;
  try {
    txAmount = BigInt(tx.payload?.amount);
  } catch {
    return fail("bad_tx_amount");
  }
  if (txAmount !== amount) return fail("amount_mismatch");

  // 2. The tx must pay the deterministic vault address with a valid memo.
  const vault = deriveVaultAddress(cert.chainId);
  if (tx.payload?.to !== vault) return fail("not_to_vault");
  const memo = parseLockMemo(tx.payload?.memo);
  if (memo.ok === false) return fail(`bad_memo:${memo.error}`);
  if (
    memo.value.destinationChain !== cert.destination?.chain ||
    memo.value.destinationAddress !== cert.destination?.address
  )
    return fail("destination_mismatch");

  // 3. The tx merkle proof must verify against the certificate's txRoot.
  let leaf: Buffer;
  try {
    leaf = txMerkleLeaf(tx);
  } catch {
    return fail("leaf_recompute_failed");
  }
  if (
    !verifyMerkleProof(leaf, cert.txProof.proof, cert.txProof.tx_root)
  )
    return fail("tx_proof_invalid");

  // 4. The sequencer signature must verify over the headerHash.
  if (
    !verifyEd25519(
      Buffer.from(cert.headerHash, "hex"),
      cert.sequencerSig,
      cert.sequencerPubkey
    )
  )
    return fail("sequencer_sig_invalid");

  return { ok: true };
}

/**
 * Verify a public balance proof (shape served by
 * GET /api/v1/public/chains/:id/proofs/balance/:address).
 */
export function verifyBalanceProof(args: {
  chainId: string;
  address: string;
  balance: string;
  nonce: number;
  state_root: string;
  proof: ProofStep[];
  headerHash: string;
  sequencerSig: string;
  sequencerPubkey: string; // hex raw 32 bytes
}): VerifyResult {
  const a = args;
  if (!isValidPhaseAddress(a.address)) return fail("bad_address");
  let bal: bigint;
  try {
    bal = BigInt(a.balance);
  } catch {
    return fail("bad_balance");
  }
  if (!Number.isInteger(a.nonce) || a.nonce < 0) return fail("bad_nonce");
  const leaf = stateLeaf(a.chainId, a.address, bal, a.nonce);
  if (!verifyMerkleProof(leaf, a.proof, a.state_root))
    return fail("balance_proof_invalid");
  if (
    !verifyEd25519(
      Buffer.from(a.headerHash, "hex"),
      a.sequencerSig,
      a.sequencerPubkey
    )
  )
    return fail("sequencer_sig_invalid");
  return { ok: true };
}
