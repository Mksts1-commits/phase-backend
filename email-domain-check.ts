/**
 * email-domain-check.ts — deliverability check for an issuer's email
 * domain, used by the Legitimacy Score's red flags (legitimacy.ts).
 *
 * Phase accounts are not email-verified, so the v1 signal is whether
 * the address's domain can receive mail AT ALL: it must publish MX
 * records, or at least resolve to a host (A/AAAA — the implicit-MX
 * fallback of RFC 5321 §5.1). A domain with neither is a strong sign
 * the issuer's email is fabricated.
 *
 * VERDICT POLICY — deliberately conservative, mirroring link-check.ts:
 *   - "ok":   MX records exist, or an A/AAAA record exists.
 *   - "bad":  a DEFINITIVE answer that neither exists (ENODATA /
 *             ENOTFOUND on every lookup) — the only outcome that
 *             raises the red flag.
 *   - "unknown": anything inconclusive (timeouts, SERVFAIL, resolver
 *             errors, an unparseable address). Unknown NEVER flags:
 *             a DNS hiccup must not cap a real issuer's coin.
 *
 * The verdict is computed once, lazily, on the first scored read and
 * persisted on the user record (email_domain_status, migration 026);
 * later reads never re-resolve. The resolver is injectable
 * (setEmailDomainResolver) so tests stay deterministic and hermetic.
 *
 * Test-mode throughout, like the rest of the backend.
 */
import { resolve4, resolve6, resolveMx } from "node:dns/promises";

export type EmailDomainStatus = "ok" | "bad" | "unknown";

export interface EmailDomainVerdict {
  status: EmailDomainStatus;
  checkedAt: string; // ISO timestamp of the check
}

/** Structured result of one domain lookup. `definitive` is false when
 *  any part of the lookup was inconclusive (timeout / SERVFAIL / …),
 *  in which case mx/a carry no meaning. */
export interface EmailDomainLookup {
  mx: boolean;
  a: boolean;
  definitive: boolean;
}

export type EmailDomainResolver = (domain: string) => Promise<EmailDomainLookup>;

// --- verdict policy (pure) ---------------------------------------------------

export function verdictForDnsLookup(lookup: EmailDomainLookup): EmailDomainStatus {
  if (!lookup.definitive) return "unknown";
  return lookup.mx || lookup.a ? "ok" : "bad";
}

/** The domain part of an email address, lowercased — or null when the
 *  address has no plausible domain to judge (no "@", no dot, stray
 *  characters). Unjudgeable addresses are "unknown", never "bad". */
export function emailDomainOf(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null;
  return domain;
}

// --- default resolver (node:dns) ----------------------------------------------

function dnsErrorCode(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? "";
}

/** "yes" = records exist, "no" = definitively none (ENODATA/ENOTFOUND),
 *  "unknown" = the lookup itself failed inconclusively. */
async function lookupHasRecords(
  fn: () => Promise<unknown[]>
): Promise<"yes" | "no" | "unknown"> {
  try {
    const records = await fn();
    return records.length > 0 ? "yes" : "no";
  } catch (err) {
    const code = dnsErrorCode(err);
    if (code === "ENODATA" || code === "ENOTFOUND") return "no";
    return "unknown";
  }
}

const defaultResolver: EmailDomainResolver = async (domain) => {
  const mx = await lookupHasRecords(() => resolveMx(domain));
  if (mx === "yes") return { mx: true, a: false, definitive: true };
  if (mx === "unknown") return { mx: false, a: false, definitive: false };
  // No MX: mail falls back to the host record (implicit MX).
  const a4 = await lookupHasRecords(() => resolve4(domain));
  if (a4 === "yes") return { mx: false, a: true, definitive: true };
  const a6 = await lookupHasRecords(() => resolve6(domain));
  if (a6 === "yes") return { mx: false, a: true, definitive: true };
  if (a4 === "unknown" || a6 === "unknown") return { mx: false, a: false, definitive: false };
  return { mx: false, a: false, definitive: true };
};

let activeResolver: EmailDomainResolver = defaultResolver;

/** Swap the resolver (tests inject a stub so nothing leaves the box). */
export function setEmailDomainResolver(r: EmailDomainResolver | null): void {
  activeResolver = r ?? defaultResolver;
}

// --- checking ------------------------------------------------------------------

/** Check one email address's domain. Never throws: every outcome maps
 *  to a verdict, and only a definitive no-MX/no-A answer is "bad". */
export async function checkEmailDomain(email: string | null | undefined): Promise<EmailDomainVerdict> {
  const checkedAt = new Date().toISOString();
  const domain = emailDomainOf(email);
  if (!domain) return { status: "unknown", checkedAt };
  try {
    const lookup = await activeResolver(domain);
    return { status: verdictForDnsLookup(lookup), checkedAt };
  } catch {
    return { status: "unknown", checkedAt };
  }
}

/** Return the stored verdict when one exists (a stored verdict is
 *  never re-checked); otherwise check now. The caller persists the
 *  result — this module stays storage-free, like link-check.ts. */
export async function ensureEmailDomainVerdict(
  email: string | null | undefined,
  existing: EmailDomainVerdict | null | undefined
): Promise<EmailDomainVerdict> {
  if (existing && (existing.status === "ok" || existing.status === "bad" || existing.status === "unknown")) {
    return existing;
  }
  return checkEmailDomain(email);
}
