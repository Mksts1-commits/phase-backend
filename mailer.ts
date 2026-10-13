/**
 * Phase transactional mailer — SendGrid HTTP API.
 *
 * Configuration (environment):
 *   SENDGRID_API_KEY  SendGrid API key with "Mail Send" permission
 *   SENDGRID_FROM     From header, e.g. "Phase <Mikyasts1@gmail.com>".
 *                     The address must be verified as a Single Sender
 *                     (or domain-authenticated) in the SendGrid dashboard.
 *
 * Why HTTP instead of SMTP: Render's free-tier egress cannot reach
 * Gmail/Outlook SMTP hosts (connection timeouts on 587 and 465), and
 * Hotmail accepted-then-silently-dropped mail. The SendGrid v3 API
 * goes over HTTPS (port 443), which works fine.
 *
 * When SENDGRID_API_KEY is not set, sendMail() is a graceful no-op
 * (logs a warning, resolves false) so local dev and deploys without
 * mail config keep working.
 */

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const SENDGRID_API = "https://api.sendgrid.com/v3/mail/send";

function mailConfig() {
  const apiKey = (process.env.SENDGRID_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const from = (process.env.SENDGRID_FROM ?? "").trim() || "Phase <Mikyasts1@gmail.com>";
  return { apiKey, from };
}

export function isMailConfigured(): boolean {
  return mailConfig() !== null;
}

/** Split "Name <addr@example.com>" into { name, email } for the API. */
function parseFrom(from: string): { name?: string; email: string } {
  const m = from.match(/^(.*)<([^<>]+)>$/);
  if (m) {
    const name = m[1].trim().replace(/^["']|["']$/g, "");
    return { name: name || undefined, email: m[2].trim() };
  }
  return { email: from.trim() };
}

/**
 * Send one transactional email. Resolves true when SendGrid accepts it
 * (HTTP 202), false when mail is not configured. Rejects on API errors —
 * callers that must not fail the request should catch. Never logs the
 * API key.
 */
export async function sendMail(opts: MailOptions): Promise<boolean> {
  const cfg = mailConfig();
  if (!cfg) {
    console.warn("[mailer] SENDGRID_API_KEY not set — email not sent", { to: opts.to, subject: opts.subject });
    return false;
  }
  const from = parseFrom(cfg.from);
  const body = {
    personalizations: [{ to: [{ email: opts.to }], subject: opts.subject }],
    from,
    content: [
      { type: "text/plain", value: opts.text },
      { type: "text/html", value: opts.html ?? opts.text },
    ],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(SENDGRID_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.status === 202) return true;
    let detail = "";
    try {
      const errJson = (await res.json()) as { errors?: Array<{ message?: string; field?: string }> };
      detail = (errJson.errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`SendGrid rejected the send (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  } finally {
    clearTimeout(timer);
  }
}

const PHASE_GREEN = "#00c853";

export function passwordResetEmail(to: string, token: string): MailOptions {
  const subject = "Reset your Phase password";
  const text =
    `Hi there,\n\n` +
    `We received a password reset request for your Phase account (${to}).\n\n` +
    `Your reset code (valid for 1 hour):\n\n    ${token}\n\n` +
    `In the Phase app: go to the login screen, tap "Forgot password", ` +
    `paste the code, and choose a new password.\n\n` +
    `If you didn't ask for this, you can safely ignore this email — ` +
    `your password stays exactly as it is.\n\n` +
    `— The Phase team`;
  const html =
    `<div style="font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #1a1a1a;">` +
    `<div style="font-size: 22px; font-weight: 700; margin-bottom: 4px;">Phase</div>` +
    `<div style="height: 3px; width: 56px; background: ${PHASE_GREEN}; border-radius: 2px; margin: 8px 0 20px;"></div>` +
    `<p>We received a password reset request for your Phase account (<strong>${escapeHtml(to)}</strong>).</p>` +
    `<p>Your reset code (valid for <strong>1 hour</strong>):</p>` +
    `<div style="font-family: ui-monospace, monospace; font-size: 15px; background: #f2f7f3; border: 1px solid #d7e8db; border-radius: 8px; padding: 14px 16px; word-break: break-all; margin: 12px 0;">${escapeHtml(token)}</div>` +
    `<p>In the Phase app: go to the login screen, tap <strong>Forgot password</strong>, paste the code, and choose a new password.</p>` +
    `<p style="color: #666; font-size: 13px;">If you didn't ask for this, you can safely ignore this email — your password stays exactly as it is.</p>` +
    `<p style="color: #999; font-size: 12px; margin-top: 24px;">— The Phase team</p>` +
    `</div>`;
  return { to, subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
