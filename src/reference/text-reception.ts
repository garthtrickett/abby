import { EffectWorker } from "../core/effect-worker.ts";
import type { AvailabilityHost, BookingEvidenceHost, HostEffects, KnowledgeHost, PolicyFailure, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err } from "../core/model.ts";
import type { CallState, FinalCallerTurn, LocationScope, Result, TransitionFailure, TurnInterpretation } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";

export type TextHost = BookingEvidenceHost & HostEffects & KnowledgeHost;
export type TextReceptionFailure = TransitionFailure | PolicyFailure | Readonly<{ kind: "effectFailure" }>;

export class TextReception {
  private readonly ledger: LedgerStore;
  private readonly policy: PolicyStore;
  private readonly host: TextHost;
  private readonly availability: AvailabilityHost | undefined;

  constructor(ledger: LedgerStore, policy: PolicyStore, host: TextHost, availability?: AvailabilityHost) {
    this.ledger = ledger;
    this.policy = policy;
    this.host = host;
    this.availability = availability;
  }

  availabilityEnabled(): boolean { return this.availability !== undefined; }

  private runtime(scope: LocationScope): CallRuntime {
    return new CallRuntime(this.ledger, scope);
  }

  async startCall(callId: string, scope: LocationScope): Promise<Result<CallState, TextReceptionFailure>> {
    const policy = await this.policy.read(scope);
    if (!policy.ok) return policy;
    return this.runtime(scope).start(callId, policy.value);
  }

  async proposeBooking(scope: LocationScope, turn: FinalCallerTurn, verificationRef: string, offerRef: string, now: string, expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    if (current.value.policy.capabilities.book === "unavailable") {
      return runtime.acceptTurn(turn, { kind: "unavailableAction", actionKind: "book" }, now, expectedConversationRevision);
    }
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear") {
      interpretation = { kind: "ambiguousTarget" };
    } else {
      const evidence = await this.host.resolveBooking(scope, verificationRef, offerRef, now);
      if (evidence.ok) {
        interpretation = { kind: "requestAction", request: evidence.value };
      } else if (evidence.error.kind === "ambiguous" || evidence.error.kind === "expired") {
        interpretation = { kind: "ambiguousTarget" };
      } else {
        interpretation = { kind: "readFailure", target: evidence.error.target, failure: evidence.error.kind === "unavailable" ? "unavailable" : "notFound" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async answer(scope: LocationScope, turn: FinalCallerTurn, sourceRefs: readonly string[], proposedText: string, now: string, expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear" || !Array.isArray(sourceRefs) || sourceRefs.length < 1 || sourceRefs.length > 8 ||
        sourceRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 256) || new Set(sourceRefs).size !== sourceRefs.length ||
        typeof proposedText !== "string" || !proposedText.trim() || proposedText.length > 2_000) {
      interpretation = { kind: "knowledgeFailure", reason: "invalidQuery" };
    } else {
      try {
        const read = await this.host.readKnowledge(scope, sourceRefs);
        interpretation = read.ok
          ? { kind: "answer", sources: read.value, proposedText }
          : { kind: "knowledgeFailure", reason: read.error.kind };
      } catch {
        interpretation = { kind: "knowledgeFailure", reason: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async checkAvailability(scope: LocationScope, turn: FinalCallerTurn, from: string, to: string, now: string, expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear") {
      interpretation = { kind: "availabilityFailure", reason: "unclear" };
    } else if (typeof from !== "string" || typeof to !== "string" || !this.availability) {
      interpretation = { kind: "availabilityFailure", reason: this.availability ? "invalidRange" : "notConfigured" };
    } else {
      try {
        const read = await this.availability.list(scope, from, to);
        if (!read.ok) interpretation = { kind: "availabilityFailure", reason: read.error.kind };
        else if (read.value.kind === "times") interpretation = { kind: "availability", from, to, snapshot: read.value };
        else interpretation = { kind: "availabilityFailure", reason: "notEligible" };
      } catch {
        interpretation = { kind: "availabilityFailure", reason: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async acknowledgeTextPresentation(scope: LocationScope, callId: string, presentationId: string): Promise<Result<CallState, TransitionFailure>> {
    const runtime = this.runtime(scope);
    const started = await runtime.startPresentation(callId, presentationId);
    if (!started.ok) return started;
    return runtime.resolvePresentation(callId, presentationId, "played");
  }

  affirm(scope: LocationScope, turn: FinalCallerTurn, actionKey: string, digest: string, now: string, expectedConversationRevision?: number): Promise<Result<CallState, TransitionFailure>> {
    return this.runtime(scope).acceptTurn(turn, { kind: "affirm", actionKey, digest, affirmative: true }, now, expectedConversationRevision);
  }

  async drain(scope: LocationScope, callId: string, now: string): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const read = await runtime.read(callId);
    if (!read.ok) return read;
    const worker = new EffectWorker(runtime, this.host);
    for (const effect of Object.values(read.value.effects)) {
      if (effect.status !== "pending") continue;
      try {
        await worker.process(callId, effect.id, now);
      } catch {
        return err({ kind: "effectFailure" });
      }
    }
    return runtime.read(callId);
  }

  read(scope: LocationScope, callId: string): Promise<Result<CallState, TransitionFailure>> {
    return this.runtime(scope).read(callId);
  }
}
