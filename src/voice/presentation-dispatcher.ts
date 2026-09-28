import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, PendingPresentationRef, Result, TransitionFailure } from "../core/model.ts";
import type { DispatchResult, VoiceSession, VoiceSessionFailure } from "./voice-session.ts";

export type DeliveryAttempt =
  | Readonly<{ kind: "none" | "deferred" }>
  | Readonly<{ kind: "dispatched"; delivery: DispatchResult }>;
export type RecoveryReport = Readonly<{ scanned: number; dispatched: number; deferred: number }>;
export type SessionLookup = (ref: PendingPresentationRef) => VoiceSession | undefined;
export type DeliveryFailure = TransitionFailure | VoiceSessionFailure | Readonly<{ kind: "sessionRegistryUnavailable" }>;

export class PresentationDispatcher {
  private readonly ledger: LedgerStore;
  private readonly lookup: SessionLookup;
  private readonly scope: LocationScope | undefined;
  private scanCursor: string | undefined;

  constructor(ledger: LedgerStore, lookup: SessionLookup, scope?: LocationScope) {
    this.ledger = ledger;
    this.lookup = lookup;
    this.scope = scope;
  }

  private async attempt(ref: PendingPresentationRef, now: string): Promise<Result<DeliveryAttempt, DeliveryFailure>> {
    let session: VoiceSession | undefined;
    try { session = this.lookup(ref); } catch { return err({ kind: "sessionRegistryUnavailable" }); }
    if (!session) return ok({ kind: "deferred" });
    if (!session.matches(ref)) return err({ kind: "sessionUnknown" });
    const dispatched = await session.dispatchPending(now);
    if (dispatched.ok) return dispatched.value.kind === "none" ? ok({ kind: "none" }) : ok({ kind: "dispatched", delivery: dispatched.value });
    if (dispatched.error.kind === "deliveryBlocked" || dispatched.error.kind === "sessionUnknown" || dispatched.error.kind === "leaseLost") return ok({ kind: "deferred" });
    if (dispatched.error.kind === "invalidTransition" || dispatched.error.kind === "versionConflict") {
      const latest = await this.ledger.read(ref.callId, ref.scope);
      if (!latest.ok) return latest;
      if (latest.value.lifecycle !== "active" || latest.value.pendingPresentationId !== ref.presentationId) return ok({ kind: "none" });
    }
    return err(dispatched.error);
  }

  async wake(callId: string, scope: LocationScope, now: string): Promise<Result<DeliveryAttempt, DeliveryFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    if (this.scope && (this.scope.tenantId !== scope.tenantId || this.scope.clinicId !== scope.clinicId || this.scope.locationId !== scope.locationId)) return err({ kind: "scopeMismatch" });
    const state = await this.ledger.read(callId, scope);
    if (!state.ok) return state;
    const pendingId = state.value.pendingPresentationId;
    const lease = state.value.sessionLease;
    if (state.value.lifecycle !== "active" || !state.value.admission || !lease || !pendingId) return ok({ kind: "none" });
    return this.attempt({ callId, scope, sessionId: lease.sessionId, presentationId: pendingId }, now);
  }

  async recover(now: string): Promise<Result<RecoveryReport, DeliveryFailure>> {
    let found = await this.ledger.findPendingPresentations(now, this.scope, this.scanCursor);
    if (!found.ok) return found;
    if (found.value.length === 0 && this.scanCursor) {
      this.scanCursor = undefined;
      found = await this.ledger.findPendingPresentations(now, this.scope);
      if (!found.ok) return found;
    }
    const refs = found.value;
    let dispatched = 0;
    let deferred = 0;
    for (let index = 0; index < refs.length; index += 4) {
      const outcomes = await Promise.all(refs.slice(index, index + 4).map(ref => this.attempt(ref, now)));
      for (const outcome of outcomes) {
        if (!outcome.ok) return outcome;
        if (outcome.value.kind === "dispatched") dispatched += 1;
        if (outcome.value.kind === "deferred") deferred += 1;
      }
    }
    if (refs.length > 0) this.scanCursor = refs[refs.length - 1]!.callId;
    return ok({ scanned: refs.length, dispatched, deferred });
  }
}
