import type { Result } from "../core/model.ts";
import type { SmtpMailSubmission } from "./smtp-text-mail-transport.ts";

export type ConfirmationResendStatus = Readonly<{ kind: "possiblySent" | "definitiveUnsent" | "unknown" }> |
  Readonly<{ kind: "accepted"; messageRef: string }>;
export type ConfirmationResendJournalFailure = Readonly<{ kind: "invalidInput" | "bindingMismatch" | "storageFailure" | "invalidTransition" }>;
export interface ConfirmationResendJournal {
  /** Trusted owner only, before SMTP. A false claim permits status/review, never another submission.
   * The UUID and binding contain no patient, appointment, contact, content, call or session data. */
  claim(requestRef: string): Promise<Result<Readonly<{ send: boolean; status: ConfirmationResendStatus }>, ConfirmationResendJournalFailure>>;
  read(requestRef: string): Promise<Result<ConfirmationResendStatus | null, ConfirmationResendJournalFailure>>;
  finish(requestRef: string, result: SmtpMailSubmission): Promise<Result<true, ConfirmationResendJournalFailure>>;
}
export const confirmationResendRef = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function validResendSubmission(value: unknown): value is SmtpMailSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.kind === "accepted" ? Object.keys(row).sort().join(",") === "kind,messageRef" && confirmationResendRef(row.messageRef)
    : Object.keys(row).join(",") === "kind" && (row.kind === "definitiveUnsent" || row.kind === "unknown");
}
export function validResendStatus(value: unknown): value is ConfirmationResendStatus {
  return validResendSubmission(value) || !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).join(",") === "kind" && (value as { kind?: unknown }).kind === "possiblySent";
}
