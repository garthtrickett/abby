import type { LocationScope } from "../../core/model.ts";
import { clinikoCredentialFingerprint, isClinikoRequestBudget } from "../read-budget.ts";
import type { ClinikoRequestBudget } from "../read-budget.ts";
import { validRecallDate } from "../recall-note.ts";

export type ClinikoFinancialReviewSelection = Readonly<{
  scope: LocationScope; businessId: string; credentialFingerprint: string; recallTypeId: string;
  stripe: Readonly<{ accountRef: string; livemode: boolean }>;
}>;
export type ClinikoFinancialReviewConfig = Readonly<{
  scope: LocationScope; apiKey: string; contactEmail: string; businessId: string; recallTypeId: string;
  stripe: Readonly<{ accountRef: string; livemode: boolean }>;
  /** Same physical-account budget as the other native adapters; no default headroom. */
  rateBudget: ClinikoRequestBudget; clock?: () => string; deadlineMs?: number;
}>;
const id = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
export function financialConfigShard(config: ClinikoFinancialReviewConfig, port: typeof fetch): string | undefined {
  try {
    const shard = typeof config?.apiKey === "string" ? /-([a-z]{2}[0-9]{1,2})$/.exec(config.apiKey)?.[1] : undefined;
    if (!shard || config.apiKey.length > 4_096 || !config.apiKey.slice(0, -(shard.length + 1)) ||
        /[\u0000-\u0020\u007f]/.test(config.apiKey) || (!config.scope || typeof config.scope !== "object" || Array.isArray(config.scope)) ||
        ![config.scope.tenantId, config.scope.clinicId, config.scope.locationId].every(v =>
          typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)) ||
        !id(config.businessId) || !id(config.recallTypeId) || typeof config.contactEmail !== "string" ||
        config.contactEmail.length > 254 || !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(config.contactEmail) ||
        typeof config.stripe?.accountRef !== "string" || !/^acct_[A-Za-z0-9]{1,128}$/.test(config.stripe.accountRef) ||
        typeof config.stripe.livemode !== "boolean" || !isClinikoRequestBudget(config.rateBudget) || typeof port !== "function" ||
        config.clock !== undefined && typeof config.clock !== "function" ||
        config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 15_000)) return undefined;
    return shard;
  } catch { return undefined; }
}
export function financialSelection(config: ClinikoFinancialReviewConfig): ClinikoFinancialReviewSelection {
  return Object.freeze({ scope: Object.freeze({ tenantId: config.scope.tenantId, clinicId: config.scope.clinicId,
    locationId: config.scope.locationId }), businessId: config.businessId, recallTypeId: config.recallTypeId,
    credentialFingerprint: clinikoCredentialFingerprint(config.apiKey),
    stripe: Object.freeze({ accountRef: config.stripe.accountRef, livemode: config.stripe.livemode }) });
}
export function financialRecordInstant(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40 || !validRecallDate(value.slice(0, 10)) ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
