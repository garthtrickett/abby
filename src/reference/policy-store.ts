import type { PolicyStore, PolicyFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, CapabilityMode, LocationScope, Result } from "../core/model.ts";

export function referenceDefaultPolicy(scope: LocationScope): CallPolicy {
  return {
    scope: structuredClone(scope),
    policyVersion: "0",
    bookingEnabled: false,
    capabilities: { book: "unavailable", cancel: "requestOnly", reschedule: "requestOnly", intake: "requestOnly" },
    staffDestination: { kind: "owner", ownerRef: `reference-staff:${scope.tenantId}:${scope.clinicId}` },
    operatorQueue: { kind: "queue", queueRef: `reference-review:${scope.tenantId}:${scope.clinicId}` },
  };
}

function scopeKey(scope: LocationScope): string {
  return JSON.stringify([scope.tenantId, scope.clinicId, scope.locationId]);
}

export class MemoryPolicyStore implements PolicyStore {
  private readonly policies = new Map<string, CallPolicy>();
  private readonly hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly">;

  constructor(hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly"> = "execute") {
    this.hostBookingMode = hostBookingMode;
  }

  private effective(policy: CallPolicy): CallPolicy {
    return { ...policy, capabilities: { ...policy.capabilities, book: policy.bookingEnabled ? this.hostBookingMode : "unavailable" } };
  }

  async read(scope: LocationScope): Promise<Result<CallPolicy, PolicyFailure>> {
    return ok(structuredClone(this.effective(this.policies.get(scopeKey(scope)) ?? referenceDefaultPolicy(scope))));
  }

  async changeBookingEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, PolicyFailure>> {
    if (typeof enabled !== "boolean") return err({ kind: "invalidValue" });
    const current = this.policies.get(scopeKey(scope)) ?? referenceDefaultPolicy(scope);
    if (current.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
    const next: CallPolicy = {
      ...current,
      policyVersion: String(Number(current.policyVersion) + 1),
      bookingEnabled: enabled,
      capabilities: { ...current.capabilities, book: enabled ? this.hostBookingMode : "unavailable" },
    };
    this.policies.set(scopeKey(scope), structuredClone(next));
    return ok(structuredClone(next));
  }
}
