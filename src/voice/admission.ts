import type { LedgerStore } from "../core/ledger.ts";
import { pendingCallId, policyMatchesPending } from "../core/pending-location.ts";
import type { ModelKnowledgeContextHost } from "../core/host.ts";
import { captureKnowledgeSnapshot, validKnowledgeSnapshot } from "../core/knowledge-evidence.ts";
import { err, ok } from "../core/model.ts";
import type { Admission, AdmissionReceipt, AdmissionResult, CallPolicy, ProviderCallKey, Result, TransitionFailure } from "../core/model.ts";
import { unprovenReadiness } from "../core/readiness.ts";
import { validApprovedGreeting } from "../core/greeting.ts";
import { expandStaffSchedule, validApprovedStaffSchedule, validStaffScheduleApproval } from "../core/staff-schedule.ts";
import type { AutomationReadiness } from "../core/readiness.ts";

// The transport adapter authenticates the provider account before constructing this event.
export type AuthenticatedInboundCall = Readonly<{
  key: ProviderCallKey;
  dialedNumber: string;
  /** Untrusted caller-ID clue. It is never copied into the durable Admission. */
  presentedCallerNumber?: string;
  receivedAt: string;
}>;

export type RouteFailure = Readonly<{ kind: "routeUnavailable" | "unknownNumber" | "ambiguousClinic" | "locationChoiceRequired" |
  "locationChoicePending" | "invalidLocationChoice" | "staleLocationChoice" | "automationDisabled" | "readinessFailed" }>;
export type PolicyResolver = (dialedNumber: string, accountRef: string) => Promise<Result<CallPolicy, RouteFailure>>;

export function callIdFor(key: ProviderCallKey): string {
  return pendingCallId(key);
}

function duplicateOrConflict(receipt: AdmissionReceipt, event: AuthenticatedInboundCall): Result<AdmissionResult, TransitionFailure> {
  const original = receipt.admission;
  return original.key.accountRef === event.key.accountRef && original.key.providerCallRef === event.key.providerCallRef && original.dialedNumber === event.dialedNumber
    ? ok({ kind: "duplicate", receipt }) : err({ kind: "callConflict" });
}

function sameScope(left: CallPolicy["scope"], right: CallPolicy["scope"]): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

export class CallAdmissionService {
  private readonly ledger: LedgerStore;
  private readonly resolvePolicy: PolicyResolver;
  private readonly now: () => string;
  private readonly readiness: AutomationReadiness;
  private readonly knowledge: ModelKnowledgeContextHost | undefined;

  constructor(ledger: LedgerStore, resolvePolicy: PolicyResolver, now: () => string = () => new Date().toISOString(), readiness: AutomationReadiness = unprovenReadiness,
              knowledge?: ModelKnowledgeContextHost) {
    this.ledger = ledger;
    this.resolvePolicy = resolvePolicy;
    this.now = now;
    this.readiness = readiness;
    this.knowledge = knowledge;
  }

  private async preparePolicy(policy: CallPolicy): Promise<Result<Readonly<{ policy: CallPolicy; acceptedAt: string }>, RouteFailure | TransitionFailure>> {
    if (policy.automationEnabled !== true) return err({ kind: "automationDisabled" });
    if (!validApprovedGreeting(policy)) return err({ kind: "readinessFailed" });
    let ready = false;
    try {
      const checked = await this.readiness(policy.scope);
      ready = checked.ok && checked.value === true;
    } catch { ready = false; }
    if (!ready) return err({ kind: "readinessFailed" });
    const acceptedAt = this.now();
    if (!Number.isFinite(Date.parse(acceptedAt))) return err({ kind: "invalidTransition" });
    let callPolicy = policy;
    if (policy.staffSchedule !== undefined) {
      const { staffSchedule, staffedCoverage: staleCoverage, staffedIntervals: staleIntervals, ...base } = policy;
      void staleCoverage; void staleIntervals;
      callPolicy = base;
      try {
        if (validApprovedStaffSchedule(staffSchedule, policy.scope) &&
            validStaffScheduleApproval(staffSchedule, policy.scope, acceptedAt)) {
          const through = new Date(Math.min(Date.parse(acceptedAt) + 72 * 60 * 60 * 1_000,
            Date.parse(staffSchedule.effectiveUntil))).toISOString();
          const expanded = expandStaffSchedule(staffSchedule, acceptedAt, through);
          if (expanded.ok) callPolicy = { ...base, staffSchedule: structuredClone(staffSchedule), ...expanded.value };
        }
      } catch { /* Invalid host hours leave transfer and closed-hours claims unavailable. */ }
    }
    if (this.knowledge) {
      const captured = await captureKnowledgeSnapshot(this.knowledge, callPolicy.scope, acceptedAt);
      if (!captured.ok) return err({ kind: "routeUnavailable" });
      callPolicy = { ...callPolicy, knowledgeSnapshot: captured.value };
    }
    if (callPolicy.knowledgeSnapshot !== undefined && !validKnowledgeSnapshot(callPolicy.knowledgeSnapshot)) {
      return err({ kind: "routeUnavailable" });
    }
    return ok({ policy: callPolicy, acceptedAt });
  }

