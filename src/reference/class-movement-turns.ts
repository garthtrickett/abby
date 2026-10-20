import type { ClassMovementContinuationHost, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import type { CallState, FinalCallerTurn, LocationScope, Result, TransitionFailure } from "../core/model.ts";
import { err } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

/** The caller can ask to continue only the one live pending move. The private
 * owner selects its next phase. Preparation and code entry never admit a send. */
export class ClassMovementTurns {
  readonly #ledger: LedgerStore; readonly #policies: PolicyStore;
  readonly #host: Partial<ClassMovementContinuationHost>; readonly #clock: () => string;
  constructor(ledger: LedgerStore, policies: PolicyStore, host: Partial<ClassMovementContinuationHost>, clock: () => string) {
    this.#ledger = ledger; this.#policies = policies; this.#host = host; this.#clock = clock;
  }

  async run(scope: LocationScope, turn: FinalCallerTurn, expectedRevision?: number, external?: AbortSignal):
    Promise<Result<CallState, TransitionFailure | Readonly<{ kind: "effectFailure" }>>> {
    if (!this.#host.prepareClassMovement || !turn.sessionId || turn.quality !== "clear") return err({ kind: "invalidTransition" });
    const runtime = new CallRuntime(this.#ledger, scope), signal = AbortSignal.any([AbortSignal.timeout(15000), ...(external ? [external] : [])]);
    try {
      const startedAt = Date.parse(this.#clock());
      if (!Number.isFinite(startedAt) || !Number.isFinite(Date.parse(turn.at)) || startedAt < Date.parse(turn.at)) return err({ kind: "invalidTransition" });
      const ready = async () => {
        const found = await awaitUntilAbort(runtime.read(turn.callId), signal);
        const checked = await awaitUntilAbort(Promise.all([this.#policies.read(scope), this.#ledger.readWriteStop(scope)]), signal);
        const at = Date.parse(this.#clock());
        if (!found?.ok || !checked || signal.aborted || !Number.isFinite(at) || at < startedAt) return undefined;
        const [policy, stop] = checked, lease = found.value.sessionLease;
        const valid = (p: CallState["policy"]) => p.automationEnabled && p.reschedulingEnabled && p.staffWorkEnabled && p.capabilities.reschedule === "execute";
        return policy.ok && stop.ok && !stop.value.stopped && valid(policy.value) && valid(found.value.policy) &&
          policy.value.policyVersion === found.value.policy.policyVersion && found.value.lifecycle === "active" && !found.value.callerIdentityDenied &&
          lease !== undefined && lease.sessionId === turn.sessionId && Date.parse(lease.expiresAt) > at ? found.value : undefined;
      };
      const before = await ready();
      if (!before) return err({ kind: external?.aborted ? "staleTurn" : "invalidTransition" });
      if (before.processedTurnIds.includes(turn.turnId)) return { ok: true, value: before };
      if (expectedRevision !== undefined && expectedRevision !== before.conversationRevision) return err({ kind: "staleTurn" });
      const pending = Object.values(before.actions).filter(action => action.kind === "reschedule" && action.status === "pendingContinuation" && action.classMovement?.outcome === "pending");
      if (pending.length !== 1 || before.pendingPresentationId) return err({ kind: "confirmationMissing" });
      const prepared = await awaitUntilAbort(this.#host.prepareClassMovement({ scope, callId: turn.callId, sessionId: turn.sessionId,
        policyVersion: before.policy.policyVersion, actionKey: pending[0]!.key, now: this.#clock(), signal }), signal);
      const after = await ready();
      if (external?.aborted) return err({ kind: "staleTurn" });
      if (!prepared?.ok || !after || signal.aborted) return err({ kind: "effectFailure" });
      if (after.conversationRevision !== before.conversationRevision || after.pendingPresentationId ||
          after.actions[pending[0]!.key]?.status !== "pendingContinuation") return err({ kind: "staleTurn" });
      return runtime.acceptTurn(turn, { kind: "classMovementPreparation", actionKey: pending[0]!.key, preparation: prepared.value },
        this.#clock(), before.conversationRevision);
    } catch { return err({ kind: external?.aborted ? "staleTurn" : "effectFailure" }); }
  }
}
