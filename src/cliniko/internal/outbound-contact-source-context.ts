import { createHash } from "node:crypto";
import type { LocationScope } from "../../core/model.ts";
import type { ClinikoRequestBudget } from "../read-budget.ts";
import { clinikoCredentialFingerprint } from "../read-budget.ts";
import type { ClinikoContactRevisionReader } from "../contact-revision.ts";
import { outboundConfigShard } from "./outbound-record-context.ts";
export type OutboundContactSourceConfig = Readonly<{
  scope: LocationScope; apiKey: string; contactEmail: string; businessId: string;
  contactReviewRecallTypeId: string; contactPolicyVersion: string; contactPolicyDigest: string; countryCallingCode: string;
  rateBudget: ClinikoRequestBudget; contactRevision: ClinikoContactRevisionReader; clock?: () => string; deadlineMs?: number;
}>;
export type OutboundContactSourceSelection = Readonly<{
  scope: LocationScope; businessId: string; credentialFingerprint: string;
  contactReviewRecallTypeId: string; contactPolicyVersion: string; contactPolicyDigest: string; countryCallingCode: string;
}>;
export function contactSourceShard(config: OutboundContactSourceConfig, port: typeof fetch): string | undefined {
  try {
    if (typeof config.contactPolicyVersion !== "string" || typeof config.countryCallingCode !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(config.contactPolicyVersion) || !/^[1-9][0-9]{0,2}$/.test(config.countryCallingCode) ||
      typeof config.contactRevision?.matches !== "function" || typeof config.contactRevision.read !== "function" ||
      config.contactRevision.matches(config.scope.tenantId, clinikoCredentialFingerprint(config.apiKey)) !== true) return undefined;
    return outboundConfigShard({ ...config, outboundRecallTypeId: config.contactReviewRecallTypeId, recordPolicyDigest: config.contactPolicyDigest }, port);
  } catch { return undefined; }
}
export function contactSourceSelection(config: OutboundContactSourceConfig): OutboundContactSourceSelection {
  return Object.freeze({ scope: Object.freeze({ ...config.scope }), businessId: config.businessId, credentialFingerprint: clinikoCredentialFingerprint(config.apiKey),
    contactReviewRecallTypeId: config.contactReviewRecallTypeId, contactPolicyVersion: config.contactPolicyVersion,
    contactPolicyDigest: config.contactPolicyDigest, countryCallingCode: config.countryCallingCode });
}
export function contactSourceBinding(selection: OutboundContactSourceSelection): string {
  const s = selection;
  return createHash("sha256").update(JSON.stringify(["abby.outbound-contact-source.v1", s.scope.tenantId, s.scope.clinicId, s.scope.locationId,
    s.businessId, s.credentialFingerprint, s.contactReviewRecallTypeId, s.contactPolicyVersion, s.contactPolicyDigest, s.countryCallingCode])).digest("hex");
}
