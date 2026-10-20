import type { Kysely } from "kysely";
import { ClinikoRecallReader } from "../cliniko/recalls.ts";
import type { ClinikoRecallQueuePulse } from "../cliniko/recalls.ts";
import type { ClinikoClinicScope } from "../cliniko/patients.ts";
import type Database from "../storage/generated/Database.ts";
import { PostgresClinikoRequestBudget } from "../storage/postgres-cliniko-request-budget.ts";
import { checkStandaloneTextDatabase } from "../storage/standalone-privacy-preflight.ts";

export type ClinikoQueuePulseConfig = Readonly<{ db: Kysely<Database>; scope: ClinikoClinicScope; apiKey: string; contactEmail: string;
  recallTypeId: string; timeZone: string; sharedBudgetUserRef?: string; fetchPort?: typeof fetch; now?: Date }>;

export function clinicQueueDate(now: Date, timeZone: string): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || typeof timeZone !== "string" || !timeZone.trim()) throw new Error("invalid report clock");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const field = (name: string) => parts.find(part => part.type === name)?.value;
  const date = `${field("year")}-${field("month")}-${field("day")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("invalid report clock"); return date;
}

/** The approved full recall type is a queue, not a per-patient or location-filtered chart read. */
export async function collectClinikoRecallQueuePulse(config: ClinikoQueuePulseConfig): Promise<ClinikoRecallQueuePulse> {
  const privacy = await checkStandaloneTextDatabase(config.db); if (!privacy.ok) throw new Error("recall queue report unavailable");
  const throughDate = clinicQueueDate(config.now ?? new Date(), config.timeZone);
  const budget = new PostgresClinikoRequestBudget(config.db, { apiKey: config.apiKey,
    ...(config.sharedBudgetUserRef ? { sharedUserRef: config.sharedBudgetUserRef } : {}) });
  const reader = ClinikoRecallReader.create({ scope: config.scope, apiKey: config.apiKey, contactEmail: config.contactEmail, rateBudget: budget }, config.fetchPort);
  if (!reader.ok) throw new Error("recall queue report unavailable");
  const pulse = await reader.value.queuePulse(config.scope, config.recallTypeId, throughDate);
  if (!pulse.ok) throw new Error("recall queue report unavailable"); return pulse.value;
}
