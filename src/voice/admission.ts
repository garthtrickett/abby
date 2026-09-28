import { createHash } from "node:crypto";
import type { LedgerStore } from "../core/ledger.ts";
import type { ModelKnowledgeContextHost } from "../core/host.ts";
import { captureKnowledgeSnapshot, validKnowledgeSnapshot } from "../core/knowledge-evidence.ts";
import { err, ok } from "../core/model.ts";
import type { Admission, AdmissionReceipt, AdmissionResult, CallPolicy, ProviderCallKey, Result, TransitionFailure } from "../core/model.ts";
import { unprovenReadiness } from "../core/readiness.ts";
import type { AutomationReadiness } from "../core/readiness.ts";

// The transport adapter authenticates the provider account before constructing this event.
export type AuthenticatedInboundCall = Readonly<{
  key: ProviderCallKey;
  dialedNumber: string;
  receivedAt: string;
}>;

export type RouteFailure = Readonly<{ kind: "routeUnavailable" | "unknownNumber" | "ambiguousClinic" | "locationChoiceRequired" | "automationDisabled" | "readinessFailed" }>;
export type PolicyResolver = (dialedNumber: string, accountRef: string) => Promise<Result<CallPolicy, RouteFailure>>;

export function callIdFor(key: ProviderCallKey): string {
  return createHash("sha256").update(JSON.stringify([key.accountRef, key.providerCallRef])).digest("hex");
}

function duplicateOrConflict(receipt: AdmissionReceipt, event: AuthenticatedInboundCall): Result<AdmissionResult, TransitionFailure> {
  const original = receipt.admission;
  return original.key.accountRef === event.key.accountRef && original.key.providerCallRef === event.key.providerCallRef && original.dialedNumber === event.dialedNumber
    ? ok({ kind: "duplicate", receipt }) : err({ kind: "callConflict" });
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

  async begin(event: AuthenticatedInboundCall): Promise<Result<AdmissionResult, TransitionFailure | RouteFailure>> {
    if (!event.key.accountRef || !event.key.providerCallRef || !event.dialedNumber || !Number.isFinite(Date.parse(event.receivedAt))) return err({ kind: "invalidTransition" });
    const callId = callIdFor(event.key);
    const existing = await this.ledger.findAdmission(callId);
    if (!existing.ok) return existing;
    if (existing.value) return duplicateOrConflict(existing.value, event);
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
    if (policy.value.automationEnabled !== true) {
      const raced = await this.ledger.findAdmission(callId);
      if (!raced.ok) return raced;
      return raced.value ? duplicateOrConflict(raced.value, event) : err({ kind: "automationDisabled" });
    }
    let ready = false;
    try {
      const checked = await this.readiness(policy.value.scope);
      ready = checked.ok && checked.value === true;
    }
    catch { ready = false; }
    if (!ready) {
      const raced = await this.ledger.findAdmission(callId);
      if (!raced.ok) return raced;
      return raced.value ? duplicateOrConflict(raced.value, event) : err({ kind: "readinessFailed" });
    }
    const acceptedAt = this.now();
    if (!Number.isFinite(Date.parse(acceptedAt))) return err({ kind: "invalidTransition" });
    let callPolicy = policy.value;
    if (this.knowledge) {
      const captured = await captureKnowledgeSnapshot(this.knowledge, callPolicy.scope, acceptedAt);
      if (!captured.ok) {
        const raced = await this.ledger.findAdmission(callId);
        if (!raced.ok) return raced;
        return raced.value ? duplicateOrConflict(raced.value, event) : err({ kind: "routeUnavailable" });
      }
      callPolicy = { ...callPolicy, knowledgeSnapshot: captured.value };
    }
    if (callPolicy.knowledgeSnapshot !== undefined && !validKnowledgeSnapshot(callPolicy.knowledgeSnapshot)) {
      const raced = await this.ledger.findAdmission(callId);
      if (!raced.ok) return raced;
      return raced.value ? duplicateOrConflict(raced.value, event) : err({ kind: "routeUnavailable" });
    }
    const admission: Admission = {
      key: event.key,
      dialedNumber: event.dialedNumber,
      acceptedAt,
      deadline: new Date(Date.parse(acceptedAt) + 30_000).toISOString(),
    };
    return this.ledger.admit(callId, callPolicy, admission);
  }
}
