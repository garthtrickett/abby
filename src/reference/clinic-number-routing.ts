import type { PolicyStore } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, LocationScope, Result } from "../core/model.ts";
import type { PolicyResolver, RouteFailure } from "../voice/admission.ts";

export type ClinicIdentity = Readonly<{
  accountRef: string;
  dialedNumber: string;
  tenantId: string;
  clinicId: string;
  candidateLocationIds: readonly string[];
  routeVersion: string;
}>;

export type ClinicIdentityFailure = Readonly<{ kind: "unknownNumber" | "ambiguousClinic" | "unavailable" }>;
export type LocationChoice = Readonly<{ tenantId: string; clinicId: string; locationId: string; routeVersion: string }>;

/** Host-owned lookup independent of mutable clinic automation and patient records. */
export interface ClinicNumberRoutingHost {
  identifyCall(accountRef: string, dialedNumber: string): Promise<Result<ClinicIdentity, ClinicIdentityFailure>>;
}

function validRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256;
}

function validIdentity(identity: unknown, accountRef: string, dialedNumber: string): identity is ClinicIdentity {
  if (!identity || typeof identity !== "object") return false;
  const value = identity as Partial<ClinicIdentity>;
  return value.accountRef === accountRef && value.dialedNumber === dialedNumber &&
    validRef(value.tenantId) && validRef(value.clinicId) && validRef(value.routeVersion) &&
    Array.isArray(value.candidateLocationIds) && value.candidateLocationIds.length >= 1 &&
    value.candidateLocationIds.length <= 32 && value.candidateLocationIds.every(validRef) &&
    new Set(value.candidateLocationIds).size === value.candidateLocationIds.length;
}

/** Resolves only an unambiguous location; a shared-number choice needs its own call transition. */
export class ClinicPolicyRouter {
  private readonly host: ClinicNumberRoutingHost;
  private readonly policy: Pick<PolicyStore, "read">;

  constructor(host: ClinicNumberRoutingHost, policy: Pick<PolicyStore, "read">) {
    this.host = host;
    this.policy = policy;
  }

  async identify(accountRef: string, dialedNumber: string): Promise<Result<ClinicIdentity, RouteFailure>> {
    if (!validRef(accountRef) || !validRef(dialedNumber)) return err({ kind: "routeUnavailable" });
    let identified: Awaited<ReturnType<ClinicNumberRoutingHost["identifyCall"]>>;
    try { identified = await this.host.identifyCall(accountRef, dialedNumber); }
    catch { return err({ kind: "routeUnavailable" }); }
    if (!identified || typeof identified !== "object" || typeof identified.ok !== "boolean") return err({ kind: "routeUnavailable" });
    if (!identified.ok) {
      const kind = identified.error?.kind;
      return err({ kind: kind === "unknownNumber" || kind === "ambiguousClinic" ? kind : "routeUnavailable" });
    }
    const identity = identified.value;
    if (!validIdentity(identity, accountRef, dialedNumber)) return err({ kind: "routeUnavailable" });
    return ok(identity);
  }

  private async loadPolicy(identity: ClinicIdentity, locationId: string): Promise<Result<CallPolicy, RouteFailure>> {
    const scope: LocationScope = { tenantId: identity.tenantId, clinicId: identity.clinicId, locationId };
    try {
      const loaded = await this.policy.read(scope);
      if (!loaded.ok) return err({ kind: "routeUnavailable" });
      const bound = loaded.value.scope;
      if (bound.tenantId !== scope.tenantId || bound.clinicId !== scope.clinicId || bound.locationId !== scope.locationId) {
        return err({ kind: "routeUnavailable" });
      }
      return ok({ ...loaded.value, numberRouteVersion: identity.routeVersion });
    } catch { return err({ kind: "routeUnavailable" }); }
  }

  readonly resolve: PolicyResolver = async (dialedNumber, accountRef) => {
    const identified = await this.identify(accountRef, dialedNumber);
    if (!identified.ok) return identified;
    const identity = identified.value;
    if (identity.candidateLocationIds.length !== 1) return err({ kind: "locationChoiceRequired" });
    return this.loadPolicy(identity, identity.candidateLocationIds[0]!);
  };

  /** Rechecks the host identity after a caller choice; no policy read precedes that check. */
  async resolveSelected(accountRef: string, dialedNumber: string, choice: LocationChoice): Promise<Result<CallPolicy, RouteFailure>> {
    if (!choice || ![choice.tenantId, choice.clinicId, choice.locationId, choice.routeVersion].every(validRef)) {
      return err({ kind: "invalidLocationChoice" });
    }
    const identified = await this.identify(accountRef, dialedNumber);
    if (!identified.ok) return identified;
    const identity = identified.value;
    if (identity.tenantId !== choice.tenantId || identity.clinicId !== choice.clinicId || identity.routeVersion !== choice.routeVersion) {
      return err({ kind: "staleLocationChoice" });
    }
    if (!identity.candidateLocationIds.includes(choice.locationId)) return err({ kind: "invalidLocationChoice" });
    return this.loadPolicy(identity, choice.locationId);
  }
}

export type ReferenceNumberAssignment = Readonly<{
  accountRef: string;
  dialedNumber: string;
  tenantId: string;
  clinicId: string;
  locationId: string;
  routeVersion: string;
}>;

/** Synthetic/embedded reference host. Production hosts supply their own number directory. */
export class ReferenceNumberRoutingHost implements ClinicNumberRoutingHost {
  private readonly assignments: readonly ReferenceNumberAssignment[];

  constructor(assignments: readonly ReferenceNumberAssignment[]) {
    if (!Array.isArray(assignments) || assignments.some(item =>
      ![item.accountRef, item.dialedNumber, item.tenantId, item.clinicId, item.locationId, item.routeVersion].every(validRef))) {
      throw new Error("invalid number assignment");
    }
    this.assignments = structuredClone(assignments);
  }

  async identifyCall(accountRef: string, dialedNumber: string): Promise<Result<ClinicIdentity, ClinicIdentityFailure>> {
    if (!validRef(accountRef) || !validRef(dialedNumber)) return err({ kind: "unavailable" });
    const rows = this.assignments.filter(row => row.accountRef === accountRef && row.dialedNumber === dialedNumber);
    if (!rows.length) return err({ kind: "unknownNumber" });
    const clinics = new Set(rows.map(row => JSON.stringify([row.tenantId, row.clinicId])));
    if (clinics.size !== 1) return err({ kind: "ambiguousClinic" });
    const versions = new Set(rows.map(row => row.routeVersion));
    if (versions.size !== 1) return err({ kind: "unavailable" });
    const candidateLocationIds = [...new Set(rows.map(row => row.locationId))].sort();
    if (candidateLocationIds.length > 32) return err({ kind: "unavailable" });
    return ok({ accountRef, dialedNumber, tenantId: rows[0]!.tenantId, clinicId: rows[0]!.clinicId,
      candidateLocationIds, routeVersion: rows[0]!.routeVersion });
  }
}
