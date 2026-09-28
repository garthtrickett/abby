import { digestActionRequest, digestTurn } from "../core/digest.ts";
import type { BookingEvidenceHost, HostEffects, HostReadFailure, KnowledgeHost, KnowledgeReadFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { ActionRequest, ApprovedKnowledge, BookableOffer, HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation, Result, StaffItem, StaffTaskObservation, StaffTaskReceipt, VerifiedPatient } from "../core/model.ts";

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

type Booking = Readonly<{ actionKey: string; hostRef: string; scope: LocationScope; patientRef: string; offerRef: string; payloadDigest: string }>;
type Task = Readonly<{ taskKey: string; hostTaskRef: string; scope: LocationScope; destination: StaffItem["destination"]; payloadDigest: string }>;

export class ReferenceClinicHost implements BookingEvidenceHost, HostEffects, KnowledgeHost {
  private readonly patients: readonly VerifiedPatient[];
  private readonly offers: readonly BookableOffer[];
  private readonly knowledge: readonly ApprovedKnowledge[];
  private readonly bookingsByAction = new Map<string, Booking>();
  private readonly bookingKeyByOffer = new Map<string, string>();
  private readonly tasksByKey = new Map<string, Task>();
  private resolutionCount = 0;

  constructor(patients: readonly VerifiedPatient[], offers: readonly BookableOffer[], knowledge: readonly ApprovedKnowledge[] = []) {
    this.patients = structuredClone(patients);
    this.offers = structuredClone(offers);
    this.knowledge = structuredClone(knowledge);
  }

  async readKnowledge(scope: LocationScope, sourceRefs: readonly string[]): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>> {
    if (!Array.isArray(sourceRefs) || sourceRefs.length < 1 || sourceRefs.length > 8 || sourceRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 256) ||
        new Set(sourceRefs).size !== sourceRefs.length) return err({ kind: "invalidQuery" });
    return ok(structuredClone(this.knowledge.filter(source => sameScope(source.scope, scope) && sourceRefs.includes(source.sourceRef))));
  }

  async resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string): Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>> {
    this.resolutionCount += 1;
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "unavailable", target: "offer" });
    const patients = this.patients.filter(item => item.verificationRef === verificationRef && sameScope(item.scope, scope));
    const offers = this.offers.filter(item => item.offerRef === offerRef && sameScope(item.scope, scope));
    if (patients.length === 0) return err({ kind: "notFound", target: "patient" });
    if (offers.length === 0) return err({ kind: "notFound", target: "offer" });
    if (patients.length !== 1) return err({ kind: "ambiguous", target: "patient" });
    if (offers.length !== 1) return err({ kind: "ambiguous", target: "offer" });
    const patient = patients[0]!;
    const offer = offers[0]!;
    if (Date.parse(patient.expiresAt) <= Date.parse(now)) return err({ kind: "expired", target: "patient" });
    if (Date.parse(offer.expiresAt) <= Date.parse(now)) return err({ kind: "expired", target: "offer" });
    return ok({ kind: "book", patient: structuredClone(patient), offer: structuredClone(offer) });
  }

  async write(mutation: HostMutation, now: string): Promise<HostWriteReceipt> {
    const existing = this.bookingsByAction.get(mutation.actionKey);
    if (existing) {
      return mutation.kind === "book" && mutation.request.kind === "book" && existing.payloadDigest === mutation.payloadDigest && digestActionRequest(mutation.request) === existing.payloadDigest && sameScope(existing.scope, mutation.scope)
        ? { kind: "committed", actionKey: mutation.actionKey, hostRef: existing.hostRef }
        : { kind: "rejected", actionKey: mutation.actionKey, reason: "invalid" };
    }
    const request = mutation.request;
    if (mutation.kind !== "book" || request.kind !== "book") return { kind: "unsupported", actionKey: mutation.actionKey };
    if (!Number.isFinite(Date.parse(now)) || mutation.payloadDigest !== digestActionRequest(request)) return { kind: "rejected", actionKey: mutation.actionKey, reason: "invalid" };
    const evidence = await this.resolveBooking(mutation.scope, request.patient.verificationRef, request.offer.offerRef, now);
    if (!evidence.ok) return { kind: "rejected", actionKey: mutation.actionKey, reason: evidence.error.kind === "expired" ? "expiredOffer" : "forbidden" };
    if (digestActionRequest(evidence.value) !== mutation.payloadDigest) return { kind: "rejected", actionKey: mutation.actionKey, reason: "invalid" };
    const scopedOffer = JSON.stringify([mutation.scope.tenantId, mutation.scope.clinicId, mutation.scope.locationId, request.offer.offerRef]);
    if (this.bookingKeyByOffer.has(scopedOffer)) return { kind: "rejected", actionKey: mutation.actionKey, reason: "conflict" };
    const hostRef = `reference-booking:${mutation.actionKey}`;
    this.bookingsByAction.set(mutation.actionKey, { actionKey: mutation.actionKey, hostRef, scope: mutation.scope, patientRef: request.patient.patientRef, offerRef: request.offer.offerRef, payloadDigest: mutation.payloadDigest });
    this.bookingKeyByOffer.set(scopedOffer, mutation.actionKey);
    return { kind: "committed", actionKey: mutation.actionKey, hostRef };
  }

  async reconcile(mutation: HostMutation): Promise<ReconcileObservation> {
    const existing = this.bookingsByAction.get(mutation.actionKey);
    if (existing) {
      return existing.payloadDigest === mutation.payloadDigest && digestActionRequest(mutation.request) === existing.payloadDigest && sameScope(existing.scope, mutation.scope)
        ? { kind: "exactCommit", actionKey: mutation.actionKey, hostRef: existing.hostRef }
        : { kind: "stillUnknown", actionKey: mutation.actionKey };
    }
    return { kind: "definitiveNonCommit", actionKey: mutation.actionKey };
  }

  async openTask(item: StaffItem): Promise<StaffTaskReceipt> {
    const existing = this.tasksByKey.get(item.key);
    if (existing) {
      return sameScope(existing.scope, item.scope) && existing.payloadDigest === digestTurn(item)
        ? { kind: "opened", taskKey: item.key, hostTaskRef: existing.hostTaskRef, destination: existing.destination }
        : { kind: "rejected", taskKey: item.key };
    }
    const hostTaskRef = `reference-task:${item.key}`;
    this.tasksByKey.set(item.key, { taskKey: item.key, hostTaskRef, scope: item.scope, destination: item.destination, payloadDigest: digestTurn(item) });
    return { kind: "opened", taskKey: item.key, hostTaskRef, destination: item.destination };
  }

  async reconcileTask(item: StaffItem): Promise<StaffTaskObservation> {
    const existing = this.tasksByKey.get(item.key);
    if (!existing) return { kind: "definitiveNonOpen", taskKey: item.key };
    return sameScope(existing.scope, item.scope) && existing.payloadDigest === digestTurn(item)
      ? { kind: "exactOpen", taskKey: item.key, hostTaskRef: existing.hostTaskRef, destination: existing.destination }
      : { kind: "stillUnknown", taskKey: item.key };
  }

  bookings(scope: LocationScope): readonly Booking[] {
    return [...this.bookingsByAction.values()].filter(item => sameScope(item.scope, scope)).map(item => structuredClone(item));
  }

  bookingEvidenceReads(): number {
    return this.resolutionCount;
  }

  tasks(scope: LocationScope): readonly Task[] {
    return [...this.tasksByKey.values()].filter(item => sameScope(item.scope, scope)).map(item => structuredClone(item));
  }
}
