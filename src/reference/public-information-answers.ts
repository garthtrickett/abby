import type { KnowledgeHost } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err } from "../core/model.ts";
import type { FinalCallerTurn, LocationScope, TurnInterpretation } from "../core/model.ts";
import type { PublicInformationTopic } from "../core/public-information.ts";
import { CallRuntime } from "../core/runtime.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

/** One scoped, interruptible public read. Clock, proposal cancellation and
 * revision fences are owned here, not supplied by the querying agent. */
export class PublicInformationAnswers {
  private readonly ledger: LedgerStore;
  private readonly host: KnowledgeHost;
  private readonly clock: () => string;
  constructor(ledger: LedgerStore, host: KnowledgeHost, clock: () => string) { this.ledger = ledger; this.host = host; this.clock = clock; }
  async run(scope: LocationScope, turn: FinalCallerTurn, topic: PublicInformationTopic, proposedText: string, expected?: number, external?: AbortSignal) {
    const signal = AbortSignal.any([AbortSignal.timeout(5_000), ...(external ? [external] : [])]), runtime = new CallRuntime(this.ledger, scope);
    try {
      let initial = await awaitUntilAbort(runtime.read(turn.callId), signal);
      if (!initial) return err({ kind: "effectFailure" as const });
      if (!initial.ok) return initial;
      let now = this.clock();
      if (turn.quality !== "clear" || !Number.isFinite(Date.parse(now)) || typeof proposedText !== "string" || !proposedText.trim() || proposedText.length > 2_000)
        return err({ kind: "invalidTransition" as const });
      if (initial.value.lifecycle !== "active" || initial.value.admission && (!initial.value.sessionLease || initial.value.sessionLease.sessionId !== turn.sessionId || Date.parse(initial.value.sessionLease.expiresAt) <= Date.parse(now)))
        return err({ kind: "leaseLost" as const });
      if (expected !== undefined && initial.value.conversationRevision !== expected) return err({ kind: "staleTurn" as const });
      if (initial.value.processedTurnIds.includes(turn.turnId)) return err({ kind: "keyMismatch" as const });
      if (initial.value.admission && Object.values(initial.value.actions).some(action => ["awaitingConfirmation", "ready"].includes(action.status))) {
        initial = await runtime.nonAffirmativeFinal(turn, initial.value.conversationRevision, now);
        if (!initial.ok) return initial;
      }
      let read: Awaited<ReturnType<KnowledgeHost["readKnowledge"]>> | undefined;
      try { read = await awaitUntilAbort(this.host.readKnowledge(scope, [`clinic-public-${topic}`]), signal); } catch { /* No approval evidence. */ }
      if (external?.aborted) return err({ kind: "staleTurn" as const });
      now = this.clock(); if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" as const });
      const interpretation: TurnInterpretation = read?.ok && !signal.aborted
        ? { kind: "answer", sources: read.value, proposedText, publicTopic: topic }
        : { kind: "knowledgeFailure", reason: "unavailable", publicTopic: topic };
      return runtime.acceptTurn(turn, interpretation, now, initial.value.conversationRevision);
    } catch { return err({ kind: "effectFailure" as const }); }
  }
}
