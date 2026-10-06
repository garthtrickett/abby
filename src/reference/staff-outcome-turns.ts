import type { PolicyStore, StaffReviewProcessHost } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import type { FinalCallerTurn, LocationScope } from "../core/model.ts";
import { err } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

/** Existing SAM receipts supply the outcome; optional current host process
 * evidence supplies only public review expectations, never a send or receipt. */
export class StaffOutcomeTurns {
  private readonly ledger: LedgerStore;
  private readonly policies: PolicyStore;
  private readonly host: Partial<StaffReviewProcessHost>;
  private readonly clock: () => string;
  constructor(ledger: LedgerStore, policies: PolicyStore, host: Partial<StaffReviewProcessHost>, clock: () => string) {
    this.ledger = ledger; this.policies = policies; this.host = host; this.clock = clock;
  }
  async run(incomingScope: LocationScope, incomingTurn: FinalCallerTurn, expectedRevision?: number, external?: AbortSignal) {
    const scope = Object.freeze({ ...incomingScope }), turn = Object.freeze(structuredClone(incomingTurn));
    const signal = AbortSignal.any([AbortSignal.timeout(5_000), ...(external ? [external] : [])]), runtime = new CallRuntime(this.ledger, scope);
    try {
      let initial = await awaitUntilAbort(runtime.read(turn.callId), signal);
      if (!initial) return err({ kind: "effectFailure" as const }); if (!initial.ok) return initial;
      let now = this.clock();
      if (!Number.isFinite(Date.parse(now)) || !turn.sessionId || turn.quality !== "clear") return err({ kind: "invalidTransition" as const });
      if (initial.value.lifecycle !== "active" || initial.value.sessionLease?.sessionId !== turn.sessionId || Date.parse(initial.value.sessionLease.expiresAt) <= Date.parse(now)) return err({ kind: "leaseLost" as const });
      if (expectedRevision !== undefined && initial.value.conversationRevision !== expectedRevision || external?.aborted) return err({ kind: "staleTurn" as const });
      if (initial.value.processedTurnIds.includes(turn.turnId)) return initial;
      if (!initial.value.callerIdentityDenied && Object.values(initial.value.actions).some(action => ["awaitingConfirmation", "ready"].includes(action.status))) {
        initial = await runtime.nonAffirmativeFinal(turn, initial.value.conversationRevision, now); if (!initial.ok) return initial;
      }
      const revision = initial.value.conversationRevision, item = Object.values(initial.value.staffItems).filter(item => item.reason === "callerRequested").at(-1);
      let read: Awaited<ReturnType<StaffReviewProcessHost["readStaffReviewProcess"]>> | undefined;
      if (!initial.value.callerIdentityDenied && item?.status === "open" && this.host.readStaffReviewProcess) {
        try { read = await awaitUntilAbort(this.host.readStaffReviewProcess({ scope, callId: turn.callId, sessionId: turn.sessionId,
          policyVersion: initial.value.policy.policyVersion, taskKey: item.key, expectedConversationRevision: revision, signal }), signal); } catch { /* No current public process evidence. */ }
      }
      if (read?.ok) {
        try {
          const policy = await awaitUntilAbort(this.policies.read(scope), signal);
          if (!policy?.ok || !policy.value.automationEnabled || policy.value.staffWorkEnabled !== true || policy.value.policyVersion !== initial.value.policy.policyVersion ||
              policy.value.scope.tenantId !== scope.tenantId || policy.value.scope.clinicId !== scope.clinicId || policy.value.scope.locationId !== scope.locationId) read = undefined;
        } catch { read = undefined; }
      }
      if (external?.aborted) return err({ kind: "staleTurn" as const });
      now = this.clock(); if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" as const });
      return runtime.acceptTurn(turn, { kind: "staffOutcomeQuery", ...(read?.ok && !signal.aborted ? { reviewProcess: structuredClone(read.value) } : {}) }, now, revision);
    } catch { return err({ kind: "effectFailure" as const }); }
  }
}
