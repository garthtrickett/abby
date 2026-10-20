import { createHash } from "node:crypto";
import { normalizeEmailAddress } from "../shared/email-address.ts";
import { SmtpTextMailTransport } from "./smtp-text-mail-transport.ts";
import type { SmtpMailConfig, SmtpMailSubmission } from "./smtp-text-mail-transport.ts";

export type FinancialMessageSelection = Readonly<{ sender: string; template: "clinicFinancial.v1"; timeZone: string }>;
export type FinancialMail = Readonly<{ email: string; amount: number; currency: string; url: string }> & (
  Readonly<{ purpose: "linkDelivery"; deadline: string }> | Readonly<{ purpose: "receiptDelivery" }>
);
/** Trusted transport only. Permission, native possible-send evidence, permanent
 * exclusion and producer/restore admission belong to the independent owner. */
export interface FinancialMessageDelivery {
  selection(): FinancialMessageSelection;
  send(message: FinancialMail, signal: AbortSignal, submissionRef: string): Promise<SmtpMailSubmission>;
}
export function validFinancialMessageSelection(s: FinancialMessageSelection): boolean {
  try {
    return !!s && Object.keys(s).sort().join(",") === "sender,template,timeZone" && typeof s.sender === "string" &&
      normalizeEmailAddress(s.sender) === s.sender && s.template === "clinicFinancial.v1" && typeof s.timeZone === "string" &&
      s.timeZone.length > 0 && s.timeZone.length <= 100 && !!new Intl.DateTimeFormat("en-GB", { timeZone: s.timeZone }).format(0);
  } catch { return false; }
}
function render(s: FinancialMessageSelection, m: FinancialMail): Readonly<{ subject: string; text: string }> | undefined {
  try {
    if (!validFinancialMessageSelection(s) || !m || typeof m !== "object" || Array.isArray(m) ||
        Object.keys(m).sort().join(",") !== (m.purpose === "linkDelivery" ? "amount,currency,deadline,email,purpose,url" : "amount,currency,email,purpose,url") ||
        !["linkDelivery", "receiptDelivery"].includes(m.purpose) || typeof m.email !== "string" || normalizeEmailAddress(m.email) !== m.email ||
        !Number.isSafeInteger(m.amount) || m.amount < 1 || m.amount > 99_999_999 ||
        !["gbp", "aud", "nzd", "usd", "eur", "cad"].includes(m.currency) || typeof m.url !== "string" || !m.url.length ||
        m.url.length > 4096 || /[\p{Cc}\p{Cf}\s]/u.test(m.url)) return undefined;
    const url = new URL(m.url);
    if (url.username || url.password || (m.purpose === "linkDelivery" ? url.origin !== "https://checkout.stripe.com" ||
        !/^\/c\/pay\/cs_(?:test_|live_)?[A-Za-z0-9]{1,200}$/.test(url.pathname) || !!url.search :
      url.origin !== "https://pay.stripe.com" || !url.pathname.startsWith("/receipts/") || url.pathname.length <= 10)) return undefined;
    const amount = `${m.currency.toUpperCase()} ${(m.amount / 100).toFixed(2)}`;
    if (m.purpose === "receiptDelivery") return { subject: "Your Stripe payment receipt", text:
      `Stripe recorded the clinic payment of ${amount}.\r\nView your Stripe receipt: ${url.toString()}\r\nPayment and appointment status are handled separately.` };
    if (typeof m.deadline !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(m.deadline) ||
        !Number.isFinite(Date.parse(m.deadline)) || new Date(m.deadline).toISOString() !== m.deadline) return undefined;
    const due = new Intl.DateTimeFormat("en-GB", { timeZone: s.timeZone, dateStyle: "full", timeStyle: "short" }).format(new Date(m.deadline));
    return { subject: "Your clinic payment link", text:
      `The clinic requested a payment of ${amount}, due by ${due} (${s.timeZone}).\r\nPay securely with Stripe: ${url.toString()}\r\nThis link does not reserve a time or change an appointment. This email is not a receipt.` };
  } catch { return undefined; }
}
/** Approved sender/template selection only. A digest binds configuration, never
 * recipient authority, provider truth or permission to send. */
export function financialMessageSelectionDigest(selection: FinancialMessageSelection): string | undefined {
  return validFinancialMessageSelection(selection) ? createHash("sha256").update(JSON.stringify([
    "abby.financial-message-selection.v1", selection.sender, selection.template, selection.timeZone])).digest("hex") : undefined;
}
/** Native private fingerprint only; never persist this or recipient/URL in the
 * local operational barrier. It binds the exact approved template and content. */
export function financialMessageDigest(selection: FinancialMessageSelection, message: FinancialMail): string | undefined {
  const rendered = render(selection, message);
  return rendered ? createHash("sha256").update(JSON.stringify(["abby.financial-message.v1", selection,
    message.purpose, message.email, rendered.subject, rendered.text])).digest("hex") : undefined;
}
/** Actual implicit-TLS sender, one submission per invocation, no retry. The
 * receipt is hosted by Stripe; this adapter never manufactures a receipt/PDF. */
export class SmtpFinancialMessageDelivery implements FinancialMessageDelivery {
  readonly #transport: SmtpTextMailTransport;
  readonly #selection: FinancialMessageSelection;
  constructor(config: SmtpMailConfig, timeZone: string) {
    this.#selection = Object.freeze({ sender: config.from, template: "clinicFinancial.v1", timeZone });
    if (!validFinancialMessageSelection(this.#selection)) throw new TypeError("Invalid financial delivery selection");
    this.#transport = new SmtpTextMailTransport(config);
  }
  selection(): FinancialMessageSelection { return this.#selection; }
  async send(message: FinancialMail, signal: AbortSignal, submissionRef: string): Promise<SmtpMailSubmission> {
    const rendered = render(this.#selection, message);
    return rendered ? this.#transport.submit(message.email, rendered.subject, rendered.text, signal, submissionRef) : { kind: "definitiveUnsent" };
  }
}
