import { confirmationResendRef, validResendStatus, validResendSubmission } from "./confirmation-resend-journal.ts";
import type { ConfirmationResendJournal } from "./confirmation-resend-journal.ts";
import type { AppointmentConfirmationDelivery, AppointmentConfirmationMail } from "./smtp-appointment-confirmation-delivery.ts";
import type { SmtpMailSubmission } from "./smtp-text-mail-transport.ts";

export type DurableConfirmationOutcome = SmtpMailSubmission | Readonly<{ kind: "denied" }>;

/** Private host submitter, never a model/caller port. The resend evidence owner
 * must establish current permission, recipient/details, played consent and native
 * recovery before calling this port. The journal never stores that evidence.
 * One durable claim precedes any SMTP command. No status authorizes another send. */
export class DurableConfirmationSubmission {
  readonly #journal: ConfirmationResendJournal;
  readonly #delivery: AppointmentConfirmationDelivery;
  constructor(journal: ConfirmationResendJournal, delivery: AppointmentConfirmationDelivery) {
    if (typeof journal?.claim !== "function" || typeof journal.read !== "function" || typeof journal.finish !== "function" ||
        typeof delivery?.send !== "function") throw new TypeError("invalid confirmation submission ports");
    this.#journal = journal; this.#delivery = delivery;
  }
  async submit(requestRef: string, incoming: AppointmentConfirmationMail, signal: AbortSignal,
    authorizeBeforeSend?: () => Promise<boolean>): Promise<DurableConfirmationOutcome> {
    if (!confirmationResendRef(requestRef) || !(signal instanceof AbortSignal) || signal.aborted) return { kind: "denied" };
    let message: AppointmentConfirmationMail;
    try { message = structuredClone(incoming); } catch { return { kind: "denied" }; }
    let claimed: Awaited<ReturnType<ConfirmationResendJournal["claim"]>>;
    try { claimed = await this.#journal.claim(requestRef); } catch { return { kind: "denied" }; }
    if (!claimed?.ok || !claimed.value || Object.keys(claimed.value).sort().join(",") !== "send,status" ||
        typeof claimed.value.send !== "boolean" || !validResendStatus(claimed.value.status) ||
        claimed.value.send && claimed.value.status.kind !== "possiblySent") return { kind: "denied" };
    if (!claimed.value.send) {
      const prior = claimed.value.status;
      return prior.kind === "accepted" ? prior.messageRef === requestRef ? prior : { kind: "unknown" }
        : { kind: prior.kind === "possiblySent" ? "unknown" : prior.kind };
    }
    let result: SmtpMailSubmission = { kind: "definitiveUnsent" };
    let authorized = !signal.aborted;
    if (authorized && authorizeBeforeSend) {
      try { authorized = await authorizeBeforeSend() === true && !signal.aborted; } catch { authorized = false; }
    }
    if (authorized) {
      result = { kind: "unknown" };
      try {
        const observed = await this.#delivery.send(message, signal, requestRef);
        if (validResendSubmission(observed) && (observed.kind !== "accepted" || observed.messageRef === requestRef)) result = observed;
      } catch { /* A transport exception does not prove rejection after the send barrier. */ }
    }
    try { return (await this.#journal.finish(requestRef, result)).ok ? result : { kind: "unknown" }; }
    catch { return { kind: "unknown" }; }
  }
}
