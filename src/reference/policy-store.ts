import type { AutomationSettingAuditEntry, AutomationSettingAuditPage, BookingSettingAuditEntry, BookingSettingAuditPage, PolicyStore, PolicyFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, CapabilityMode, LocationScope, Result } from "../core/model.ts";
import { READINESS_REQUIREMENTS, unprovenReadiness } from "../core/readiness.ts";
import type { AutomationReadiness } from "../core/readiness.ts";

export function referenceDefaultPolicy(scope: LocationScope): CallPolicy {
  return {
    scope: structuredClone(scope),
    policyVersion: "0",
    automationVersion: "0",
    automationEnabled: false,
    bookingEnabled: false,
    capabilities: { book: "unavailable", cancel: "requestOnly", reschedule: "requestOnly", intake: "requestOnly", transfer: "requestOnly" },
    staffDestination: { kind: "owner", ownerRef: `reference-staff:${scope.tenantId}:${scope.clinicId}` },
    operatorQueue: { kind: "queue", queueRef: `reference-review:${scope.tenantId}:${scope.clinicId}` },
    greeting: { scope: structuredClone(scope), version: "reference-greeting-v1", ownerRef: "reference-fixture",
      approvedText: "Hello. How can I help you?", approved: true },
  };
}

function scopeKey(scope: LocationScope): string {
  return JSON.stringify([scope.tenantId, scope.clinicId, scope.locationId]);
}

function clinicKey(scope: LocationScope): string {
  return JSON.stringify([scope.tenantId, scope.clinicId]);
}

export class MemoryPolicyStore implements PolicyStore {
  private readonly policies = new Map<string, CallPolicy>();
  private readonly clinicAutomation = new Map<string, Readonly<{ version: number; enabled: boolean }>>();
  private readonly bookingChanges = new Map<string, BookingSettingAuditEntry[]>();
  private readonly automationChanges = new Map<string, AutomationSettingAuditEntry[]>();
  private readonly hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly">;
  private readonly clock: () => string;
  private readonly readiness: AutomationReadiness;

  constructor(hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly"> = "execute", clock: () => string = () => new Date().toISOString(), readiness: AutomationReadiness = unprovenReadiness) {
    this.hostBookingMode = hostBookingMode;
    this.clock = clock;
    this.readiness = readiness;
  }

  private effective(policy: CallPolicy): CallPolicy {
    const automation = this.clinicAutomation.get(clinicKey(policy.scope));
    return { ...policy, automationVersion: String(automation?.version ?? 0), automationEnabled: automation?.enabled ?? false,
      capabilities: { ...policy.capabilities, book: policy.bookingEnabled ? this.hostBookingMode : "unavailable" } };
  }

  async read(scope: LocationScope): Promise<Result<CallPolicy, PolicyFailure>> {
    return ok(structuredClone(this.effective(this.policies.get(scopeKey(scope)) ?? referenceDefaultPolicy(scope))));
  }

  async changeAutomationEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (typeof enabled !== "boolean" || typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256) return err({ kind: "invalidValue" });
    const current = this.clinicAutomation.get(clinicKey(scope)) ?? { version: 0, enabled: false };
    if (String(current.version) !== expectedVersion) return err({ kind: "versionConflict" });
    if (enabled) {
      try {
        const ready = await this.readiness(scope);
        if (!ready.ok) return ready;
        if (ready.value !== true) return err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS });
      } catch { return err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS }); }
    }
    let changedAt: string;
    try { changedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (!Number.isFinite(Date.parse(changedAt))) return err({ kind: "storageFailure" });
    // The readiness check may await a host. Recheck the clinic version before committing.
    if ((this.clinicAutomation.get(clinicKey(scope))?.version ?? 0) !== current.version) return err({ kind: "versionConflict" });
    const next = { version: current.version + 1, enabled };
    this.clinicAutomation.set(clinicKey(scope), next);
    const history = this.automationChanges.get(clinicKey(scope)) ?? [];
    history.push({ version: String(next.version), enabled, previousEnabled: current.enabled, actorRef, changedAt });
    this.automationChanges.set(clinicKey(scope), history);
    return this.read(scope);
  }

  async listAutomationChanges(scope: LocationScope, afterVersion?: number): Promise<Result<AutomationSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    const entries = (this.automationChanges.get(clinicKey(scope)) ?? []).filter(item => Number(item.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries), ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }

  async changeBookingEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (typeof enabled !== "boolean" || typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256) return err({ kind: "invalidValue" });
    const current = this.policies.get(scopeKey(scope)) ?? referenceDefaultPolicy(scope);
    if (current.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
    let changedAt: string;
    try { changedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (!Number.isFinite(Date.parse(changedAt))) return err({ kind: "storageFailure" });
    const next: CallPolicy = {
      ...current,
      policyVersion: String(Number(current.policyVersion) + 1),
      bookingEnabled: enabled,
      capabilities: { ...current.capabilities, book: enabled ? this.hostBookingMode : "unavailable" },
    };
    this.policies.set(scopeKey(scope), structuredClone(next));
    const history = this.bookingChanges.get(scopeKey(scope)) ?? [];
    history.push({ version: next.policyVersion, enabled, previousEnabled: current.bookingEnabled,
      actorRef, changedAt, provenance: "recorded" });
    this.bookingChanges.set(scopeKey(scope), history);
    return ok(structuredClone(this.effective(next)));
  }

  async listBookingChanges(scope: LocationScope, afterVersion?: number): Promise<Result<BookingSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    const entries = (this.bookingChanges.get(scopeKey(scope)) ?? []).filter(item => Number(item.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries), ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }
}
