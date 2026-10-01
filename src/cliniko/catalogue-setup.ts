import { err, ok } from "../core/model.ts";
import type { CallPolicy, LocationScope, Result } from "../core/model.ts";
import type { HostActor } from "../reference/command-gateway.ts";
import type { ClinicNumberRoutingHost } from "../reference/clinic-number-routing.ts";
import type { ClinikoCatalogueFailure, ClinikoCatalogueReader, ClinikoSelection, ClinikoSelectionSnapshot } from "./catalogue.ts";

export type ClinikoSetupFailure = Readonly<{ kind: "forbidden" | "invalid" | "scopeMismatch" |
  "routeChanged" | "policyChanged" | "credentialForbidden" | "catalogueRateLimited" |
  "catalogueUnavailable" | "selectionUnavailable" |
  "staleCatalogue" | "notApproved" | "staleApproval" | "versionConflict" | "storageFailure" }>;

export type ClinikoSetupRoute = Readonly<{
  accountRef: string;
  dialedNumber: string;
  routeVersion: string;
}>;

/** Operational approval of read-only metadata. It grants no patient action or staff request. */
export type ClinikoSelectionApproval = Readonly<{
  scope: LocationScope;
  route: ClinikoSetupRoute;
  selection: ClinikoSelection;
  /** Ordered fallback choices, each explicitly approved for the same business and policy. */
  alternatives: readonly ClinikoSelection[];
  /** Cliniko business time zone at approval; the caller's calendar date must use this zone. */
  businessTimeZone: string;
  credentialFingerprint: string;
  catalogueObservedAt: string;
  approvedBy: string;
  approvedAt: string;
  patientActionMode: "unavailable";
  patientRequestMode: "unavailable";
}>;

export type ClinikoApprovalState = Readonly<{
  version: number;
  approval: ClinikoSelectionApproval | null;
}>;

/** Deploying hosts can implement this with their own clinic configuration store. */
export interface ClinikoApprovalStore {
  read(scope: LocationScope): Promise<Result<ClinikoApprovalState, ClinikoSetupFailure>>;
  change(scope: LocationScope, expectedVersion: number, approval: ClinikoSelectionApproval | null, changedBy: string):
    Promise<Result<ClinikoApprovalState, ClinikoSetupFailure>>;
}

const validRef = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const validRoute = (value: unknown): value is ClinikoSetupRoute => {
  const route = value as Partial<ClinikoSetupRoute> | null;
  return !!route && validRef(route.accountRef) && /^\+[1-9][0-9]{1,14}$/.test(String(route.dialedNumber)) &&
    validRef(route.routeVersion);
};
const validSelection = (value: unknown): value is ClinikoSelection => {
  const selection = value as Partial<ClinikoSelection> | null;
  return !!selection && [selection.businessId, selection.practitionerId, selection.appointmentTypeId]
    .every(id => typeof id === "string" && id.length <= 20 && /^[1-9][0-9]*$/.test(id)) &&
    typeof selection.policyVersion === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(selection.policyVersion);
};
const validAlternatives = (primary: ClinikoSelection, alternatives: unknown): alternatives is readonly ClinikoSelection[] =>
  Array.isArray(alternatives) && alternatives.length <= 2 &&
  alternatives.every(choice => validSelection(choice) && choice.businessId === primary.businessId &&
    choice.policyVersion === primary.policyVersion) &&
  new Set([primary, ...alternatives].map(choice => `${choice.practitionerId}:${choice.appointmentTypeId}`)).size === alternatives.length + 1;
const validScope = (value: unknown): value is LocationScope => {
  const scope = value as Partial<LocationScope> | null;
  return !!scope && validRef(scope.tenantId) && validRef(scope.clinicId) && validRef(scope.locationId);
};
const sameScope = (left: LocationScope, right: LocationScope): boolean =>
  left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
const validInstant = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const validTimeZone = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) return false;
  try { new Intl.DateTimeFormat("en-AU", { timeZone: value }); return true; }
  catch { return false; }
};
const catalogueFailure = (failure: ClinikoCatalogueFailure): ClinikoSetupFailure => ({
  kind: failure.kind === "forbidden" ? "credentialForbidden" :
    failure.kind === "rateLimited" ? "catalogueRateLimited" : "catalogueUnavailable",
});
export const isClinikoApprovalState = (state: ClinikoApprovalState): boolean =>
  !!state && Number.isSafeInteger(state.version) && state.version >= 0 &&
  (state.approval === null || (!!state.approval && validScope(state.approval.scope) &&
    validRoute(state.approval.route) && validSelection(state.approval.selection) &&
    validAlternatives(state.approval.selection, state.approval.alternatives) &&
    validTimeZone(state.approval.businessTimeZone) && validRef(state.approval.approvedBy) &&
    validInstant(state.approval.approvedAt) && validInstant(state.approval.catalogueObservedAt) &&
    /^[0-9a-f]{64}$/.test(state.approval.credentialFingerprint) &&
    state.approval.patientActionMode === "unavailable" && state.approval.patientRequestMode === "unavailable"));

