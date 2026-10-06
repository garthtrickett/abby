import { randomUUID } from "node:crypto";
import type { ClinikoBookingFailure, ClinikoBookingWrite } from "../cliniko/booking-write.ts";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import type { ClinikoReviewRequest } from "../cliniko/review-request.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { BookingEvidenceHost, BookingMenuHost, BookingMenuQuery, HostEffects, HostReadFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { ActionRequest, HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation, Result, StaffItem,
  StaffTaskObservation, StaffTaskReceipt } from "../core/model.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { bookingProviderRequest } from "./cliniko-booking-authority.ts";
import type { PreparedClinikoBooking } from "./cliniko-booking-authority.ts";
import { ClinikoBookingGuard } from "./cliniko-booking-guard.ts";
import type { ClinikoBookingGuardConfig } from "./cliniko-booking-guard.ts";
import { ClinikoReviewedSend } from "./cliniko-reviewed-send.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { preparationMayBeDiscarded } from "./prepared-proposal.ts";

export type ClinikoBookingHostConfig = ClinikoBookingGuardConfig & Readonly<{ recallWriter: ClinikoRecallWriter; recallTypeId: string; timeZone: string; menu?: BookingMenuHost }>;

/** Standalone declared best-effort booking, with one Cliniko-owned review before one possible send.
 * This does not grant exclusive commit permission or activate the live runner. */
