import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import type { ClinikoReviewRequest } from "../cliniko/review-request.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { AppointmentChangeEvidenceHost, AppointmentChangeEvidenceQuery, BookingEvidenceHost,
  HostEffects, HostReadFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { ActionRequest, HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation,
  Result, StaffItem, StaffTaskObservation, StaffTaskReceipt } from "../core/model.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { ClinikoAppointmentChangeGuard } from "./cliniko-appointment-change-guard.ts";
import type { ClinikoAppointmentChangeGuardConfig, PreparedClinikoChange } from "./cliniko-appointment-change-guard.ts";
import { ClinikoReviewedSend } from "./cliniko-reviewed-send.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";

export type ClinikoCancellationHostConfig = Omit<ClinikoAppointmentChangeGuardConfig, "rescheduling"> & Readonly<{
  recallWriter: ClinikoRecallWriter;
  recallTypeId: string;
  timeZone: string;
}>;

/** Standalone best-effort cancellation. All call state is volatile; provider review precedes one send.
 * Construction is not clinic activation. The production caller runner does not expose this host yet. */
export class ClinikoCancellationHost extends NoStoredKnowledge
  implements AppointmentChangeEvidenceHost, BookingEvidenceHost, HostEffects {
  readonly effectDeadlineMs = 30_000;
  readonly #config: ClinikoCancellationHostConfig;
  readonly #guard: ClinikoAppointmentChangeGuard;
  readonly #review: ClinikoReviewedSend;
  readonly #lifetime = new AbortController();
  #prepared: PreparedClinikoChange | undefined;
  #attempted = false;
  #busy = false;

  constructor(config: ClinikoCancellationHostConfig) {
    super();
    this.#guard = new ClinikoAppointmentChangeGuard(config);
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    this.#review = new ClinikoReviewedSend({ scope: config.scope, businessId: config.businessId,
      credentialFingerprint: config.credentialFingerprint, policyVersion: config.policyVersion,
      timeZone: config.timeZone, recallTypeId: config.recallTypeId, writer: config.recallWriter,
      clock: () => Date.parse(this.#now()) });
  }

  #now(): string { return (this.#config.clock ?? (() => new Date().toISOString()))(); }

  async resolveAppointmentChange(query: AppointmentChangeEvidenceQuery, external?: AbortSignal): Promise<Result<Extract<ActionRequest,
    { kind: "cancel" | "reschedule" }>, HostReadFailure>> {
    if (this.#lifetime.signal.aborted || external?.aborted || this.#busy || this.#attempted || this.#prepared || query?.kind !== "cancel") {
      return err({ kind: "unavailable", target: "appointment" });
    }
    this.#busy = true;
    const signal = AbortSignal.any([this.#lifetime.signal, ...(external ? [external] : []), AbortSignal.timeout(15_000)]);
    try {
      const selected = await this.#guard.resolve(query, "proposal", signal);
      if (!selected.ok) return selected;
      if (selected.value.request.target.timeZone !== this.#config.timeZone || signal.aborted) {
        return err({ kind: "unavailable", target: "appointment" });
      }
      this.#prepared = selected.value;
      return ok(structuredClone(selected.value.request));
    } finally { this.#busy = false; }
  }

  async resolveBooking(_scope: LocationScope, _verificationRef: string, _offerRef: string, _now: string):
    Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>> {
    return err({ kind: "unavailable", target: "offer" });
  }

  async write(mutation: HostMutation, now: string, external?: AbortSignal): Promise<HostWriteReceipt> {
    const reject = (): HostWriteReceipt => ({ kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" });
    const prepared = this.#prepared, config = this.#config;
    if (this.#lifetime.signal.aborted || this.#busy || this.#attempted || !prepared || mutation.kind !== "cancel" ||
        prepared.request.kind !== "cancel" || mutation.request.kind !== "cancel" || mutation.notification ||
        !sameScope(mutation.scope, config.scope) || mutation.policyVersion !== config.policyVersion ||
        mutation.payloadDigest !== digestActionRequest(prepared.request) ||
        digestActionRequest(mutation.request) !== mutation.payloadDigest ||
        !/^[A-Za-z0-9:_-]{1,256}$/.test(mutation.actionKey) || !("cancellationReason" in prepared.provider)) return reject();
    this.#attempted = true;
    const signal = AbortSignal.any([this.#lifetime.signal, ...(external ? [external] : []), AbortSignal.timeout(30_000)]);
    const uncertain = (): HostWriteReceipt => ({ kind: "uncertain", actionKey: mutation.actionKey,
      reconcileAfter: now, deadline: new Date(Date.parse(now) + 300_000).toISOString() });
    const provider = prepared.provider;
    const confirmed: ClinikoReviewRequest = { scope: config.scope, patientId: provider.patientId,
      businessId: config.businessId, credentialFingerprint: config.credentialFingerprint,
      policyVersion: config.policyVersion, termsVersion: prepared.request.terms.version,
      timeZone: config.timeZone, createdAt: now, operation: { kind: "cancel", appointmentId: provider.appointmentId,
        cancellationReason: provider.cancellationReason, practitionerId: provider.practitionerId,
        appointmentTypeId: provider.appointmentTypeId, startsAt: new Date(provider.startsAt).toISOString(),
        endsAt: new Date(provider.endsAt).toISOString() } };
    const result = await this.#review.run(confirmed, {
      authorize: async (_request, stop) => this.#guard.authorize(prepared, mutation, this.#now(), stop),
      send: async (_request, stop) => config.cancellation.cancelOnce(provider, stop, finalStop =>
        this.#guard.authorize(prepared, mutation, this.#now(), finalStop)),
    }, signal);
    if (!result.ok) return result.error.kind === "mutationUncertain" || result.error.kind === "reviewUncertain"
      ? uncertain() : reject();
    if (!result.value.outcome.ok || result.value.outcome.value.kind !== "cancelled" || signal.aborted) return uncertain();
    return { kind: "committed", actionKey: mutation.actionKey, hostRef: provider.appointmentId };
  }

  async reconcile(mutation: HostMutation, _signal?: AbortSignal): Promise<ReconcileObservation> {
    // Later mutable provider state cannot identify this writer or establish fee/notification effects.
    return { kind: "stillUnknown", actionKey: mutation.actionKey };
  }

  async openTask(item: StaffItem, _signal?: AbortSignal): Promise<StaffTaskReceipt> {
    // Saving the pre-send review is not assignment, notification or a general delivered handoff.
    return { kind: "rejected", taskKey: item.key };
  }

  async reconcileTask(item: StaffItem, _signal?: AbortSignal): Promise<StaffTaskObservation> {
    return { kind: "stillUnknown", taskKey: item.key };
  }

  dispose(): void { this.#lifetime.abort(); this.#review.close(); this.#guard.dispose(); this.#prepared = undefined; }
}
