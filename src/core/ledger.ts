import { err, ok } from "./model.ts";
import type { ActiveSessionReceipt, Admission, AdmissionReceipt, AdmissionResult, CallPolicy, CallState, LocationScope, PendingPresentationRef, Result, TransitionAction, TransitionFailure } from "./model.ts";
import { transition } from "./transition.ts";

export interface LedgerStore {
  start(callId: string, policy: CallPolicy): Promise<Result<CallState, TransitionFailure>>;
  findAdmission(callId: string): Promise<Result<AdmissionReceipt | null, TransitionFailure>>;
  findExpiredAdmissions(now: string, scope?: LocationScope): Promise<Result<readonly AdmissionReceipt[], TransitionFailure>>;
  findExpiredSessions(now: string, scope?: LocationScope): Promise<Result<readonly ActiveSessionReceipt[], TransitionFailure>>;
  findPendingPresentations(now: string, scope?: LocationScope, afterCallId?: string): Promise<Result<readonly PendingPresentationRef[], TransitionFailure>>;
  admit(callId: string, policy: CallPolicy, admission: Admission): Promise<Result<AdmissionResult, TransitionFailure>>;
  read(callId: string, scope: LocationScope): Promise<Result<CallState, TransitionFailure>>;
  apply(callId: string, scope: LocationScope, expectedVersion: number, action: TransitionAction): Promise<Result<CallState, TransitionFailure>>;
}

export function initialState(callId: string, policy: CallPolicy): CallState {
  return {
    callId,
    policy: structuredClone(policy),
    lifecycle: "active",
    version: 0,
    conversationRevision: 0,
    processedTurnIds: [],
    processedTurnDigests: {},
    actions: {},
    presentations: {},
    effects: {},
    staffItems: {},
    callerMessages: [],
    knowledgeAnswers: [],
  };
}

export function admissionReceipt(state: CallState): AdmissionReceipt | null {
  return state.admission ? { callId: state.callId, scope: structuredClone(state.policy.scope), admission: structuredClone(state.admission), lifecycle: state.lifecycle } : null;
}

export function sameAdmission(left: Admission, right: Admission): boolean {
  return left.key.accountRef === right.key.accountRef && left.key.providerCallRef === right.key.providerCallRef && left.dialedNumber === right.dialedNumber;
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

  async findAdmission(callId: string): Promise<Result<AdmissionReceipt | null, TransitionFailure>> {
    return ok(this.calls.has(callId) ? admissionReceipt(this.calls.get(callId)!) : null);
  }

  async findExpiredAdmissions(now: string, scope?: LocationScope): Promise<Result<readonly AdmissionReceipt[], TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    return ok([...this.calls.values()].filter(state => (!scope || sameScope(state.policy.scope, scope)) && state.lifecycle === "starting" && state.admission && Date.parse(state.admission.deadline) <= Date.parse(now))
      .slice(0, 100).map(state => admissionReceipt(state)!));
  }

  async findExpiredSessions(now: string, scope?: LocationScope): Promise<Result<readonly ActiveSessionReceipt[], TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    return ok([...this.calls.values()].filter(state => (!scope || sameScope(state.policy.scope, scope)) && state.lifecycle === "active" && state.sessionLease && Date.parse(state.sessionLease.expiresAt) <= Date.parse(now))
      .slice(0, 100).map(state => ({ callId: state.callId, scope: structuredClone(state.policy.scope), lease: structuredClone(state.sessionLease!) })));
  }

  async findPendingPresentations(now: string, scope?: LocationScope, afterCallId?: string): Promise<Result<readonly PendingPresentationRef[], TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    const refs = [...this.calls.values()]
      .filter(state => (!scope || sameScope(state.policy.scope, scope)) && (!afterCallId || state.callId > afterCallId) &&
        state.lifecycle === "active" && state.admission && state.sessionLease && Date.parse(state.sessionLease.expiresAt) > Date.parse(now) && state.pendingPresentationId)
      .sort((left, right) => left.callId < right.callId ? -1 : left.callId > right.callId ? 1 : 0).slice(0, 100);
    return ok(refs.map(state => ({ callId: state.callId, scope: structuredClone(state.policy.scope), sessionId: state.sessionLease!.sessionId,
      presentationId: state.pendingPresentationId! })));
  }

  async admit(callId: string, policy: CallPolicy, admission: Admission): Promise<Result<AdmissionResult, TransitionFailure>> {
    if (!callId || !admission.key.accountRef || !admission.key.providerCallRef || !admission.dialedNumber ||
        !Number.isFinite(Date.parse(admission.acceptedAt)) || Date.parse(admission.deadline) <= Date.parse(admission.acceptedAt)) return err({ kind: "invalidTransition" });
    const existing = this.calls.get(callId);
    if (existing) {
      const receipt = admissionReceipt(existing);
      return receipt && sameAdmission(receipt.admission, admission)
        ? ok({ kind: "duplicate", receipt }) : err({ kind: "callConflict" });
    }
    const state = initialState(callId, policy);
    state.lifecycle = "starting";
    state.admission = structuredClone(admission);
    this.calls.set(callId, state);
    return ok({ kind: "created", receipt: admissionReceipt(state)! });
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
