import { createHash } from "node:crypto";
import type { ClinikoFinancialIntent } from "../cliniko/financial-review-intent.ts";

/** Each clip keeps the existing private-prompt deadline. A new, post-play digit
 * requests the next clip; only the digit after the final clip can consent. */
export function financialConsentReadback(intent: ClinikoFinancialIntent, approvedTerms: string, timeZone: string): readonly string[] | undefined {
  const deadline = new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "full", timeStyle: "short" }).format(new Date(intent.payment.deadline));
  const text = `The clinic requires a post-booking deposit of ${intent.payment.currency.toUpperCase()} ${(intent.payment.amount / 100).toFixed(2)}, payable by ${deadline} in the clinic time zone. With your permission, the clinic will email a secure Stripe payment link to ${intent.recipient.address}. ${approvedTerms} This does not pay now or reserve the time.`;
  const parts: string[] = []; let part = "", count = 0;
  for (const word of text.split(/\s+/)) {
    // An unusually long address/word needs a separately qualified readback.
    if (word.length > 160) return undefined;
    if (part && (part.length + word.length + 1 > 160 || count >= 24)) { parts.push(part); part = ""; count = 0; }
    part += `${part ? " " : ""}${word}`; count++;
  }
  if (part) parts.push(part);
  if (!parts.length || parts.length > 14) return undefined;
  return Object.freeze([...parts.map(p => `${p} Press 1 to hear the next part, or 2 to decline.`),
    "The financial terms are complete. Press 1 to agree to these terms and the payment email, or 2 to decline. If you agree, say continue booking. A separate booking confirmation follows."]);
}


/** Exact producer-signed clip digest; it supplies no clinical permission. */
export function financialConsentDigest(segments: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(segments)).digest("hex");
}
