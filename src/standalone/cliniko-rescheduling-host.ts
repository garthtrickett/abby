import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import { ClinikoRescheduleWriter } from "../cliniko/reschedule-write.ts";
import type { ClinikoReviewRequest } from "../cliniko/review-request.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { AppointmentChangeEvidenceHost, AppointmentChangeEvidenceQuery, BookingEvidenceHost,
  ReschedulingMenuHost, HostEffects, HostReadFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { ActionRequest, HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation,
  Result, StaffItem, StaffTaskObservation, StaffTaskReceipt } from "../core/model.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { ClinikoAppointmentChangeGuard } from "./cliniko-appointment-change-guard.ts";
import type { ClinikoAppointmentChangeGuardConfig, PreparedClinikoChange } from "./cliniko-appointment-change-guard.ts";
import { ClinikoReviewedSend } from "./cliniko-reviewed-send.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { preparationMayBeDiscarded } from "./prepared-proposal.ts";

export type ClinikoReschedulingHostConfig = ClinikoAppointmentChangeGuardConfig & Readonly<{
  rescheduling: NonNullable<ClinikoAppointmentChangeGuardConfig["rescheduling"]>;
  recallWriter: ClinikoRecallWriter;
  recallTypeId: string;
  timeZone: string;
  menu?: ReschedulingMenuHost;
}>;

/** Standalone best-effort in-place move. All call state is volatile; provider review precedes one send.
 * Construction is not clinic activation. The production caller runner does not expose this host yet. */
