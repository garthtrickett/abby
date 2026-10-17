import { KeyObject, randomUUID, sign } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { ClinikoBookingWriter } from "./booking-write.ts";
import type { ClinikoBookingRequest, ClinikoBookingWrite, ClinikoBookingFailure } from "./booking-write.ts";
import { ClinikoClassAttendanceWriter } from "./class-attendance-write.ts";
import type { ClinikoAttendanceRequest, ClinikoAttendanceWrite, ClinikoAttendanceFailure, ClinikoClassBookingChecks } from "./class-attendance-write.ts";
import { ClinikoFinancialReviewReader } from "./financial-review-read.ts";
import type { ClinikoFinancialReviewBinding } from "./financial-review-read.ts";
import { decodeClinikoFinancialIntent, encodeClinikoFinancialIntent } from "./financial-review-intent.ts";
import type { ClinikoFinancialIntent } from "./financial-review-intent.ts";
import { financialIntentDigest, financialBookingObservationPayload, financialBookingObservationMessage,
  formatFinancialBookingObservation } from "./financial-booking-observation.ts";

type Failure = Readonly<{ kind: "financialCaptureUnavailable" }>;
type Observation = Readonly<{ kind: "captured"; notes: string }> | Readonly<{ kind: "missing" }>;
export type FinancialBookingCaptureResult<W, F> = Readonly<{ native: Result<W, F>; observation: Observation }>;
type Config = Readonly<{ reader: ClinikoFinancialReviewReader; privateKey: KeyObject; producerKeyRef: string; clock?: () => string }>;
const unavailable = (): Result<never, Failure> => err({ kind: "financialCaptureUnavailable" });

/** Private financial-owner preparation, before the native writer's last quota/
 * availability/consent checks. This helper grants NO clinical write authority.
 * It captures only an exact native 201 callback; it does not retain a record or
 * activate a checkout. Caller/model/diary inspection cannot submit a receipt. */
