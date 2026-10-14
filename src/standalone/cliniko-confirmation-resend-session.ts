import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import type { ClinikoReviewRequest } from "../cliniko/review-request.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { PostgresConfirmationResendJournal } from "../storage/postgres-confirmation-resend-journal.ts";
import { ClinikoConfirmationEvidenceReader } from "./cliniko-confirmation-evidence.ts";
import type { ConfirmationEvidence, ConfirmationEvidenceConfig } from "./cliniko-confirmation-evidence.ts";
import { ClinikoReviewedSend } from "./cliniko-reviewed-send.ts";
import { DurableConfirmationSubmission } from "./durable-confirmation-submission.ts";
import type { DurableConfirmationOutcome } from "./durable-confirmation-submission.ts";
import { appointmentConfirmationText, SmtpAppointmentConfirmationDelivery } from "./smtp-appointment-confirmation-delivery.ts";

export type ConfirmationResendSessionConfig = ConfirmationEvidenceConfig & Readonly<{
  journal: PostgresConfirmationResendJournal; email: SmtpAppointmentConfirmationDelivery;
  /** Private playback completion, never queue acceptance. */
  presentation: Readonly<{ play(text: string, signal: AbortSignal, presentationId?: string): Promise<boolean> }>;
  /** Trusted SAM owner must establish this exact ref's separately played and confirmed action.
   * It must not derive consent from verification, readback acceptance or a model boolean. */
  isConfirmed(requestRef: string, signal: AbortSignal): Promise<boolean>;
}>;
type Failure = Readonly<{ kind: "confirmationResendUnavailable" }>;
type Pending = Readonly<{ ref: string; evidence: ConfirmationEvidence }>;

/** Private native evidence/review/send owner. No caller/model entry point or standalone activation.
 * A separate trusted SAM confirmation port is mandatory before any review or SMTP write. */