export class ClinikoBookingHost extends NoStoredKnowledge implements BookingEvidenceHost, HostEffects {
  readonly effectDeadlineMs = 30_000;
  readonly #config: ClinikoBookingHostConfig;
  readonly #guard: ClinikoBookingGuard;
  readonly #review: ClinikoReviewedSend;
  readonly #lifetime = new AbortController();
  #prepared: PreparedClinikoBooking | undefined;
  #preparedRevision = 0;
  #attempted = false;
  #busy = false;
  constructor(config: ClinikoBookingHostConfig) {
    super(); this.#guard = new ClinikoBookingGuard(config);
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    this.#review = new ClinikoReviewedSend({ scope: config.scope, businessId: config.writer.selection().businessId,
      credentialFingerprint: config.writer.credentialFingerprint(), policyVersion: config.policyVersion, timeZone: config.timeZone,
      recallTypeId: config.recallTypeId, writer: config.recallWriter, clock: () => Date.parse(this.#now()) });
  }
  bookingMenuAvailable(): boolean { return !this.#lifetime.signal.aborted && this.#config.menu?.bookingMenuAvailable() === true; }
  async readBookingMenu(query: BookingMenuQuery & Readonly<{ from: string; to: string }>) {
    return this.bookingMenuAvailable() ? this.#config.menu!.readBookingMenu(query) : err({ kind: "unavailable" as const, target: "offer" as const });
  }
  async selectBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>) {
    return this.bookingMenuAvailable() ? this.#config.menu!.selectBookingMenu(query) : err({ kind: "unavailable" as const, target: "offer" as const });
  }
  async correctBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; startsAt: string }>) {
    return this.bookingMenuAvailable() && this.#config.menu?.correctBookingMenu
      ? this.#config.menu.correctBookingMenu(query) : err({ kind: "unavailable" as const, target: "offer" as const });
  }
  #now(): string { return (this.#config.clock ?? (() => new Date().toISOString()))(); }
  async resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string, external?: AbortSignal):
    Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>> {
    if (this.#lifetime.signal.aborted || this.#busy || this.#attempted) return err({ kind: "unavailable", target: "offer" });
    this.#busy = true;
    const signal = AbortSignal.any([this.#lifetime.signal, ...(external ? [external] : []), AbortSignal.timeout(15_000)]);
    try {
      const before = await awaitUntilAbort(this.#config.ledger.read(this.#config.callId, this.#config.scope), signal);
      if (!before?.ok || this.#prepared && !preparationMayBeDiscarded(before.value, this.#prepared.request, this.#preparedRevision))
        return err({ kind: "unavailable", target: "offer" });
      this.#prepared = undefined;
      const selected = await this.#guard.resolve(scope, verificationRef, offerRef, now, "proposal", signal);
      if (!selected.ok) return selected;
      const after = await awaitUntilAbort(this.#config.ledger.read(this.#config.callId, this.#config.scope), signal);
      if (!after?.ok || after.value.conversationRevision !== before.value.conversationRevision || signal.aborted ||
          selected.value.evidence.timeZone !== this.#config.timeZone) return err({ kind: "unavailable", target: "offer" });
      this.#preparedRevision = before.value.conversationRevision;
      this.#prepared = selected.value; return ok(structuredClone(selected.value.request));
    } finally { this.#busy = false; }
  }
  async write(mutation: HostMutation, now: string, external?: AbortSignal): Promise<HostWriteReceipt> {
    const reject = (): HostWriteReceipt => ({ kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" });
    const config = this.#config, prepared = this.#prepared;
    if (this.#lifetime.signal.aborted || this.#busy || this.#attempted || !prepared || mutation.kind !== "book" || mutation.request.kind !== "book" ||
        mutation.notification || !sameScope(mutation.scope, config.scope) || mutation.policyVersion !== config.policyVersion ||
        mutation.payloadDigest !== digestActionRequest(prepared.request) || digestActionRequest(mutation.request) !== mutation.payloadDigest ||
        !/^[A-Za-z0-9:_-]{1,256}$/.test(mutation.actionKey) || !Number.isFinite(Date.parse(now))) return reject();
    this.#attempted = true;
    const signal = AbortSignal.any([this.#lifetime.signal, ...(external ? [external] : []), AbortSignal.timeout(30_000)]);
    const uncertain = (): HostWriteReceipt => ({ kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now,
      deadline: new Date(Date.parse(now) + 300_000).toISOString() });
    const source = prepared.evidence;
    const confirmed: ClinikoReviewRequest = { scope: config.scope, patientId: prepared.request.patient.patientRef,
      businessId: source.businessId, credentialFingerprint: config.writer.credentialFingerprint(), policyVersion: config.policyVersion,
      termsVersion: source.bookingPolicyVersion, timeZone: source.timeZone, createdAt: now,
      operation: { kind: "book", practitionerId: source.practitionerId, appointmentTypeId: source.appointmentTypeId,
        startsAt: prepared.request.offer.startsAt, endsAt: source.endsAt } };
    const providerRequest = bookingProviderRequest(prepared, randomUUID());
    const result = await this.#review.run(confirmed, {
      authorize: async (_request, stop) => this.#guard.authorize(prepared, mutation, this.#now(), stop),
      send: async (_request, stop): Promise<Result<ClinikoBookingWrite, ClinikoBookingFailure>> => {
        const sent = await config.writer.writeOnce(providerRequest, stop, finalStop => this.#guard.authorize(prepared, mutation, this.#now(), finalStop));
        if (!sent.ok || sent.value.kind !== "accepted") return sent;
        if (!await this.#guard.mayInspect(prepared, mutation, this.#now(), stop)) return ok({ kind: "uncertain" });
        const readBack = await config.writer.inspectCreated(providerRequest, sent.value.appointmentRef, source.endsAt, stop, finalStop => this.#guard.mayInspect(prepared, mutation, this.#now(), finalStop));
        if (!readBack.ok || !readBack.value || !await this.#guard.mayInspect(prepared, mutation, this.#now(), stop)) return ok({ kind: "uncertain" });
        const conflicts = await config.writer.inspectConflicts(sent.value.appointmentRef, stop, finalStop => this.#guard.mayInspect(prepared, mutation, this.#now(), finalStop));
        if (!conflicts.ok || conflicts.value || !await this.#guard.mayInspect(prepared, mutation, this.#now(), stop)) return ok({ kind: "uncertain" });
        return sent;
      },
    }, signal);
    if (!result.ok) return result.error.kind === "reviewUncertain" || result.error.kind === "mutationUncertain" ? uncertain() : reject();
    if (!result.value.outcome.ok) return reject();
    if (result.value.outcome.value.kind !== "accepted" || signal.aborted) return uncertain();
    return { kind: "committed", actionKey: mutation.actionKey, hostRef: result.value.outcome.value.appointmentRef };
  }
  async reconcile(mutation: HostMutation, _signal?: AbortSignal): Promise<ReconcileObservation> {
    return { kind: "stillUnknown", actionKey: mutation.actionKey };
  }
  async openTask(item: StaffItem, _signal?: AbortSignal): Promise<StaffTaskReceipt> { return { kind: "rejected", taskKey: item.key }; }
  async reconcileTask(item: StaffItem, _signal?: AbortSignal): Promise<StaffTaskObservation> { return { kind: "stillUnknown", taskKey: item.key }; }
  dispose(): void { this.#lifetime.abort(); this.#review.close(); this.#guard.dispose(); this.#prepared = undefined; }
}