export class ClinikoReschedulingHost extends NoStoredKnowledge
  implements AppointmentChangeEvidenceHost, BookingEvidenceHost, HostEffects {
  readonly effectDeadlineMs = 30_000;
  readonly #config: ClinikoReschedulingHostConfig;
  readonly #guard: ClinikoAppointmentChangeGuard;
  readonly #review: ClinikoReviewedSend;
  readonly #lifetime = new AbortController();
  #prepared: PreparedClinikoChange | undefined;
  #preparedRevision = 0;
  #attempted = false;
  #busy = false;

  constructor(config: ClinikoReschedulingHostConfig) {
    super();
    if (!(config.rescheduling instanceof ClinikoRescheduleWriter)) throw new TypeError("missing Cliniko move writer");
    this.#guard = new ClinikoAppointmentChangeGuard(config);
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    this.#review = new ClinikoReviewedSend({ scope: config.scope, businessId: config.businessId,
      credentialFingerprint: config.credentialFingerprint, policyVersion: config.policyVersion,
      timeZone: config.timeZone, recallTypeId: config.recallTypeId, writer: config.recallWriter,
      clock: () => Date.parse(this.#now()) });
  }

  reschedulingMenuAvailable(): boolean { return !this.#lifetime.signal.aborted && this.#config.menu?.reschedulingMenuAvailable() === true; }
  readReschedulingMenu(...args: Parameters<ReschedulingMenuHost["readReschedulingMenu"]>): ReturnType<ReschedulingMenuHost["readReschedulingMenu"]> {
    return this.reschedulingMenuAvailable() ? this.#config.menu!.readReschedulingMenu(...args) : Promise.resolve(err({ kind: "unavailable", target: "appointment" }));
  }
  selectReschedulingMenu(...args: Parameters<ReschedulingMenuHost["selectReschedulingMenu"]>): ReturnType<ReschedulingMenuHost["selectReschedulingMenu"]> {
    return this.reschedulingMenuAvailable() ? this.#config.menu!.selectReschedulingMenu(...args) : Promise.resolve(err({ kind: "unavailable", target: "appointment" }));
  }

  #now(): string { return (this.#config.clock ?? (() => new Date().toISOString()))(); }
  async correctReschedulingMenu(query: import("../core/host.ts").ReschedulingMenuQuery & Readonly<{ menuTurnId: string; startsAt: string }>) {
    return this.reschedulingMenuAvailable() && this.#config.menu?.correctReschedulingMenu
      ? this.#config.menu.correctReschedulingMenu(query) : err({ kind: "unavailable" as const, target: "appointment" as const });
  }

  async resolveAppointmentChange(query: AppointmentChangeEvidenceQuery, external?: AbortSignal): Promise<Result<Extract<ActionRequest,
    { kind: "cancel" | "reschedule" }>, HostReadFailure>> {
    if (this.#lifetime.signal.aborted || this.#busy || this.#attempted || query?.kind !== "reschedule") {
      return err({ kind: "unavailable", target: "appointment" });
    }
    this.#busy = true;
    const signal = AbortSignal.any([this.#lifetime.signal, ...(external ? [external] : []), AbortSignal.timeout(15_000)]);
    try {
      const before = await awaitUntilAbort(this.#config.ledger.read(this.#config.callId, this.#config.scope), signal);
      if (!before?.ok || this.#prepared && !preparationMayBeDiscarded(before.value, this.#prepared.request, this.#preparedRevision))
        return err({ kind: "unavailable", target: "appointment" });
      this.#prepared = undefined;
      const selected = await this.#guard.resolve(query, "proposal", signal);
      if (!selected.ok) return selected;
      const after = await awaitUntilAbort(this.#config.ledger.read(this.#config.callId, this.#config.scope), signal);
      if (!after?.ok || after.value.conversationRevision !== before.value.conversationRevision ||
          selected.value.request.target.timeZone !== this.#config.timeZone || signal.aborted) {
        return err({ kind: "unavailable", target: "appointment" });
      }
      this.#prepared = selected.value;
      this.#preparedRevision = before.value.conversationRevision;
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
    if (this.#lifetime.signal.aborted || this.#busy || this.#attempted || !prepared || mutation.kind !== "reschedule" ||
        prepared.request.kind !== "reschedule" || mutation.request.kind !== "reschedule" || mutation.notification ||
        !sameScope(mutation.scope, config.scope) || mutation.policyVersion !== config.policyVersion ||
        mutation.payloadDigest !== digestActionRequest(prepared.request) ||
        digestActionRequest(mutation.request) !== mutation.payloadDigest ||
        !/^[A-Za-z0-9:_-]{1,256}$/.test(mutation.actionKey) || !("newStartsAt" in prepared.provider)) return reject();
    this.#attempted = true;
    const signal = AbortSignal.any([this.#lifetime.signal, ...(external ? [external] : []), AbortSignal.timeout(30_000)]);
    const uncertain = (): HostWriteReceipt => ({ kind: "uncertain", actionKey: mutation.actionKey,
      reconcileAfter: now, deadline: new Date(Date.parse(now) + 300_000).toISOString() });
    const provider = prepared.provider;
    const confirmed: ClinikoReviewRequest = { scope: config.scope, patientId: provider.patientId,
      businessId: config.businessId, credentialFingerprint: config.credentialFingerprint,
      policyVersion: config.policyVersion, termsVersion: prepared.request.terms.version,
      timeZone: config.timeZone, createdAt: now, operation: { kind: "reschedule", appointmentId: provider.appointmentId,
        newStartsAt: new Date(provider.newStartsAt).toISOString(), newEndsAt: new Date(provider.newEndsAt).toISOString(), practitionerId: provider.practitionerId,
        appointmentTypeId: provider.appointmentTypeId, startsAt: new Date(provider.startsAt).toISOString(),
        endsAt: new Date(provider.endsAt).toISOString() } };
    const result = await this.#review.run(confirmed, {
      authorize: async (_request, stop) => this.#guard.authorize(prepared, mutation, this.#now(), stop),
      send: async (_request, stop) => config.rescheduling.rescheduleOnce(provider, stop, {
        beforeSend: finalStop => this.#guard.authorize(prepared, mutation, this.#now(), finalStop),
        beforeRead: finalStop => this.#guard.mayInspect(prepared, mutation, this.#now(), finalStop),
      }),
    }, signal);
    if (!result.ok) return result.error.kind === "mutationUncertain" || result.error.kind === "reviewUncertain"
      ? uncertain() : reject();
    if (!result.value.outcome.ok) return reject(); // The edge returns errors only before a possible PATCH.
    if (result.value.outcome.value.kind !== "moved" || signal.aborted) return uncertain();
    if (!await this.#guard.mayInspect(prepared, mutation, this.#now(), signal) || signal.aborted) return uncertain();
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