export class ClinikoConfirmationResendSession {
  readonly #config: ConfirmationResendSessionConfig;
  readonly #reader: ClinikoConfirmationEvidenceReader;
  readonly #review: ClinikoReviewedSend;
  readonly #submitter: DurableConfirmationSubmission;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.dispose();
  #pending: Pending | undefined;
  #busy = false;
  #attempted = false;
  private constructor(config: ConfirmationResendSessionConfig, reader: ClinikoConfirmationEvidenceReader, review: ClinikoReviewedSend) {
    this.#config = config; this.#reader = reader; this.#review = review;
    this.#submitter = new DurableConfirmationSubmission(config.journal, config.email);
    config.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.signal.aborted) this.dispose();
  }
  static async create(incoming: ConfirmationResendSessionConfig): Promise<Result<ClinikoConfirmationResendSession, Failure>> {
    try {
      const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound), cliniko: Object.freeze({ ...incoming.cliniko }) });
      const reader = new ClinikoConfirmationEvidenceReader(config), scope = config.receipt.scope;
      if (!(config.journal instanceof PostgresConfirmationResendJournal) || !(config.email instanceof SmtpAppointmentConfirmationDelivery) ||
          !config.journal.matches(scope, config.policy.bindingFingerprint()) || typeof config.presentation?.play !== "function" || typeof config.isConfirmed !== "function") return err({ kind: "confirmationResendUnavailable" });
      const approval = await awaitUntilAbort(config.policy.current(scope), AbortSignal.any([config.signal, AbortSignal.timeout(15_000)]));
      if (!approval?.ok || config.signal.aborted || approval.value.sender !== config.email.selection().sender || approval.value.template !== config.email.selection().template) return err({ kind: "confirmationResendUnavailable" });
      const writer = ClinikoRecallWriter.create({ ...config.cliniko, scope }, config.fetchPort);
      if (!writer.ok) return err({ kind: "confirmationResendUnavailable" });
      const review = new ClinikoReviewedSend({ scope, businessId: config.cliniko.businessId, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey),
        policyVersion: config.policyVersion, timeZone: config.cliniko.timeZone, recallTypeId: config.cliniko.recallTypeId, writer: writer.value,
        clock: () => Date.parse((config.clock ?? (() => new Date().toISOString()))()) });
      return ok(new ClinikoConfirmationResendSession(config, reader, review));
    } catch { return err({ kind: "confirmationResendUnavailable" }); }
  }
  async #bounded<T>(run: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T | undefined> {
    const signal = AbortSignal.any([this.#lifetime.signal, this.#config.signal, AbortSignal.timeout(30_000), ...(external ? [external] : [])]);
    try { return await awaitUntilAbort(Promise.resolve().then(() => signal.aborted ? undefined : run(signal)), signal); }
    catch { return undefined; }
  }
  discardPreparation(): boolean {
    if (this.#busy || this.#attempted || this.#lifetime.signal.aborted) return false;
    this.#pending = undefined; return true;
  }
  /** Trusted exact selection only. Private details are played, while only an opaque ref is returned. */
  async prepare(appointmentId: string, external?: AbortSignal): Promise<Result<Readonly<{ requestRef: string }>, Failure>> {
    if (this.#busy || this.#attempted || this.#lifetime.signal.aborted || external?.aborted) return err({ kind: "confirmationResendUnavailable" });
    this.#busy = true; this.#pending = undefined;
    try {
      const prepared = await this.#bounded(async signal => {
        const evidence = await this.#reader.read(appointmentId, signal);
        if (!evidence) return undefined;
        const text = `Please check the email recipient: ${evidence.mail.email}. ${appointmentConfirmationText(evidence.mail)}. Confirm sending separately after this readback.`;
        if (text.length > 2000 || await this.#config.presentation.play(text, signal) !== true || signal.aborted) return undefined;
        const fresh = await this.#reader.read(appointmentId, signal);
        return fresh && isDeepStrictEqual(evidence, fresh) ? { ref: randomUUID(), evidence: structuredClone(evidence) } : undefined;
      }, external);
      if (!prepared || this.#lifetime.signal.aborted) return err({ kind: "confirmationResendUnavailable" });
      this.#pending = prepared; return ok({ requestRef: prepared.ref });
    } finally { this.#busy = false; }
  }
  async #authorize(pending: Pending, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.#lifetime.signal.aborted || this.#pending !== pending || await this.#config.isConfirmed(pending.ref, signal) !== true) return false;
    const fresh = await this.#reader.read(pending.evidence.appointmentId, signal);
    return !!fresh && isDeepStrictEqual(fresh, pending.evidence) && !signal.aborted && !this.#lifetime.signal.aborted &&
      this.#pending === pending && await this.#config.isConfirmed(pending.ref, signal) === true;
  }
  /** Proposal resolution only: proves the private readback still matches current evidence; grants no consent. */
  async current(requestRef: string, external: AbortSignal): Promise<boolean> {
    const pending = this.#pending;
    if (this.#busy || this.#attempted || !pending || pending.ref !== requestRef || external.aborted || this.#lifetime.signal.aborted) return false;
    return await this.#bounded(async signal => {
      const fresh = await this.#reader.read(pending.evidence.appointmentId, signal);
      return !!fresh && isDeepStrictEqual(fresh, pending.evidence) && this.#pending === pending && !signal.aborted;
    }, external) === true;
  }
  async dispatch(requestRef: string, external: AbortSignal): Promise<DurableConfirmationOutcome> {
    const pending = this.#pending;
    if (this.#busy || this.#attempted || !pending || pending.ref !== requestRef || external.aborted || this.#lifetime.signal.aborted) return { kind: "denied" };
    this.#busy = true; this.#attempted = true;
    try {
      const result = await this.#bounded(async signal => {
        if (!await this.#authorize(pending, signal)) return { kind: "denied" as const };
        const c = this.#config, evidence = pending.evidence;
        const request: ClinikoReviewRequest = { scope: c.receipt.scope, patientId: evidence.patientId, businessId: c.cliniko.businessId,
          credentialFingerprint: clinikoCredentialFingerprint(c.cliniko.apiKey), policyVersion: c.policyVersion,
          termsVersion: c.policy.bindingFingerprint(), timeZone: c.cliniko.timeZone, createdAt: (c.clock ?? (() => new Date().toISOString()))(),
          operation: { kind: "confirmationResend", resendRef: pending.ref, appointmentId: evidence.appointmentId, practitionerId: evidence.practitionerId,
            appointmentTypeId: evidence.appointmentTypeId, ...(evidence.mail.contentKind ? { contentKind: evidence.mail.contentKind } : {}), startsAt: evidence.mail.startsAt, endsAt: evidence.mail.endsAt } };
        const sent = await this.#review.run(request, { authorize: (_request, bound) => this.#authorize(pending, bound),
          send: (_request, bound) => this.#submitter.submit(pending.ref, evidence.mail, bound, () => this.#authorize(pending, bound)) }, signal);
        return sent.ok ? sent.value.outcome : { kind: sent.error.kind === "mutationUncertain" ? "unknown" as const : "denied" as const };
      }, external);
      return result ?? { kind: "unknown" };
    } finally { this.#busy = false; }
  }
  dispose(): void { this.#lifetime.abort(); this.#review.close(); this.#config.signal.removeEventListener("abort", this.#onClose); this.#pending = undefined; }
}