/** Reference adapter: synchronous compare-and-swap, no patient fields, no restart persistence. */
export class MemoryClinikoApprovalStore implements ClinikoApprovalStore {
  private readonly states = new Map<string, ClinikoApprovalState>();
  private key(scope: LocationScope): string { return JSON.stringify([scope.tenantId, scope.clinicId, scope.locationId]); }

  async read(scope: LocationScope): Promise<Result<ClinikoApprovalState, ClinikoSetupFailure>> {
    if (!validScope(scope)) return err({ kind: "invalid" });
    return ok(structuredClone(this.states.get(this.key(scope)) ?? { version: 0, approval: null }));
  }

  async change(scope: LocationScope, expectedVersion: number, approval: ClinikoSelectionApproval | null, changedBy: string):
    Promise<Result<ClinikoApprovalState, ClinikoSetupFailure>> {
    if (!validScope(scope) || !validRef(changedBy) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
        (approval !== null && (!isClinikoApprovalState({ version: 1, approval }) ||
          !sameScope(scope, approval.scope) || approval.approvedBy !== changedBy))) {
      return err({ kind: "invalid" });
    }
    const key = this.key(scope);
    const current = this.states.get(key) ?? { version: 0, approval: null };
    if (current.version !== expectedVersion) return err({ kind: "versionConflict" });
    const next = structuredClone({ version: current.version + 1, approval });
    this.states.set(key, next);
    return ok(structuredClone(next));
  }
}

type PolicyReader = Readonly<{ read(scope: LocationScope): Promise<Result<CallPolicy, { kind: string }>> }>;

/** Host actor must come from an authenticated host identity source, not request JSON. */
export class ClinikoCatalogueSetup {
  private readonly reader: ClinikoCatalogueReader;
  private readonly routing: ClinicNumberRoutingHost;
  private readonly policy: PolicyReader;
  private readonly store: ClinikoApprovalStore;
  private readonly now: () => string;

  constructor(reader: ClinikoCatalogueReader, routing: ClinicNumberRoutingHost, policy: PolicyReader,
              store: ClinikoApprovalStore, now: () => string = () => new Date().toISOString()) {
    this.reader = reader;
    this.routing = routing;
    this.policy = policy;
    this.store = store;
    this.now = now;
  }

  private authorize(actor: HostActor): Result<LocationScope, ClinikoSetupFailure> {
    if (!actor || actor.role !== "clinicAdmin" || !validRef(actor.actorRef) || !validScope(actor.scope)) {
      return err({ kind: "forbidden" });
    }
    if (!this.reader.matchesScope(actor.scope)) return err({ kind: "scopeMismatch" });
    return ok(actor.scope);
  }

  async businesses(actor: HostActor) {
    const allowed = this.authorize(actor);
    if (!allowed.ok) return allowed;
    const result = await this.reader.businesses(allowed.value);
    return result.ok ? result : err(catalogueFailure(result.error));
  }

  async inspect(actor: HostActor, selection: ClinikoSelection):
    Promise<Result<ClinikoSelectionSnapshot, ClinikoSetupFailure>> {
    const allowed = this.authorize(actor);
    if (!allowed.ok) return allowed;
    const result = await this.reader.inspect(allowed.value, selection);
    return result.ok ? result : err(catalogueFailure(result.error));
  }

  async current(actor: HostActor): Promise<Result<ClinikoApprovalState, ClinikoSetupFailure>> {
    const allowed = this.authorize(actor);
    if (!allowed.ok) return allowed;
    try {
      const result = await this.store.read(allowed.value);
      if (!result.ok) return result;
      if (!isClinikoApprovalState(result.value) || (result.value.approval &&
          !sameScope(result.value.approval.scope, allowed.value))) return err({ kind: "storageFailure" });
      return ok(structuredClone(result.value));
    } catch { return err({ kind: "storageFailure" }); }
  }

