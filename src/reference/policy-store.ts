import type { BookingSettingAuditEntry, BookingSettingAuditPage, PolicyStore, PolicyFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, CapabilityMode, LocationScope, Result } from "../core/model.ts";

export function referenceDefaultPolicy(scope: LocationScope): CallPolicy {
  return {
    scope: structuredClone(scope),
    policyVersion: "0",
    automationEnabled: false,
    bookingEnabled: false,
    capabilities: { book: "unavailable", cancel: "requestOnly", reschedule: "requestOnly", intake: "requestOnly", transfer: "requestOnly" },
    staffDestination: { kind: "owner", ownerRef: `reference-staff:${scope.tenantId}:${scope.clinicId}` },
    operatorQueue: { kind: "queue", queueRef: `reference-review:${scope.tenantId}:${scope.clinicId}` },
  };
}

function scopeKey(scope: LocationScope): string {
  return JSON.stringify([scope.tenantId, scope.clinicId, scope.locationId]);
}

export class MemoryPolicyStore implements PolicyStore {
  private readonly policies = new Map<string, CallPolicy>();
  private readonly bookingChanges = new Map<string, BookingSettingAuditEntry[]>();
  private readonly hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly">;
  private readonly clock: () => string;

  constructor(hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly"> = "execute", clock: () => string = () => new Date().toISOString()) {
    this.hostBookingMode = hostBookingMode;
    this.clock = clock;
  }

  private effective(policy: CallPolicy): CallPolicy {
    return { ...policy, capabilities: { ...policy.capabilities, book: policy.bookingEnabled ? this.hostBookingMode : "unavailable" } };
  }

  async read(scope: LocationScope): Promise<Result<CallPolicy, PolicyFailure>> {
    return ok(structuredClone(this.effective(this.policies.get(scopeKey(scope)) ?? referenceDefaultPolicy(scope))));
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
    return ok(structuredClone(next));
  }

  async listBookingChanges(scope: LocationScope, afterVersion?: number): Promise<Result<BookingSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    const entries = (this.bookingChanges.get(scopeKey(scope)) ?? []).filter(item => Number(item.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries), ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }
}
