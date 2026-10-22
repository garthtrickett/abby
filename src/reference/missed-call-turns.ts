import type { MissedCallContextHost } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err } from "../core/model.ts";
import type { FinalCallerTurn, LocationScope, TurnInterpretation } from "../core/model.ts";
import { readMissedCallContext } from "../core/missed-call.ts";
import { CallRuntime } from "../core/runtime.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

/** Owns one incoming reason read and its revision fence. The host supplies only
 * independently authorized facts; unavailable evidence keeps the public reply. */
export class MissedCallTurns {
  private readonly ledger: LedgerStore;
  private readonly host: Partial<MissedCallContextHost>;
  private readonly clock: () => string;
  constructor(ledger: LedgerStore, host: Partial<MissedCallContextHost>, clock: () => string) {
    this.ledger = ledger; this.host = host; this.clock = clock;
  }

  async respond(scope: LocationScope, turn: FinalCallerTurn, expected?: number, external?: AbortSignal) {
    const runtime = new CallRuntime(this.ledger, scope);
    try {
      let now = this.clock();
      if (!Number.isFinite(Date.parse(now)) || !turn.sessionId || turn.quality !== "clear") return err({ kind: "invalidTransition" as const });
      let state = await runtime.read(turn.callId); if (!state.ok) return state;
      if (state.value.lifecycle !== "active" || state.value.sessionLease?.sessionId !== turn.sessionId ||
          Date.parse(state.value.sessionLease.expiresAt) <= Date.parse(now)) return err({ kind: "leaseLost" as const });
      if (state.value.processedTurnIds.includes(turn.turnId)) return state;
      if (expected !== undefined && state.value.conversationRevision !== expected) return err({ kind: "staleTurn" as const });
      const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
      if (signal.aborted) return err({ kind: "staleTurn" as const });
      if (!this.host.readMissedCallContext || state.value.callerIdentityDenied || state.value.admission?.direction === "outbound")
        return runtime.acceptTurn(turn, { kind: "missedCallReasonUnavailable" }, now, state.value.conversationRevision);
      if (Object.values(state.value.actions).some(action => ["awaitingConfirmation", "ready"].includes(action.status))) {
        state = await runtime.nonAffirmativeFinal(turn, state.value.conversationRevision, now); if (!state.ok) return state;
      }
      const began = now;
      let read: Awaited<ReturnType<MissedCallContextHost["readMissedCallContext"]>> | undefined;
      try {
        read = await awaitUntilAbort(this.host.readMissedCallContext({ scope, callId: turn.callId, sessionId: turn.sessionId,
          policyVersion: state.value.policy.policyVersion, turnId: turn.turnId,
          expectedConversationRevision: state.value.conversationRevision, now, signal }), signal);
      } catch { /* No verified context: preserve the unknown-reason reply. */ }
      if (external?.aborted) return err({ kind: "staleTurn" as const });
      now = this.clock();
      if (!Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(began)) return err({ kind: "invalidTransition" as const });
      const context = read?.ok && !signal.aborted ? readMissedCallContext(read.value, state.value, turn, now) : undefined;
      const interpretation: TurnInterpretation = context && Date.parse(context.checkedAt) >= Date.parse(began)
        ? { kind: "missedCallContext", context } : { kind: "missedCallReasonUnavailable" };
      return runtime.acceptTurn(turn, interpretation, now, state.value.conversationRevision);
    } catch { return err({ kind: "effectFailure" as const }); }
  }
}
