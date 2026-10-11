/**
 * Phase transactional mailer — SMTP via nodemailer.
 *
 * Configuration (environment):
 *   SMTP_HOST   e.g. smtp.gmail.com
 *   SMTP_PORT   default 587 (STARTTLS); use 465 with SMTP_SECURE=true
 *   SMTP_SECURE "true" to use implicit TLS (port 465), otherwise STARTTLS
 *   SMTP_USER   SMTP username (for Gmail: the full address)
 *   SMTP_PASS   SMTP password (for Gmail: an App Password, not the login)
 *   SMTP_FROM   From header, defaults to SMTP_USER (e.g. "Phase <you@gmail.com>")
 *
 * When SMTP_HOST/SMTP_USER/SMTP_PASS are not all set, sendMail() is a
 * graceful no-op (logs a warning, resolves false) so local dev and
 * deploys without mail config keep working.
 */
import nodemailer from "nodemailer";

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

function mailConfig() {
  const host = (process.env.SMTP_HOST ?? "").trim();
  const user = (process.env.SMTP_USER ?? "").trim();
  const pass = process.env.SMTP_PASS ?? "";
  if (!host || !user || !pass) return null;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const secure = (process.env.SMTP_SECURE ?? "").toLowerCase() === "true";
  const from = (process.env.SMTP_FROM ?? "").trim() || user;
  return { host, port, secure, user, pass, from };
}

export function isMailConfigured(): boolean {
  return mailConfig() !== null;
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  const cfg = mailConfig();
  if (!cfg) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });
  }
  return transporter;
}

/**
 * Send one transactional email. Resolves true when handed to SMTP,
 * false when mail is not configured. Rejects on SMTP errors — callers
 * that must not fail the request should catch.
 */
export async function sendMail(opts: MailOptions): Promise<boolean> {
  const cfg = mailConfig();
  const tx = getTransporter();
  if (!cfg || !tx) {
    console.warn("[mailer] SMTP not configured — email not sent", { to: opts.to, subject: opts.subject });
    return false;
  }
  await tx.sendMail({ from: cfg.from, to: opts.to, subject: opts.subject, text: opts.text, html: opts.html ?? opts.text });
  return true;
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