  private async selectedReplay(receipt: AdmissionReceipt, event: AuthenticatedInboundCall, policy: CallPolicy,
                               sessionId: string, expectedLeaseVersion: number, turnId: string): Promise<Result<AdmissionResult, TransitionFailure | RouteFailure>> {
    const replay = duplicateOrConflict(receipt, event);
    if (!replay.ok) return replay;
    if (!sameScope(receipt.scope, policy.scope)) return err({ kind: "invalidLocationChoice" });
    const pending = await this.ledger.findPendingLocation(receipt.callId);
    if (!pending.ok) return pending;
    return pending.value?.choiceEvidence?.sessionId === sessionId && pending.value.choiceEvidence.leaseVersion === expectedLeaseVersion &&
      pending.value.choiceEvidence.turnId === turnId
      ? replay : err({ kind: "keyMismatch" });
  }

  /** Completes a previously reserved shared-number call after trusted location selection. */
  async bindSelected(event: AuthenticatedInboundCall, policy: CallPolicy, sessionId: string,
                     expectedLeaseVersion: number, turnId: string): Promise<Result<AdmissionResult, TransitionFailure | RouteFailure>> {
    if (!event.key.accountRef || !event.key.providerCallRef || !event.dialedNumber || !Number.isFinite(Date.parse(event.receivedAt))) {
      return err({ kind: "invalidTransition" });
    }
    const callId = callIdFor(event.key);
    const existing = await this.ledger.findAdmission(callId);
    if (!existing.ok) return existing;
    if (existing.value) return this.selectedReplay(existing.value, event, policy, sessionId, expectedLeaseVersion, turnId);
    const pending = await this.ledger.findPendingLocation(callId);
    if (!pending.ok) return pending;
    if (!pending.value) return err({ kind: "callUnknown" });
    const original = pending.value.admission;
    if (original.key.accountRef !== event.key.accountRef || original.key.providerCallRef !== event.key.providerCallRef ||
        original.dialedNumber !== event.dialedNumber) return err({ kind: "callConflict" });
    if (pending.value.status === "expired") return err({ kind: "admissionExpired" });
    if (pending.value.status === "bound") {
      const raced = await this.ledger.findAdmission(callId);
      if (!raced.ok) return raced;
      return raced.value ? this.selectedReplay(raced.value, event, policy, sessionId, expectedLeaseVersion, turnId)
        : err({ kind: "storageCorrupt" });
    }
    if (pending.value.status !== "pending") return err({ kind: "storageCorrupt" });
    if (!policyMatchesPending(pending.value, policy)) return err({ kind: "scopeMismatch" });
    if (!pending.value.sessionLease || pending.value.sessionLease.sessionId !== sessionId ||
        pending.value.sessionLease.version !== expectedLeaseVersion) return err({ kind: "leaseLost" });
    const prepared = await this.preparePolicy(policy);
    if (!prepared.ok) {
      const raced = await this.ledger.findAdmission(callId);
      if (!raced.ok) return raced;
      if (!raced.value) return prepared;
      return this.selectedReplay(raced.value, event, policy, sessionId, expectedLeaseVersion, turnId);
    }
    return this.ledger.bindPendingLocation(callId, prepared.value.policy, sessionId, expectedLeaseVersion, turnId, prepared.value.acceptedAt);
  }

  async begin(event: AuthenticatedInboundCall): Promise<Result<AdmissionResult, TransitionFailure | RouteFailure>> {
    if (!event.key.accountRef || !event.key.providerCallRef || !event.dialedNumber || !Number.isFinite(Date.parse(event.receivedAt))) return err({ kind: "invalidTransition" });
    const callId = callIdFor(event.key);
    const existing = await this.ledger.findAdmission(callId);
    if (!existing.ok) return existing;
    if (existing.value) return duplicateOrConflict(existing.value, event);
    const pending = await this.ledger.findPendingLocation(callId);
    if (!pending.ok) return pending;
    if (pending.value) {
      if (pending.value.admission.key.accountRef !== event.key.accountRef ||
          pending.value.admission.key.providerCallRef !== event.key.providerCallRef ||
          pending.value.admission.dialedNumber !== event.dialedNumber) return err({ kind: "callConflict" });
      if (pending.value.status === "bound") {
        const raced = await this.ledger.findAdmission(callId);
        if (!raced.ok) return raced;
        return raced.value ? duplicateOrConflict(raced.value, event) : err({ kind: "storageCorrupt" });
      }
      return err({ kind: pending.value.status === "expired" ? "admissionExpired" : "locationChoicePending" });
    }
    let policy: Result<CallPolicy, RouteFailure>;
    try {
      policy = await this.resolvePolicy(event.dialedNumber, event.key.accountRef);
    } catch {
      policy = err({ kind: "routeUnavailable" });
    }
    if (!policy.ok) {
      const raced = await this.ledger.findAdmission(callId);
      if (!raced.ok) return raced;
      return raced.value ? duplicateOrConflict(raced.value, event) : policy;
    }
    const prepared = await this.preparePolicy(policy.value);
    if (!prepared.ok) {
      const raced = await this.ledger.findAdmission(callId);
      if (!raced.ok) return raced;
      return raced.value ? duplicateOrConflict(raced.value, event) : prepared;
    }
    const admission: Admission = {
      key: event.key,
      dialedNumber: event.dialedNumber,
      acceptedAt: prepared.value.acceptedAt,
      deadline: new Date(Date.parse(prepared.value.acceptedAt) + 30_000).toISOString(),
    };
    return this.ledger.admit(callId, prepared.value.policy, admission);
  }
}
