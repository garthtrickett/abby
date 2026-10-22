import { createHash } from "node:crypto";
import type { LocationScope } from "../../core/model.ts";
import { clinikoCredentialFingerprint, isClinikoRequestBudget } from "../read-budget.ts";
import type { ClinikoRequestBudget } from "../read-budget.ts";

/** Explicit outbound type/content selection, never a copied financial config. */
export type OutboundRecordConfig = Readonly<{
  scope: LocationScope; apiKey: string; contactEmail: string; businessId: string;
  outboundRecallTypeId: string; recordPolicyDigest: string;
  rateBudget: ClinikoRequestBudget; clock?: () => string; deadlineMs?: number;
}>;
export type OutboundRecordSelection = Readonly<{
  scope: LocationScope; businessId: string; credentialFingerprint: string;
  outboundRecallTypeId: string; recordPolicyDigest: string;
}>;
export const outboundNativeId = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
export function outboundConfigShard(config: OutboundRecordConfig, port: typeof fetch): string | undefined {
  try {
    const shard = typeof config?.apiKey === "string" ? /-([a-z]{2}[0-9]{1,2})$/.exec(config.apiKey)?.[1] : undefined;
    if (!shard || config.apiKey.length > 4096 || !config.apiKey.slice(0, -(shard.length+1)) || /[\u0000-\u0020\u007f]/.test(config.apiKey) ||
        !config.scope || typeof config.scope !== "object" || Array.isArray(config.scope) ||
        Object.keys(config.scope).sort().join(",") !== "clinicId,locationId,tenantId" ||
        !Object.values(config.scope).every(v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(v)) ||
        !outboundNativeId(config.businessId) || !outboundNativeId(config.outboundRecallTypeId) ||
        typeof config.recordPolicyDigest !== "string" || !/^[a-f0-9]{64}$/.test(config.recordPolicyDigest) ||
        typeof config.contactEmail !== "string" || config.contactEmail.length > 254 || !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(config.contactEmail) ||
        !isClinikoRequestBudget(config.rateBudget) || typeof port !== "function" || config.clock !== undefined && typeof config.clock !== "function" ||
        config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 15000)) return undefined;
    return shard;
  } catch { return undefined; }
}
export function outboundRecordSelection(config: OutboundRecordConfig): OutboundRecordSelection {
  return Object.freeze({ scope: Object.freeze({ ...config.scope }), businessId: config.businessId,
    credentialFingerprint: clinikoCredentialFingerprint(config.apiKey), outboundRecallTypeId: config.outboundRecallTypeId,
    recordPolicyDigest: config.recordPolicyDigest });
}
/** Non-patient configuration binding. This is not the private request digest. */
export function outboundRecordOwnerBinding(config: OutboundRecordConfig): string | undefined {
  if (!outboundConfigShard(config, fetch)) return undefined;
  const s = outboundRecordSelection(config);
  return createHash("sha256").update(JSON.stringify(["abby.outbound-record-owner.v1", s.scope.tenantId, s.scope.clinicId,
    s.scope.locationId, s.businessId, s.credentialFingerprint, s.outboundRecallTypeId, s.recordPolicyDigest])).digest("hex");
}
export { clinikoNativeInstant as outboundNativeInstant } from "./native-instant.ts";
