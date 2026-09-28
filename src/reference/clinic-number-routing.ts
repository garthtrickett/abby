import type { PolicyStore } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { PolicyResolver } from "../voice/admission.ts";

export type ClinicIdentity = Readonly<{
  accountRef: string;
  dialedNumber: string;
  tenantId: string;
  clinicId: string;
  candidateLocationIds: readonly string[];
  routeVersion: string;
}>;

export type ClinicIdentityFailure = Readonly<{ kind: "unknownNumber" | "ambiguousClinic" | "unavailable" }>;

/** Host-owned lookup independent of mutable clinic automation and patient records. */
export interface ClinicNumberRoutingHost {
  identifyCall(accountRef: string, dialedNumber: string): Promise<Result<ClinicIdentity, ClinicIdentityFailure>>;
}

function validRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256;
}

function validIdentity(identity: ClinicIdentity, accountRef: string, dialedNumber: string): boolean {
  return identity.accountRef === accountRef && identity.dialedNumber === dialedNumber &&
    validRef(identity.tenantId) && validRef(identity.clinicId) && validRef(identity.routeVersion) &&
    Array.isArray(identity.candidateLocationIds) && identity.candidateLocationIds.length >= 1 &&
    identity.candidateLocationIds.length <= 32 && identity.candidateLocationIds.every(validRef) &&
    new Set(identity.candidateLocationIds).size === identity.candidateLocationIds.length;
}

/** Resolves only an unambiguous location; a shared-number choice needs its own call transition. */
export class ClinicPolicyRouter {
  private readonly host: ClinicNumberRoutingHost;
  private readonly policy: Pick<PolicyStore, "read">;

  constructor(host: ClinicNumberRoutingHost, policy: Pick<PolicyStore, "read">) {
    this.host = host;
    this.policy = policy;
  }

  readonly resolve: PolicyResolver = async (dialedNumber, accountRef) => {
    if (!validRef(accountRef) || !validRef(dialedNumber)) return err({ kind: "routeUnavailable" });
    let identified: Awaited<ReturnType<ClinicNumberRoutingHost["identifyCall"]>>;
    try { identified = await this.host.identifyCall(accountRef, dialedNumber); }
    catch { return err({ kind: "routeUnavailable" }); }
    if (!identified.ok) return err({ kind: identified.error.kind === "unavailable" ? "routeUnavailable" : identified.error.kind });
    const identity = identified.value;
    if (!validIdentity(identity, accountRef, dialedNumber)) return err({ kind: "routeUnavailable" });
    if (identity.candidateLocationIds.length !== 1) return err({ kind: "locationChoiceRequired" });
    const scope: LocationScope = { tenantId: identity.tenantId, clinicId: identity.clinicId,
      locationId: identity.candidateLocationIds[0]! };
    try {
      const loaded = await this.policy.read(scope);
      if (!loaded.ok) return err({ kind: "routeUnavailable" });
      const bound = loaded.value.scope;
      if (bound.tenantId !== scope.tenantId || bound.clinicId !== scope.clinicId || bound.locationId !== scope.locationId) {
        return err({ kind: "routeUnavailable" });
      }
      return ok({ ...loaded.value, numberRouteVersion: identity.routeVersion });
    } catch { return err({ kind: "routeUnavailable" }); }
  };
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
