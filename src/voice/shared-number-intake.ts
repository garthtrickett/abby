import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { Admission, AdmissionReceipt, AdmissionResult, PendingLocationCall, Result, TransitionFailure } from "../core/model.ts";
import type { ClinicPolicyRouter } from "../reference/clinic-number-routing.ts";
import { CallAdmissionService, callIdFor } from "./admission.ts";
import type { AuthenticatedInboundCall, RouteFailure } from "./admission.ts";

export type SharedNumberIntakeResult =
  | Readonly<{ kind: "admitted"; admission: AdmissionResult }>
  | Readonly<{ kind: "locationChoice"; pending: PendingLocationCall; newReservation: boolean }>;

function validEvent(event: AuthenticatedInboundCall): boolean {
  return !!event?.key?.accountRef && !!event.key.providerCallRef && !!event.dialedNumber &&
    Number.isFinite(Date.parse(event.receivedAt));
}

function matchesEvent(admission: Admission, event: AuthenticatedInboundCall): boolean {
  return admission.key.accountRef === event.key.accountRef && admission.key.providerCallRef === event.key.providerCallRef &&
    admission.dialedNumber === event.dialedNumber;
}

function existingChoice(receipt: AdmissionReceipt, event: AuthenticatedInboundCall,
                        selectedLocationId?: string): Result<AdmissionResult, TransitionFailure | RouteFailure> {
  if (!matchesEvent(receipt.admission, event)) return err({ kind: "callConflict" });
  if (selectedLocationId !== undefined && receipt.scope.locationId !== selectedLocationId) return err({ kind: "invalidLocationChoice" });
  return ok({ kind: "duplicate", receipt });
}

/** Text-testable ingress; presentation and the pre-location media lease are separate ports. */
export class SharedNumberIntakeService {
  private readonly ledger: LedgerStore;
  private readonly router: ClinicPolicyRouter;
  private readonly admission: CallAdmissionService;
  private readonly now: () => string;

  constructor(ledger: LedgerStore, router: ClinicPolicyRouter, admission: CallAdmissionService,
              now: () => string = () => new Date().toISOString()) {
    this.ledger = ledger;
    this.router = router;
    this.admission = admission;
    this.now = now;
  }

  async begin(event: AuthenticatedInboundCall): Promise<Result<SharedNumberIntakeResult, TransitionFailure | RouteFailure>> {
    if (!validEvent(event)) return err({ kind: "invalidTransition" });
    const callId = callIdFor(event.key);
    const existing = await this.ledger.findAdmission(callId);
    if (!existing.ok) return existing;
    if (existing.value) {
      const duplicate = existingChoice(existing.value, event);
      return duplicate.ok ? ok({ kind: "admitted", admission: duplicate.value }) : duplicate;
    }
    const pending = await this.ledger.findPendingLocation(callId);
    if (!pending.ok) return pending;
    if (pending.value) {
      if (!matchesEvent(pending.value.admission, event)) return err({ kind: "callConflict" });
      if (pending.value.status === "expired") return err({ kind: "admissionExpired" });
      if (pending.value.status !== "pending") return err({ kind: "storageCorrupt" });
      return ok({ kind: "locationChoice", pending: pending.value, newReservation: false });
    }
    const identified = await this.router.identify(event.key.accountRef, event.dialedNumber);
    if (!identified.ok) return identified;
    if (identified.value.candidateLocationIds.length === 1) {
      const admitted = await this.admission.begin(event);
      return admitted.ok ? ok({ kind: "admitted", admission: admitted.value }) : admitted;
    }
    const acceptedAt = this.now();
    if (!Number.isFinite(Date.parse(acceptedAt))) return err({ kind: "invalidTransition" });
    const reservation = await this.ledger.reservePendingLocation(callId, {
      tenantId: identified.value.tenantId, clinicId: identified.value.clinicId,
      candidateLocationIds: identified.value.candidateLocationIds, routeVersion: identified.value.routeVersion,
    }, { key: event.key, dialedNumber: event.dialedNumber, acceptedAt,
      deadline: new Date(Date.parse(acceptedAt) + 120_000).toISOString() });
    if (reservation.ok) return reservation.value.pending.status === "pending"
      ? ok({ kind: "locationChoice", pending: reservation.value.pending, newReservation: reservation.value.kind === "created" })
      : err({ kind: reservation.value.pending.status === "expired" ? "admissionExpired" : "storageCorrupt" });
    if (reservation.error.kind !== "callConflict") return reservation;
    const raced = await this.ledger.findAdmission(callId);
    if (!raced.ok) return raced;
    if (raced.value) {
      const duplicate = existingChoice(raced.value, event);
      return duplicate.ok ? ok({ kind: "admitted", admission: duplicate.value }) : duplicate;
    }
    return reservation;
  }

  async choose(event: AuthenticatedInboundCall, selectedLocationId: string): Promise<Result<AdmissionResult, TransitionFailure | RouteFailure>> {
    if (!validEvent(event)) return err({ kind: "invalidTransition" });
    if (!selectedLocationId || !selectedLocationId.trim() || selectedLocationId.length > 256) return err({ kind: "invalidLocationChoice" });
    const callId = callIdFor(event.key);
    const existing = await this.ledger.findAdmission(callId);
    if (!existing.ok) return existing;
    if (existing.value) return existingChoice(existing.value, event, selectedLocationId);
    const pending = await this.ledger.findPendingLocation(callId);
    if (!pending.ok) return pending;
    if (!pending.value) return err({ kind: "callUnknown" });
    if (!matchesEvent(pending.value.admission, event)) return err({ kind: "callConflict" });
    if (pending.value.status === "expired") return err({ kind: "admissionExpired" });
    if (pending.value.status !== "pending") return err({ kind: "storageCorrupt" });
    if (!pending.value.route.candidateLocationIds.includes(selectedLocationId)) return err({ kind: "invalidLocationChoice" });
    const chosen = await this.router.resolveSelected(event.key.accountRef, event.dialedNumber, {
      tenantId: pending.value.route.tenantId, clinicId: pending.value.route.clinicId,
      locationId: selectedLocationId, routeVersion: pending.value.route.routeVersion,
    });
    if (!chosen.ok) return chosen;
    return this.admission.bindSelected(event, chosen.value);
  }
}
