import { isDeepStrictEqual } from "node:util";
import { clinikoCredentialFingerprint } from "../read-budget.ts";
import { decodeAdministrativeMemo } from "../administrative-memo.ts";
import type { AdministrativeMemo, AdministrativeMemoAuthentication } from "../administrative-memo.ts";
import type { AdministrativeMemoConfig, NativeAdministrativeMemo } from "../administrative-memo-records.ts";

const object = (v: unknown): Record<string, unknown> | undefined => !!v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const link = (v: unknown) => object(object(v)?.links)?.self;
const numeric = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
export function administrativeMemoNativeInstant(v: unknown): string | undefined {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(v)) return;
  const n = Date.parse(v);
  return Number.isFinite(n) && new Date(Date.parse(v.slice(0, 10) + "T00:00:00Z")).toISOString().slice(0, 10) === v.slice(0, 10) ? new Date(n).toISOString() : undefined;
}
export function matchesAdministrativeMemo(m: AdministrativeMemo, c: AdministrativeMemoConfig, authentication: AdministrativeMemoAuthentication): boolean {
  return isDeepStrictEqual(m.scope, c.scope) && m.businessId === c.businessId && m.credentialFingerprint === clinikoCredentialFingerprint(c.apiKey) &&
    m.authorRef === c.authorRef && isDeepStrictEqual(m.policy, c.policy) && authentication.verify(m);
}
/** One native receipt decoder shared by exact writes, known reads and cold
 * discovery. Callers still own current grants, budget, body and deadline. */
export function parseNativeAdministrativeMemo(raw: unknown, selection: Readonly<{
  base: string; config: AdministrativeMemoConfig; authentication: AdministrativeMemoAuthentication; clock: () => string;
  patientId: string; actionRef: string; communicationRef?: string; content?: string;
}>): NativeAdministrativeMemo | undefined {
  const row = object(raw), createdAt = administrativeMemoNativeInstant(row?.created_at), updatedAt = administrativeMemoNativeInstant(row?.updated_at),
    archivedAt = row?.archived_at === null ? null : administrativeMemoNativeInstant(row?.archived_at);
  const decoded = decodeAdministrativeMemo(row?.content), s = selection;
  if (!row || !numeric(row.id) || link(row) !== `${s.base}/communications/${row.id}` || link(row.patient) !== `${s.base}/patients/${s.patientId}` ||
      row.category_code !== 12 || row.type_code !== 3 || row.confidential !== true || !decoded.ok || !matchesAdministrativeMemo(decoded.value, s.config, s.authentication) ||
      decoded.value.actionRef !== s.actionRef || decoded.value.patientId !== s.patientId ||
      row.direction_code !== (decoded.value.direction === "outbound" ? 1 : 2) || !createdAt || !updatedAt || createdAt > updatedAt || archivedAt === undefined ||
      Date.parse(createdAt) < Date.parse(decoded.value.recordedAt) - 30000 || Date.parse(updatedAt) > Date.parse(s.clock()) + 30000 ||
      s.content !== undefined && (row.content !== s.content || archivedAt !== null) ||
      s.communicationRef !== undefined && `cliniko:communication:${row.id}` !== s.communicationRef) return;
  return Object.freeze({ kind: "nativeAdministrativeMemo", communicationRef: `cliniko:communication:${row.id}`, memo: decoded.value, createdAt, updatedAt, archivedAt });
}
