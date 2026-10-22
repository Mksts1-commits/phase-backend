/**
 * bridge-public.ts — public, unauthenticated read routes for chain
 * verifiability (Phase 0 of the bridge infrastructure).
 *
 * These endpoints let ANYONE verify Phase chain data without an account:
 * chain list, block headers, full blocks, balance proofs, transaction proofs,
 * and the sequencer key announcement.
 *
 * Read-only: no writes to the ledger. Rate-limited per client IP.
 * Existing authed ledger routes (requireSession) are untouched.
 *
 * Mounted from phase-backend.ts:
 *   mountBridgePublicRoutes({ route, sendJson, HttpError });
 */
import {
  store,
  buildMerkleTree,
  getMerkleProof,
  stateLeaf,
  txMerkleLeaf,
  getSequencerPublicKeyRaw,
  getSequencerAnnouncement,
  b58encode,
  LedgerError,
} from "./sovereign-ledger-core.js";
import { checkRateLimit, clientIpFromHeaders } from "./rate-limit.js";

interface Ctx {
  req: any;
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

interface Deps {
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
  sendJson: (res: any, statusCode: number, body: unknown) => void;
  HttpError: any;
}

const PREFIX = "/api/v1/public";
const RATE_MAX = 120; // requests
const RATE_WINDOW_MS = 60_000; // per minute, per IP

export function mountBridgePublicRoutes(deps: Deps): void {
  const { route, sendJson, HttpError } = deps;

  const limited = (ctx: Ctx): void => {
    const headers = (ctx.req?.headers ?? {}) as Record<string, string | string[] | undefined>;
    const ip = clientIpFromHeaders(headers);
    if (!checkRateLimit(`bridge-public:${ip}`, RATE_MAX, RATE_WINDOW_MS)) {
      throw new HttpError(429, "rate_limited", "Too many requests — slow down.");
    }
  };

  const fail = (ctx: Ctx, err: unknown): void => {
    if (err instanceof LedgerError) {
      sendJson(ctx.res, err.status, { error: err.code, message: err.message });
      return;
    }
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    sendJson(ctx.res, statusCode, {
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    });
  };

  const getChain = (ctx: Ctx) => {
    const chain = store.chains.get(ctx.params.id);
    if (!chain) throw new HttpError(404, "chain_not_found", "Unknown chain.");
    return chain;
  };

  const getBlock = (ctx: Ctx, height?: number) => {
    const chain = getChain(ctx);
    const blocks = store.blocksByChain.get(chain.chainId) || [];
    const block =
      height === undefined ? blocks[blocks.length - 1] : blocks[height];
    if (!block) throw new HttpError(404, "block_not_found", "No such block.");
    return block as any;
  };

  // GET /api/v1/public/chains
  route("GET", `${PREFIX}/chains`, async (ctx: Ctx) => {
    try {
      limited(ctx);
      const chains = Array.from(store.chains.values()).map((c: any) => ({
        chainId: c.chainId,
        ticker: c.ticker,
        coinName: c.coinName,
        status: c.status,
        currentSupply: c.currentSupply.toString(),
        decimals: c.decimals,
        genesisHash: c.genesisHash,
      }));
      sendJson(ctx.res, 200, { chains });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/public/chains/:id/blocks/latest — header only
  route("GET", `${PREFIX}/chains/:id/blocks/latest`, async (ctx: Ctx) => {
    try {
      limited(ctx);
      const b = getBlock(ctx);
      sendJson(ctx.res, 200, {
        chain_id: b.chainId,
        height: b.height,
        prev_hash: b.prevHash,
        timestamp_ms: b.timestampMs,
        tx_root: b.txRoot,
        state_root: b.stateRoot,
        tx_count: b.txCount,
        header_hash: b.headerHash,
        sequencer_sig: b.sequencerSig,
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/public/chains/:id/blocks/:height — full block
  route("GET", `${PREFIX}/chains/:id/blocks/:height`, async (ctx: Ctx) => {
    try {
      limited(ctx);
      const height = Number(ctx.params.height);
      if (!Number.isInteger(height) || height < 0) {
        throw new HttpError(400, "bad_height", "height must be a non-negative integer.");
      }
      const b = getBlock(ctx, height);
      sendJson(ctx.res, 200, {
        chain_id: b.chainId,
        height: b.height,
        prev_hash: b.prevHash,
        timestamp_ms: b.timestampMs,
        tx_root: b.txRoot,
        state_root: b.stateRoot,
        tx_count: b.txCount,
        header_hash: b.headerHash,
        sequencer_sig: b.sequencerSig,
        transactions: b.transactions,
        state_snapshot: b.stateSnapshot,
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/public/chains/:id/proofs/balance/:address?height=N
  route("GET", `${PREFIX}/chains/:id/proofs/balance/:address`, async (ctx: Ctx) => {
    try {
      limited(ctx);
      const chain = getChain(ctx);
      const address = ctx.params.address;
      const heightParam = ctx.query.get("height");
      const blocks = store.blocksByChain.get(chain.chainId) || [];
      const block: any =
        heightParam !== null ? blocks[Number(heightParam)] : blocks[blocks.length - 1];
      if (!block) throw new HttpError(404, "block_not_found", "No such block.");
      const leafIndex = block.stateSnapshot.findIndex((e: any) => e.address === address);
      if (leafIndex === -1) {
        throw new HttpError(404, "address_not_in_state",
          "Address has zero balance at this height (zero-balance entries are not in the state tree).");
      }
      const leaves = block.stateSnapshot.map((e: any) =>
        stateLeaf(chain.chainId, e.address, BigInt(e.balance), e.nonce)
      );
      const { levels } = buildMerkleTree(leaves);
      const proof = getMerkleProof(levels, leafIndex);
      const entry = block.stateSnapshot[leafIndex];
      sendJson(ctx.res, 200, {
        address,
        balance: entry.balance,
        nonce: entry.nonce,
        height: block.height,
        state_root: block.stateRoot,
        proof: proof.map((p: any) => p.hash),
        proof_directions: proof.map((p: any) => (p.isRight ? "right" : "left")),
        leaf_index: leafIndex,
        header_hash: block.headerHash,
        sequencer_sig: block.sequencerSig,
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/public/chains/:id/proofs/transaction/:txId
  route("GET", `${PREFIX}/chains/:id/proofs/transaction/:txId`, async (ctx: Ctx) => {
    try {
      limited(ctx);
      const chain = getChain(ctx);
      const tx: any = store.txById.get(ctx.params.txId);
      if (!tx || tx.chainId !== chain.chainId || tx.blockHeight === undefined) {
        throw new HttpError(404, "transaction_not_found_or_unconfirmed",
          "Unknown transaction or not yet confirmed in a block.");
      }
      const blocks = store.blocksByChain.get(chain.chainId) || [];
      const block: any = blocks[tx.blockHeight];
      if (!block) throw new HttpError(404, "block_not_found", "No such block.");
      const leaves = block.transactions.map(txMerkleLeaf);
      const { levels } = buildMerkleTree(leaves);
      const proof = getMerkleProof(levels, tx.txIndex);
      sendJson(ctx.res, 200, {
        tx_id: tx.txId,
        block_height: tx.blockHeight,
        tx_root: block.txRoot,
        proof: proof.map((p: any) => p.hash),
        proof_directions: proof.map((p: any) => (p.isRight ? "right" : "left")),
        leaf_index: tx.txIndex,
        header_hash: block.headerHash,
        sequencer_sig: block.sequencerSig,
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/public/sequencer — pinned key + signed announcement
  route("GET", `${PREFIX}/sequencer`, async (ctx: Ctx) => {
    try {
      limited(ctx);
      const raw = getSequencerPublicKeyRaw();
      const announcement = getSequencerAnnouncement();
      sendJson(ctx.res, 200, {
        pubkey_hex: raw.toString("hex"),
        pubkey_base58: b58encode(raw),
        announcement: {
          message: announcement.message,
          signature_hex: announcement.signatureHex,
        },
        note: "Pin pubkey_hex out-of-band. Verify the announcement signature over the message before trusting it.",
      });
    } catch (err) {
      fail(ctx, err);
    }
  });
}
