import type { BookingHorizonHost } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err } from "../core/model.ts";
import type { FinalCallerTurn, LocationScope, TurnInterpretation } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

/** A read-only public query still supersedes an unsent proposal before waiting
 * for host IO. Public command time cannot revive the admitted lease. */
export class BookingHorizonTurns {
  private readonly ledger: LedgerStore;
  private readonly host: Partial<BookingHorizonHost>;
  private readonly clock: () => string;
  constructor(ledger: LedgerStore, host: Partial<BookingHorizonHost>, clock: () => string) { this.ledger = ledger; this.host = host; this.clock = clock; }
  enabled(): boolean { return typeof this.host.readBookingHorizon === "function"; }
  async run(scope: LocationScope, turn: FinalCallerTurn, expectedRevision?: number, external?: AbortSignal) {
    const signal = AbortSignal.any([AbortSignal.timeout(5_000), ...(external ? [external] : [])]);
    const runtime = new CallRuntime(this.ledger, scope);
    try {
      let initial = await awaitUntilAbort(runtime.read(turn.callId), signal);
      if (!initial) return err({ kind: "effectFailure" as const });
      if (!initial.ok) return initial;
      let now = this.clock();
      if (!this.enabled() || !Number.isFinite(Date.parse(now)) || turn.quality !== "clear" || !turn.sessionId) return err({ kind: "invalidTransition" as const });
      if (initial.value.lifecycle !== "active" ||
          initial.value.sessionLease?.sessionId !== turn.sessionId || Date.parse(initial.value.sessionLease.expiresAt) <= Date.parse(now)) return err({ kind: "leaseLost" as const });
      if (expectedRevision !== undefined && initial.value.conversationRevision !== expectedRevision) return err({ kind: "staleTurn" as const });
      if (initial.value.processedTurnIds.includes(turn.turnId)) return err({ kind: "keyMismatch" as const });
      if (Object.values(initial.value.actions).some(action => ["awaitingConfirmation", "ready"].includes(action.status))) {
        initial = await runtime.nonAffirmativeFinal(turn, initial.value.conversationRevision, now);
        if (!initial.ok) return initial;
      }
      const revision = initial.value.conversationRevision;
      let read: Awaited<ReturnType<BookingHorizonHost["readBookingHorizon"]>> | undefined;
      try { read = await awaitUntilAbort(this.host.readBookingHorizon!({ scope: { ...scope }, callId: turn.callId, sessionId: turn.sessionId,
        policyVersion: initial.value.policy.policyVersion, expectedConversationRevision: revision, signal }), signal); }
      catch { /* A host exception supplies no public approval evidence. */ }
      if (external?.aborted) return err({ kind: "staleTurn" as const });
      now = this.clock();
      if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" as const });
      const interpretation: TurnInterpretation = read?.ok && !signal.aborted ? { kind: "bookingHorizon", snapshot: structuredClone(read.value) } : { kind: "bookingHorizonFailure" };
      return runtime.acceptTurn(turn, interpretation, now, revision);
    } catch { return err({ kind: "effectFailure" as const }); }
  }
}
