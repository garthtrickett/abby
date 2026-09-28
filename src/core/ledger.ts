import { err, ok } from "./model.ts";
import type { CallPolicy, CallState, LocationScope, Result, TransitionAction, TransitionFailure } from "./model.ts";
import { transition } from "./transition.ts";

export interface LedgerStore {
  start(callId: string, policy: CallPolicy): Promise<Result<CallState, TransitionFailure>>;
  read(callId: string, scope: LocationScope): Promise<Result<CallState, TransitionFailure>>;
  apply(callId: string, scope: LocationScope, expectedVersion: number, action: TransitionAction): Promise<Result<CallState, TransitionFailure>>;
}

export function initialState(callId: string, policy: CallPolicy): CallState {
  return {
    callId,
    policy: structuredClone(policy),
    version: 0,
    conversationRevision: 0,
    processedTurnIds: [],
    processedTurnDigests: {},
    actions: {},
    presentations: {},
    effects: {},
    staffItems: {},
    callerMessages: [],
  };
}

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

export class MemoryLedger implements LedgerStore {
  private readonly calls = new Map<string, CallState>();

  async start(callId: string, policy: CallPolicy): Promise<Result<CallState, TransitionFailure>> {
    if (!callId || this.calls.has(callId)) return err({ kind: "invalidTransition" });
    const state = initialState(callId, policy);
    this.calls.set(callId, state);
    return ok(structuredClone(state));
  }

  async read(callId: string, scope: LocationScope): Promise<Result<CallState, TransitionFailure>> {
    const state = this.calls.get(callId);
    return state && sameScope(state.policy.scope, scope) ? ok(structuredClone(state)) : err({ kind: "callUnknown" });
  }

  async apply(callId: string, scope: LocationScope, expectedVersion: number, action: TransitionAction): Promise<Result<CallState, TransitionFailure>> {
    const current = this.calls.get(callId);
    if (!current || !sameScope(current.policy.scope, scope)) return err({ kind: "callUnknown" });
    if (current.version !== expectedVersion) return err({ kind: "versionConflict" });
    const result = transition(current, action);
    if (!result.ok) return result;
    this.calls.set(callId, structuredClone(result.value));
    return ok(structuredClone(result.value));
  }
}
