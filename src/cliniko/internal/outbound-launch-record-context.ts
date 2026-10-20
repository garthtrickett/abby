import { createHash } from "node:crypto";
import type { LocationScope } from "../../core/model.ts";
import { clinikoCredentialFingerprint } from "../read-budget.ts";
import type { ClinikoRequestBudget } from "../read-budget.ts";
import { outboundConfigShard } from "./outbound-record-context.ts";

/** Explicit independent possible-attempt type/content selection. A request or
 * financial record configuration cannot activate this adapter by spreading. */
export type OutboundLaunchRecordConfig = Readonly<{
  scope: LocationScope; apiKey: string; contactEmail: string; businessId: string;
  outboundAttemptRecallTypeId: string; attemptPolicyDigest: string;
  rateBudget: ClinikoRequestBudget; clock?: () => string; deadlineMs?: number;
}>;
export type OutboundLaunchRecordSelection = Readonly<{ scope: LocationScope; businessId: string; credentialFingerprint: string;
  outboundAttemptRecallTypeId: string; attemptPolicyDigest: string }>;
export function outboundLaunchRecordSelection(config: OutboundLaunchRecordConfig): OutboundLaunchRecordSelection {
  return Object.freeze({scope:Object.freeze({...config.scope}),businessId:config.businessId,credentialFingerprint:clinikoCredentialFingerprint(config.apiKey),
    outboundAttemptRecallTypeId:config.outboundAttemptRecallTypeId,attemptPolicyDigest:config.attemptPolicyDigest});
}
export function outboundLaunchConfigShard(config: OutboundLaunchRecordConfig,port: typeof fetch): string|undefined {
  return outboundConfigShard({...config,outboundRecallTypeId:config.outboundAttemptRecallTypeId,recordPolicyDigest:config.attemptPolicyDigest},port);
}
/** Non-patient native record configuration binding, never the private attempt digest. */
export function outboundLaunchRecordOwnerBinding(config: OutboundLaunchRecordConfig): string|undefined {
  try {
    if(!outboundLaunchConfigShard(config,fetch))return undefined;const s=outboundLaunchRecordSelection(config);
    return createHash("sha256").update(JSON.stringify(["abby.outbound-launch-record-owner.v1",s.scope.tenantId,s.scope.clinicId,s.scope.locationId,
      s.businessId,s.credentialFingerprint,s.outboundAttemptRecallTypeId,s.attemptPolicyDigest])).digest("hex");
  }catch{return undefined;}
}