  private async bind(scope: LocationScope, route: ClinikoSetupRoute, selection: ClinikoSelection):
    Promise<Result<ClinikoSelectionSnapshot, ClinikoSetupFailure>> {
    if (!validRoute(route) || !validSelection(selection)) return err({ kind: "invalid" });
    const verifyContext = async (): Promise<Result<true, ClinikoSetupFailure>> => {
      try {
        const identity = await this.routing.identifyCall(route.accountRef, route.dialedNumber);
        if (!identity.ok || identity.value.accountRef !== route.accountRef ||
            identity.value.dialedNumber !== route.dialedNumber || identity.value.routeVersion !== route.routeVersion ||
            identity.value.tenantId !== scope.tenantId || identity.value.clinicId !== scope.clinicId ||
            identity.value.candidateLocationIds.length !== 1 || identity.value.candidateLocationIds[0] !== scope.locationId) {
          return err({ kind: "routeChanged" });
        }
        const policy = await this.policy.read(scope);
        if (!policy.ok || !validScope(policy.value.scope) || !sameScope(policy.value.scope, scope) ||
            policy.value.policyVersion !== selection.policyVersion) return err({ kind: "policyChanged" });
        return ok(true);
      } catch { return err({ kind: "catalogueUnavailable" }); }
    };
    const before = await verifyContext();
    if (!before.ok) return before;
    const inspected = await this.reader.inspect(scope, selection);
    if (!inspected.ok) return err(catalogueFailure(inspected.error));
    if (inspected.value.status !== "candidate") return err({ kind: "selectionUnavailable" });
    let at: string;
    try { at = this.now(); }
    catch { return err({ kind: "staleCatalogue" }); }
    if (!this.reader.matchesCurrentSelection(inspected.value, scope, selection, 60_000, at)) {
      return err({ kind: "staleCatalogue" });
    }
    const after = await verifyContext();
    return after.ok ? ok(inspected.value) : after;
  }

  async approve(actor: HostActor, route: ClinikoSetupRoute, selection: ClinikoSelection, expectedVersion: number):
    Promise<Result<ClinikoApprovalState, ClinikoSetupFailure>> {
    return this.approveAlternatives(actor, route, selection, [], expectedVersion);
  }

