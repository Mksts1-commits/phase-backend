/**
 * link-check.ts — liveness verification for issuer-supplied URLs.
 *
 * URL-fed Legitimacy Score items (reference URL, social profiles, coin
 * logo) are earned only by links that actually work: a dead link earns
 * nothing. This module is the single checker every write/score path
 * uses, and it is deliberately conservative about calling a link dead.
 *
 * VERDICT POLICY — a URL is "broken" only on strong evidence:
 *   - the final HTTP status (after redirects) is 404 or 410, or
 *   - the host cannot be reached at all (DNS failure / connection
 *     refused — the address itself does not resolve to a live server).
 * Everything else is "ok" (working):
 *   - 2xx and 3xx finals;
 *   - 401 / 403 / 429 — bot walls and login gates. TikTok, Instagram
 *     and X routinely refuse bots; the page exists, so the issuer keeps
 *     their points;
 *   - 5xx — the server is up; a bad day on their host is not a dead
 *     link;
 *   - timeouts and any other inconclusive outcome — transient failures
 *     never punish the issuer.
 *
 * Verdicts are computed once and persisted on the coin/draft record
 * (link_status, migration 025) with a timestamp; readers never
 * re-check a URL that already has a verdict.
 *
 * The fetcher is injectable (setLinkFetcher) so tests stay hermetic.
 * Test-mode throughout, like the rest of the backend.
 */

export type LinkVerdict = "ok" | "broken";

export interface LinkVerdictEntry {
  verdict: LinkVerdict;
  checkedAt: string; // ISO timestamp of the check
}

/** URL -> verdict entry, as stored on draft/coin records. */
export type LinkStatusMap = Record<string, LinkVerdictEntry>;

/** Returns the FINAL HTTP status for a URL (redirects followed), or
 *  throws on a network-level failure (DNS, connect, timeout...). */
export type LinkFetcher = (url: string) => Promise<number>;

const CHECK_TIMEOUT_MS = 4000;

// --- verdict policy (pure) ---------------------------------------------------

export function verdictForStatus(status: number): LinkVerdict {
  return status === 404 || status === 410 ? "broken" : "ok";
}

export function verdictForError(err: unknown): LinkVerdict {
  const e = err as { name?: string; code?: string; cause?: { code?: string } } | null;
  // A timeout is inconclusive — the link may be fine on a faster day.
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || e?.code === "ETIMEDOUT") {
    return "ok";
  }
  // DNS / connect failures are strong evidence the link is dead.
  const code = e?.cause?.code ?? e?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED") {
    return "broken";
  }
  // Anything else (TLS, redirect loops, odd stacks) is inconclusive.
  return "ok";
}

// --- default fetcher -----------------------------------------------------------

const defaultFetcher: LinkFetcher = async (url) => {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow", // platform fetch follows up to 20; policy counts the final status
    headers: { "user-agent": "PhaseLinkCheck/1.0 (+https://phase.example)" },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  // Drain the body so the socket can be reused/closed cleanly.
  try { await res.text(); } catch { /* status is all we need */ }
  return res.status;
};

let activeFetcher: LinkFetcher = defaultFetcher;

/** Swap the fetcher (tests inject a stub so nothing leaves the box). */
export function setLinkFetcher(f: LinkFetcher | null): void {
  activeFetcher = f ?? defaultFetcher;
}

// --- checking ------------------------------------------------------------------

function isCheckableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}

/** Check one URL. Never throws: every outcome maps to a verdict. */
export async function checkLink(url: string): Promise<LinkVerdictEntry> {
  const checkedAt = new Date().toISOString();
  if (!isCheckableUrl(url)) return { verdict: "ok", checkedAt };
  try {
    const status = await activeFetcher(url);
    return { verdict: verdictForStatus(status), checkedAt };
  } catch (err) {
    return { verdict: verdictForError(err), checkedAt };
  }
}

/** Check every URL that doesn't already have a verdict; returns the
 *  merged map (existing entries are preserved untouched — a stored
 *  verdict is never re-checked). Duplicate/blank URLs are ignored. */
export async function ensureLinkVerdicts(
  urls: Array<string | null | undefined>,
  existing: LinkStatusMap | null | undefined
): Promise<LinkStatusMap> {
  const out: LinkStatusMap = { ...(existing ?? {}) };
  const wanted = [...new Set(urls.filter((u): u is string => !!u && u.trim().length > 0))];
  const missing = wanted.filter((u) => !(u in out));
  if (missing.length > 0) {
    const entries = await Promise.all(missing.map(async (u) => [u, await checkLink(u)] as const));
    for (const [u, entry] of entries) out[u] = entry;
  }
  return out;
}

/** Normalize a stored link_status value (JSONB object, JSON string, or
 *  nothing) into a LinkStatusMap. */
export function normalizeLinkStatus(raw: unknown): LinkStatusMap {
  if (!raw) return {};
  let v: unknown = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch { return {}; }
  }
  if (typeof v !== "object" || Array.isArray(v)) return {};
  const out: LinkStatusMap = {};
  for (const [url, entry] of Object.entries(v as Record<string, unknown>)) {
    const e = entry as { verdict?: unknown; checkedAt?: unknown } | null;
    if (e && (e.verdict === "ok" || e.verdict === "broken")) {
      out[url] = {
        verdict: e.verdict,
        checkedAt: typeof e.checkedAt === "string" ? e.checkedAt : "",
      };
    }
  }
  return out;
}
