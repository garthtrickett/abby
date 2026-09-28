import { err, ok } from "./model.ts";
import type { CallPolicy, CallState, Result, TransitionAction, TransitionFailure } from "./model.ts";
import { transition } from "./transition.ts";

export interface LedgerStore {
  start(callId: string, policy: CallPolicy): Result<CallState, TransitionFailure>;
  read(callId: string): Result<CallState, TransitionFailure>;
  apply(callId: string, expectedVersion: number, action: TransitionAction): Result<CallState, TransitionFailure>;
}

export class MemoryLedger implements LedgerStore {
  private readonly calls = new Map<string, CallState>();

  start(callId: string, policy: CallPolicy): Result<CallState, TransitionFailure> {
    if (!callId || this.calls.has(callId)) return err({ kind: "invalidTransition" });
    const state: CallState = {
      callId,
      policy: structuredClone(policy),
      version: 0,
      conversationRevision: 0,
      processedTurnIds: [],
      actions: {},
      presentations: {},
      effects: {},
      staffItems: {},
      callerMessages: [],
    };
    this.calls.set(callId, state);
    return ok(structuredClone(state));
  }

  read(callId: string): Result<CallState, TransitionFailure> {
    const state = this.calls.get(callId);
    return state ? ok(structuredClone(state)) : err({ kind: "callUnknown" });
  }

  apply(callId: string, expectedVersion: number, action: TransitionAction): Result<CallState, TransitionFailure> {
    const current = this.calls.get(callId);
    if (!current) return err({ kind: "callUnknown" });
    if (current.version !== expectedVersion) return err({ kind: "versionConflict" });
    const result = transition(current, action);
    if (!result.ok) return result;
    this.calls.set(callId, structuredClone(result.value));
    return ok(structuredClone(result.value));
  }
}