  async approveAlternatives(actor: HostActor, route: ClinikoSetupRoute, selection: ClinikoSelection,
                            alternatives: readonly ClinikoSelection[], expectedVersion: number):
    Promise<Result<ClinikoApprovalState, ClinikoSetupFailure>> {
    const allowed = this.authorize(actor);
    if (!allowed.ok) return allowed;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
        !validSelection(selection) || !validAlternatives(selection, alternatives)) return err({ kind: "invalid" });
    const bound = await this.bind(allowed.value, route, selection);
    if (!bound.ok) return bound;
    const alternativeSnapshots: ClinikoSelectionSnapshot[] = [];
    for (const alternative of alternatives) {
      const next = await this.bind(allowed.value, route, alternative);
      if (!next.ok) return next;
      if (next.value.credentialFingerprint !== bound.value.credentialFingerprint ||
          next.value.timeZone !== bound.value.timeZone) return err({ kind: "selectionUnavailable" });
      alternativeSnapshots.push(next.value);
    }
    let approvedAt: string;
    try { approvedAt = this.now(); }
    catch { return err({ kind: "staleCatalogue" }); }
    if (!this.reader.matchesCurrentSelection(bound.value, allowed.value, selection, 60_000, approvedAt)) {
      return err({ kind: "staleCatalogue" });
    }
    for (let index = 0; index < alternatives.length; index += 1) {
      if (!this.reader.matchesCurrentSelection(alternativeSnapshots[index]!, allowed.value,
          alternatives[index]!, 60_000, approvedAt)) return err({ kind: "staleCatalogue" });
    }
    const approval: ClinikoSelectionApproval = {
      scope: structuredClone(allowed.value), route: structuredClone(route), selection: { ...selection },
      alternatives: alternatives.map(choice => ({ ...choice })),
      businessTimeZone: bound.value.timeZone!,
      credentialFingerprint: bound.value.credentialFingerprint,
      catalogueObservedAt: bound.value.observedAt, approvedBy: actor.actorRef, approvedAt,
      patientActionMode: "unavailable", patientRequestMode: "unavailable",
    };
    try { return await this.store.change(allowed.value, expectedVersion, approval, actor.actorRef); }
    catch { return err({ kind: "storageFailure" }); }
  }

  async revoke(actor: HostActor, expectedVersion: number): Promise<Result<ClinikoApprovalState, ClinikoSetupFailure>> {
    const allowed = this.authorize(actor);
    if (!allowed.ok) return allowed;
    try { return await this.store.change(allowed.value, expectedVersion, null, actor.actorRef); }
    catch { return err({ kind: "storageFailure" }); }
  }

  /** Number ingress: prove the approved configuration without suppressing a truthful unavailable-times response. */
  async readApprovedRoute(scope: LocationScope, route: ClinikoSetupRoute):
    Promise<Result<ClinikoSelectionApproval, ClinikoSetupFailure>> {
    if (!this.reader.matchesScope(scope) || !validRoute(route)) return err({ kind: "scopeMismatch" });
    let first: Result<ClinikoApprovalState, ClinikoSetupFailure>;
    try { first = await this.store.read(scope); }
    catch { return err({ kind: "storageFailure" }); }
    if (!first.ok) return first;
    if (!isClinikoApprovalState(first.value)) return err({ kind: "storageFailure" });
    const approval = first.value.approval;
    if (!approval) return err({ kind: "notApproved" });
    if (!sameScope(scope, approval.scope) || route.accountRef !== approval.route.accountRef ||
        route.dialedNumber !== approval.route.dialedNumber || route.routeVersion !== approval.route.routeVersion ||
        approval.credentialFingerprint !== this.reader.credentialFingerprint()) return err({ kind: "staleApproval" });
    try {
      const identified = await this.routing.identifyCall(route.accountRef, route.dialedNumber);
      if (!identified.ok || identified.value.accountRef !== route.accountRef ||
          identified.value.dialedNumber !== route.dialedNumber || identified.value.routeVersion !== route.routeVersion ||
          identified.value.tenantId !== scope.tenantId || identified.value.clinicId !== scope.clinicId ||
          identified.value.candidateLocationIds.length !== 1 ||
          identified.value.candidateLocationIds[0] !== scope.locationId) return err({ kind: "routeChanged" });
      const policy = await this.policy.read(scope);
      if (!policy.ok || !validScope(policy.value.scope) || !sameScope(policy.value.scope, scope) ||
          policy.value.policyVersion !== approval.selection.policyVersion) return err({ kind: "policyChanged" });
    } catch { return err({ kind: "catalogueUnavailable" }); }
    let current: Result<ClinikoApprovalState, ClinikoSetupFailure>;
    try { current = await this.store.read(scope); }
    catch { return err({ kind: "storageFailure" }); }
    if (!current.ok) return current;
    if (!isClinikoApprovalState(current.value) || current.value.version !== first.value.version ||
        !current.value.approval) return err({ kind: "staleApproval" });
    return ok(structuredClone(approval));
  }

  /** Reproves the route, policy and provider selection before using an approval for a call. */
  async resolveForCall(scope: LocationScope, route: ClinikoSetupRoute):
    Promise<Result<ClinikoSelectionApproval, ClinikoSetupFailure>> {
    if (!this.reader.matchesScope(scope) || !validRoute(route)) return err({ kind: "scopeMismatch" });
    let stored: Result<ClinikoApprovalState, ClinikoSetupFailure>;
    try { stored = await this.store.read(scope); }
    catch { return err({ kind: "storageFailure" }); }
    if (!stored.ok) return stored;
    if (!isClinikoApprovalState(stored.value)) return err({ kind: "storageFailure" });
    const approval = stored.value.approval;
    if (!approval) return err({ kind: "notApproved" });
    if (!sameScope(scope, approval.scope) || route.accountRef !== approval.route.accountRef ||
        route.dialedNumber !== approval.route.dialedNumber || route.routeVersion !== approval.route.routeVersion ||
        approval.credentialFingerprint !== this.reader.credentialFingerprint()) return err({ kind: "staleApproval" });
    const bound = await this.bind(scope, route, approval.selection);
    if (!bound.ok) return bound;
    if (bound.value.timeZone !== approval.businessTimeZone) return err({ kind: "selectionUnavailable" });
    for (const alternative of approval.alternatives) {
      const next = await this.bind(scope, route, alternative);
      if (!next.ok) return next;
      if (next.value.credentialFingerprint !== bound.value.credentialFingerprint ||
          next.value.timeZone !== bound.value.timeZone) return err({ kind: "selectionUnavailable" });
    }
    let current: Result<ClinikoApprovalState, ClinikoSetupFailure>;
    try { current = await this.store.read(scope); }
    catch { return err({ kind: "storageFailure" }); }
    if (!current.ok) return current;
    if (!isClinikoApprovalState(current.value) || current.value.version !== stored.value.version || !current.value.approval) {
      return err({ kind: "staleApproval" });
    }
    return ok(structuredClone(approval));
  }
}
