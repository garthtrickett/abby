import { isAbsolute } from "node:path";
import type { ClinicGuardianIdentityRecords } from "../cliniko/guardian-contact.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { declareClinikoRequestCost } from "../cliniko/request-cost.ts";
import type { LocationScope } from "../core/model.ts";
import { err, ok } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { readOwnerJson } from "../shared/owner-json.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import type { ClinicGuardianPatientAuthorityRecords } from "./guardian-patient-authority.ts";
import { approvalRef } from "./owner-file-clinic-approval.ts";
import { guardianOperations } from "./owner-file-guardian-policy.ts";
import { sameRepresentativeIdentity, validRepresentativeIdentity } from "./representative-identity.ts";

type Binding = Readonly<{ scope: LocationScope; policyVersion: string; businessId: string; credentialFingerprint: string }>;
type Config = Binding & Readonly<{ identityPath: string; authorityPath: string; budget: ClinikoRequestBudget }>;
type IdentityQuery = Parameters<ClinicGuardianIdentityRecords["read"]>[0];
type AuthorityQuery = Parameters<ClinicGuardianPatientAuthorityRecords["read"]>[0];
type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const keys = (value: Row, expected: string) => Object.keys(value).sort().join(",") === expected;
const phone = (value: unknown): value is string => typeof value === "string" && /^\+[1-9][0-9]{7,14}$/.test(value);
function matchesBinding(expected: Binding, value: Binding): boolean {
  return !!value && !!value.scope && Object.keys(value.scope).sort().join(",") === "clinicId,locationId,tenantId" &&
    sameScope(expected.scope, value.scope) && expected.policyVersion === value.policyVersion &&
    expected.businessId === value.businessId && expected.credentialFingerprint === value.credentialFingerprint;
}

/** Read a bounded fresh collection. Record approval and membership remain the
 * existing identity/authority owners' responsibility; an index grants nothing. */
async function entries(config: Binding, path: string, kind: string, signal: AbortSignal): Promise<Row[] | undefined> {
  const body = row(await awaitUntilAbort(readOwnerJson(path, 65_536), signal));
  if (signal.aborted || !body || !keys(body, "businessId,credentialFingerprint,entries,kind,policyVersion,schemaVersion,scope") ||
      body.schemaVersion !== 1 || body.kind !== kind || !matchesBinding(config, body as unknown as Binding) ||
      !Array.isArray(body.entries) || body.entries.length > 64 || !body.entries.every(item => !!row(item))) return undefined;
  return body.entries as Row[];
}

/** Optional trusted-host sources over clinic-provisioned private files. No
 * provisioning, caller/model path selection, cache, native I/O or activation. */
export function ownerFileGuardianRecords(incoming: Config): Readonly<{
  identities: ClinicGuardianIdentityRecords; authorities: ClinicGuardianPatientAuthorityRecords;
}> {
  if (!incoming?.scope || ![incoming.scope.tenantId, incoming.scope.clinicId, incoming.scope.locationId, incoming.policyVersion].every(approvalRef) ||
      Object.keys(incoming.scope).sort().join(",") !== "clinicId,locationId,tenantId" || !validClinikoId(incoming.businessId) ||
      !/^[a-f0-9]{64}$/.test(incoming.credentialFingerprint) || ![incoming.identityPath, incoming.authorityPath].every(path => typeof path === "string" && isAbsolute(path))) {
    throw new TypeError("invalid guardian record sources");
  }
  const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
  const cost = { scope: config.scope, credentialFingerprint: config.credentialFingerprint, budget: config.budget };
  const identityRead: ClinicGuardianIdentityRecords["read"] = async (query: IdentityQuery) => {
    try {
      const wanted = { ...query, scope: { ...query.scope } };
      if (!(wanted.signal instanceof AbortSignal) || wanted.signal.aborted || !matchesBinding(config, wanted) || !phone(wanted.normalizedPhone)) return err({ kind: "denied" });
      const source = await entries(config, config.identityPath, "guardianIdentities", wanted.signal);
      if (!source || source.some(item => !keys(item, "normalizedPhone,record") || !phone(item.normalizedPhone) || !row(item.record))) return err({ kind: "unavailable" });
      const matches = source.filter(item => item.normalizedPhone === wanted.normalizedPhone);
      return !wanted.signal.aborted && matches.length === 1 ? ok(structuredClone(matches[0]!.record)) : err({ kind: "denied" });
    } catch { return err({ kind: "unavailable" }); }
  };
  const authorityRead: ClinicGuardianPatientAuthorityRecords["read"] = async (query: AuthorityQuery) => {
    try {
      const wanted = { ...query, scope: { ...query.scope }, identity: structuredClone(query.identity), guardian: structuredClone(query.guardian) };
      if (!(wanted.signal instanceof AbortSignal) || wanted.signal.aborted || !matchesBinding(config, wanted) || !matchesBinding(config, wanted.guardian) ||
          wanted.guardian.kind !== "verifiedGuardian" || wanted.guardian.operation !== wanted.operation || !validClinikoId(wanted.guardian.contactId) ||
          ![wanted.guardian.recordRef, wanted.guardian.recordVersion, wanted.guardian.revision].every(approvalRef) ||
          !validRepresentativeIdentity(wanted.identity) || !guardianOperations.includes(wanted.operation) || !["identify", "channel", "operation"].includes(wanted.purpose)) return err({ kind: "guardianAuthorityUnavailable" });
      const source = await entries(config, config.authorityPath, "guardianAuthorities", wanted.signal);
      if (!source || source.some(item => !keys(item, "identity,record") || !validRepresentativeIdentity(item.identity) || !row(item.record))) return err({ kind: "guardianAuthorityUnavailable" });
      const matches = source.filter(item => {
        const record = item.record as Row, guardian = wanted.guardian;
        return sameRepresentativeIdentity(item.identity as AuthorityQuery["identity"], wanted.identity) && record.contactId === guardian.contactId &&
          record.identityRecordRef === guardian.recordRef && record.identityRecordVersion === guardian.recordVersion && record.identityRevision === guardian.revision &&
          record.operation === wanted.operation;
      });
      // Do not filter enabled/approved/purposes/expiry to manufacture uniqueness,
      // or combine multiple partial grants. The authority owner checks the one row.
      return !wanted.signal.aborted && matches.length === 1 ? ok(structuredClone(matches[0]!.record)) : err({ kind: "guardianAuthorityUnavailable" });
    } catch { return err({ kind: "guardianAuthorityUnavailable" }); }
  };
  return Object.freeze({ identities: Object.freeze({ read: declareClinikoRequestCost(identityRead, cost, 0) }),
    authorities: Object.freeze({ read: declareClinikoRequestCost(authorityRead, cost, 0) }) });
}
