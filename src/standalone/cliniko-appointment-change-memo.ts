import { isDeepStrictEqual } from "node:util";
import { administrativeMemoActionRef } from "../cliniko/administrative-memo.ts";
import type { AdministrativeMemo, AdministrativeMemoOutcome } from "../cliniko/administrative-memo.ts";
import { ClinikoCancellationWriter, ClinikoRescheduleWriter } from "../cliniko/appointment-write.ts";
import type { LocationScope } from "../core/model.ts";
import { captureAdministrativeMemoConfig, retainAdministrativeMemo } from "./administrative-memo-retention.ts";
import type { ClinikoAdministrativeMemoConfig } from "./administrative-memo-retention.ts";
import { ClinikoAppointmentChangeGuard } from "./cliniko-appointment-change-guard.ts";
import type { PreparedClinikoChange } from "./cliniko-appointment-change-guard.ts";
import { ClinikoReviewedSend } from "./cliniko-reviewed-send.ts";
import type { ClinikoReviewRequest } from "../cliniko/review-request.ts";

type Call = Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  businessId: string; credentialFingerprint: string; timeZone: string;
  cancellation: ClinikoCancellationWriter; rescheduling?: ClinikoRescheduleWriter; clock?: () => string }>;

/** Joins three actual owners: verified dispatch, acknowledged native review,
 * and acknowledged-then-inspected mutation. It preserves their best-effort
 * meaning, grants no clinical continuation, and cannot repeat either effect. */
export class ClinikoAppointmentChangeMemo {
  readonly #config: ClinikoAdministrativeMemoConfig;
  readonly #call: Call;
  readonly #source: ClinikoAppointmentChangeGuard["inspectedOutcomeSource"];
  readonly #reviewSource: ClinikoReviewedSend["changeSource"];
  #captured = false;
  #memo: AdministrativeMemo | undefined;
  #retaining: Promise<void> | undefined;
  constructor(config: ClinikoAdministrativeMemoConfig, call: Call, guard: ClinikoAppointmentChangeGuard, review: ClinikoReviewedSend) {
    if (!(guard instanceof ClinikoAppointmentChangeGuard) || !(review instanceof ClinikoReviewedSend) ||
        !(call.cancellation instanceof ClinikoCancellationWriter) || !call.cancellation.sharesRequestBudget(config.native.rateBudget) ||
        call.rescheduling !== undefined && (!(call.rescheduling instanceof ClinikoRescheduleWriter) || !call.rescheduling.sharesRequestBudget(config.native.rateBudget)) ||
        !review.sharesRequestBudget(config.native.rateBudget)) throw Error("Invalid administrative change memo selection");
    this.#config = captureAdministrativeMemoConfig(config, { scope: call.scope, businessId: call.businessId,
      credentialFingerprint: call.credentialFingerprint, rateBudget: config.native.rateBudget, ...(call.clock ? { clock: call.clock } : {}) });
    this.#call = Object.freeze({ ...call, scope: Object.freeze({ ...call.scope }) });
    this.#source = guard.inspectedOutcomeSource.bind(guard); this.#reviewSource = review.changeSource.bind(review);
  }
  /** Called only on the existing host's final successful path. It performs no
   * awaited work or IO, and it does not manufacture a clinical receipt. */
  capture(prepared: PreparedClinikoChange, result: unknown, confirmed: ClinikoReviewRequest): void {
    if (this.#captured) return; this.#captured = true;
    try {
      const reviewed = this.#reviewSource(result), value = result as { outcome?: { ok?: unknown; value?: unknown } };
      if (!reviewed || value.outcome?.ok !== true || !isDeepStrictEqual(reviewed.request, confirmed)) return;
      const found = this.#source(prepared, value.outcome.value), c = this.#call;
      if (!found) return; const { dispatch: d, native: n } = found, r = n.request, op = reviewed.request.operation;
      if (op.kind !== "cancel" && op.kind !== "reschedule") return;
      if (!isDeepStrictEqual(d.scope, c.scope) || d.callId !== c.callId || d.sessionId !== c.sessionId || d.policyVersion !== c.policyVersion ||
          d.businessId !== c.businessId || d.credentialFingerprint !== c.credentialFingerprint || reviewed.request.patientId !== d.patientId ||
          !isDeepStrictEqual(reviewed.request.scope, d.scope) || reviewed.request.businessId !== d.businessId ||
          reviewed.request.credentialFingerprint !== d.credentialFingerprint || reviewed.request.policyVersion !== d.policyVersion ||
          reviewed.request.termsVersion !== prepared.request.terms.version || reviewed.request.timeZone !== c.timeZone ||
          op.kind !== d.kind || op.appointmentId !== r.appointmentId || op.practitionerId !== r.practitionerId || op.appointmentTypeId !== r.appointmentTypeId ||
          Date.parse(op.startsAt) !== Date.parse(r.startsAt) || Date.parse(op.endsAt) !== Date.parse(r.endsAt)) return;
      const observedAt = new Date(n.observedAt).toISOString(), recordedAt = this.#config.native.clock!();
      if (observedAt < new Date(reviewed.request.createdAt).toISOString()) return;
      const common = { appointmentRef: `cliniko:appointment:${r.appointmentId}`,
        verification: { basis: "acknowledgedAndObservedBestEffort" as const, observedAt } };
      let outcome: AdministrativeMemoOutcome;
      if (n.kind === "cancellationObserved" && op.kind === "cancel" && n.request.cancellationReason === op.cancellationReason) {
        outcome = { ...common, kind: "cancellationObserved", startsAt: new Date(r.startsAt).toISOString(), endsAt: new Date(r.endsAt).toISOString() };
      } else if (n.kind === "reschedulingObserved" && op.kind === "reschedule" &&
          Date.parse(n.request.newStartsAt) === Date.parse(op.newStartsAt) && Date.parse(n.request.newEndsAt) === Date.parse(op.newEndsAt) &&
          n.request.newPractitionerId === op.newPractitionerId) {
        outcome = { ...common, kind: "reschedulingObserved", startsAt: new Date(n.request.newStartsAt).toISOString(), endsAt: new Date(n.request.newEndsAt).toISOString(),
          practitionerRef: `cliniko:practitioner:${n.request.newPractitionerId ?? r.practitionerId}`,
          previous: { startsAt: new Date(r.startsAt).toISOString(), endsAt: new Date(r.endsAt).toISOString(), practitionerRef: `cliniko:practitioner:${r.practitionerId}` } };
      } else return;
      const actionRef = administrativeMemoActionRef(reviewed.marker); if (!actionRef) return;
      const signed = this.#config.authentication.sign({ actionRef, sourceActionRef: reviewed.marker, scope: c.scope,
        businessId: d.businessId, credentialFingerprint: d.credentialFingerprint, patientId: d.patientId,
        authorRef: this.#config.native.authorRef, policy: this.#config.native.policy, direction: d.direction, outcome,
        occurredAt: observedAt, recordedAt });
      if (signed.ok) this.#memo = signed.value;
    } catch { /* Memo provenance cannot veto an already successful host result. */ }
  }
  retain(): Promise<void> { this.#retaining ??= this.#retain(); return this.#retaining; }
  async #retain(): Promise<void> {
    try { await retainAdministrativeMemo(this.#config, this.#memo); } finally { this.#memo = undefined; }
  }
}