export class ClinikoFinancialBookingCapture {
  readonly #intent: ClinikoFinancialIntent;
  readonly #binding: ClinikoFinancialReviewBinding;
  readonly #key: KeyObject;
  readonly #keyRef: string;
  readonly #clock: () => string;
  #consumed = false;
  private constructor(config: Config, binding: ClinikoFinancialReviewBinding, intent: ClinikoFinancialIntent) {
    this.#intent = intent; this.#binding = Object.freeze({ ...binding });
    this.#key = config.privateKey; this.#keyRef = config.producerKeyRef;
    this.#clock = config.clock ?? (() => new Date().toISOString());
  }
  static async prepare(config: Config, binding: ClinikoFinancialReviewBinding, expected: ClinikoFinancialIntent,
                       financialSignal: AbortSignal): Promise<Result<ClinikoFinancialBookingCapture, Failure>> {
    try {
      if (!(config.reader instanceof ClinikoFinancialReviewReader) || !(config.privateKey instanceof KeyObject) ||
          config.privateKey.type !== "private" || config.privateKey.asymmetricKeyType !== "ed25519" ||
          typeof config.producerKeyRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.producerKeyRef) ||
          config.clock !== undefined && typeof config.clock !== "function") return unavailable();
      const owned = Object.freeze({ reader: config.reader, privateKey: config.privateKey, producerKeyRef: config.producerKeyRef, clock: config.clock });
      // Capture expected terms before any asynchronous private read or caller mutation.
      const encoded = encodeClinikoFinancialIntent(expected);
      if (!encoded.ok) return unavailable();
      const snapshot = decodeClinikoFinancialIntent(encoded.value);
      if (!snapshot.ok) return unavailable();
      const selected = Object.freeze({ recallRef: binding.recallRef, actionRef: binding.actionRef });
      const context = await owned.reader.read(selected, financialSignal);
      if (!context.ok || context.value.archivedAt !== null || context.value.recalled || financialSignal.aborted) return unavailable();
      const native = encodeClinikoFinancialIntent(context.value.intent);
      if (!native.ok || native.value !== encoded.value) return unavailable();
      return ok(new ClinikoFinancialBookingCapture(owned, selected, snapshot.value));
    } catch { return unavailable(); }
  }
  #matches(selection: { scope: ClinikoFinancialIntent["scope"]; businessId: string; practitionerId: string; appointmentTypeId: string }, fingerprint: string): boolean {
    const i = this.#intent, s = selection;
    return fingerprint === i.credentialFingerprint && s.businessId === i.businessId && s.practitionerId === i.booking.practitionerId &&
      s.appointmentTypeId === i.booking.appointmentTypeId && s.scope.tenantId === i.scope.tenantId &&
      s.scope.clinicId === i.scope.clinicId && s.scope.locationId === i.scope.locationId;
  }
  #observe(targetRef: string): Observation {
    try {
      const value = { actionRef: randomUUID(), financialActionRef: this.#intent.actionRef, intentRecallRef: this.#binding.recallRef,
        intentDigest: financialIntentDigest(this.#intent)!, bookingActionRef: this.#intent.booking.actionRef,
        targetRef, observedAt: this.#clock(), producerKeyRef: this.#keyRef };
      const payload = financialBookingObservationPayload(value);
      if (!payload || value.observedAt < this.#intent.createdAt) return { kind: "missing" };
      const signature = sign(null, financialBookingObservationMessage(payload), this.#key).toString("base64url");
      const notes = formatFinancialBookingObservation(value, signature);
      return notes ? Object.freeze({ kind: "captured", notes }) : { kind: "missing" };
    } catch { return { kind: "missing" }; }
  }
  async book(writer: ClinikoBookingWriter, input: ClinikoBookingRequest, signal: AbortSignal,
             checks: Pick<ClinikoClassBookingChecks, "beforeSend" | "current">):
    Promise<Result<FinancialBookingCaptureResult<ClinikoBookingWrite, ClinikoBookingFailure>, Failure>> {
    if (this.#consumed) return unavailable();
    this.#consumed = true;
    const i = this.#intent, request = structuredClone(input);
    if (!(writer instanceof ClinikoBookingWriter) || i.booking.kind !== "book" || !this.#matches(writer.selection(), writer.credentialFingerprint()) ||
        request.patientId !== i.patientId || request.marker !== i.booking.actionRef || request.startsAt !== i.booking.startsAt || request.endsAt !== i.booking.endsAt ||
        typeof checks?.beforeSend !== "function" || typeof checks.current !== "function") return unavailable();
    let accepted: Extract<ClinikoBookingWrite, { kind: "accepted" }> | undefined, observation: Observation = { kind: "missing" };
    try {
      const native = await writer.writeOnce(request, signal, checks.beforeSend, receipt => {
        accepted = receipt; observation = this.#observe(receipt.appointmentRef);
      }, checks.current);
      return ok({ native: accepted ? ok(accepted) : native, observation });
    } catch { return accepted ? ok({ native: ok(accepted), observation }) : unavailable(); }
  }
  async classBook(writer: ClinikoClassAttendanceWriter, input: Extract<ClinikoAttendanceRequest, { kind: "book" }>, signal: AbortSignal,
                  checks: Pick<ClinikoClassBookingChecks, "beforeSend" | "current">):
    Promise<Result<FinancialBookingCaptureResult<ClinikoAttendanceWrite, ClinikoAttendanceFailure>, Failure>> {
    if (this.#consumed) return unavailable();
    this.#consumed = true;
    const i = this.#intent, request = structuredClone(input);
    if (!(writer instanceof ClinikoClassAttendanceWriter) || i.booking.kind !== "classBook" || !this.#matches(writer.selection(), writer.selection().credentialFingerprint) ||
        request.kind !== "book" || request.patientId !== i.patientId || request.actionId !== i.booking.actionRef || request.sessionId !== i.booking.sessionId ||
        typeof checks?.beforeSend !== "function" || typeof checks.current !== "function") return unavailable();
    let accepted: Extract<ClinikoAttendanceWrite, { kind: "accepted" }> | undefined, observation: Observation = { kind: "missing" };
    try {
      const native = await writer.executeBookingOnce(request, signal, { beforeSend: checks.beforeSend, current: checks.current, acknowledged: receipt => {
        accepted = receipt; observation = this.#observe(receipt.attendeeRef);
      } });
      return ok({ native: accepted ? ok(accepted) : native, observation });
    } catch { return accepted ? ok({ native: ok(accepted), observation }) : unavailable(); }
  }
}
