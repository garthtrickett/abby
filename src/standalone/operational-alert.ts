import { createHmac } from "node:crypto";
import type { LocationScope } from "../core/model.ts";
import { emptyOperationalCounts } from "../voice/operational-counts.ts";
import type { OperationalCounterKind } from "../voice/operational-counts.ts";

export type OperationalAlertThresholds = Readonly<Partial<Record<OperationalCounterKind, number>>>;
export type AggregateAlertKind = OperationalCounterKind | "clinikoQueuePending" | "clinikoQueueOverdue" | "clinikoQueueUnavailable";
export type AggregateAlertThresholds = Readonly<Partial<Record<AggregateAlertKind, number>>>;
export type OperationalAlert = Readonly<{ date: string; kind: AggregateAlertKind; count: number; threshold: number }>;
const validKind = (kind: unknown): kind is AggregateAlertKind => typeof kind === "string" &&
  (Object.hasOwn(emptyOperationalCounts(), kind) || ["clinikoQueuePending", "clinikoQueueOverdue", "clinikoQueueUnavailable"].includes(kind));
export type OperationalAlertMessage = OperationalAlert & Readonly<{ schemaVersion: 1; alertKey: string }>;
export const validAlertScope = (scope: LocationScope) => scope && Object.keys(scope).sort().join("|") === "clinicId|locationId|tenantId" &&
  [scope.tenantId, scope.clinicId, scope.locationId].every(value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value));
export const validAlertDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

/** Unknown counters and nonpositive thresholds are not configuration. */
export function parseThresholds(raw: string): OperationalAlertThresholds {
  const value = parseAggregateAlertThresholds(raw);
  if (Object.keys(value).some(kind => !Object.hasOwn(emptyOperationalCounts(), kind))) throw new RangeError("invalid thresholds");
  return value as OperationalAlertThresholds;
}

/** Queue monitor counters do not become voice-runtime daily counter columns. */
export function parseAggregateAlertThresholds(raw: string): AggregateAlertThresholds {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length === 0) throw new RangeError("invalid thresholds");
  for (const [kind, threshold] of Object.entries(value)) {
    if (!validKind(kind) || !Number.isSafeInteger(threshold) || (threshold as number) < 1) throw new RangeError("invalid thresholds");
  }
  return value as AggregateAlertThresholds;
}

/** Same fixed clinic/date/counter/threshold identity across sender retries. */
export function operationalAlertKey(scope: LocationScope, date: string, kind: AggregateAlertKind, threshold: number, tokenHex: string): string {
  if (!validAlertScope(scope) || !validAlertDate(date) || !validKind(kind) ||
      !Number.isSafeInteger(threshold) || threshold < 1 || !/^[a-f0-9]{64}$/i.test(tokenHex)) throw new RangeError("invalid operational alert identity");
  return createHmac("sha256", Buffer.from(tokenHex, "hex"))
    .update(JSON.stringify([[scope.tenantId, scope.clinicId, scope.locationId], date, kind, threshold])).digest("hex");
}

export function validOperationalAlert(value: unknown): value is OperationalAlert {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join("|") === "count|date|kind|threshold" && validAlertDate(row.date) &&
    validKind(row.kind) &&
    Number.isSafeInteger(row.threshold) && (row.threshold as number) >= 1 && Number.isSafeInteger(row.count) && (row.count as number) >= (row.threshold as number);
}

export function decodeOperationalAlert(value: unknown): OperationalAlertMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join("|") !== "alertKey|count|date|kind|schemaVersion|threshold" || row.schemaVersion !== 1 ||
      typeof row.alertKey !== "string" || !/^[a-f0-9]{64}$/.test(row.alertKey)) return undefined;
  const { schemaVersion: _version, alertKey: _key, ...alert } = row;
  return validOperationalAlert(alert) ? { ...alert, schemaVersion: 1, alertKey: row.alertKey } : undefined;
}
