import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { ClinikoRecallReader } from "../src/cliniko/recalls.ts";
import type { ClinikoRecallQueuePulse } from "../src/cliniko/recalls.ts";
import type { ClinikoClinicScope } from "../src/cliniko/patients.ts";
import { connectPostgres } from "../src/storage/connect.ts";
import type Database from "../src/storage/generated/Database.ts";
import { PostgresClinikoRequestBudget } from "../src/storage/postgres-cliniko-request-budget.ts";
import { checkStandaloneTextDatabase } from "../src/storage/standalone-privacy-preflight.ts";

type PulseConfig = Readonly<{
  db: Kysely<Database>;
  scope: ClinikoClinicScope;
  apiKey: string;
  contactEmail: string;
  recallTypeId: string;
  timeZone: string;
  sharedBudgetUserRef?: string;
  fetchPort?: typeof fetch;
  now?: Date;
}>;

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error("recall queue report unavailable");
  return value;
}

function clinicDate(now: Date, timeZone: string): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      typeof timeZone !== "string" || !timeZone.trim()) throw new Error("invalid report clock");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric",
    month: "2-digit", day: "2-digit" }).formatToParts(now);
  const field = (name: string) => parts.find(part => part.type === name)?.value;
  const date = `${field("year")}-${field("month")}-${field("day")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("invalid report clock");
  return date;
}

/** Owner-run read only; the clinic's active recall data stays transient in this process. */
export async function collectClinikoRecallQueuePulse(config: PulseConfig): Promise<ClinikoRecallQueuePulse> {
  const privacy = await checkStandaloneTextDatabase(config.db);
  if (!privacy.ok) throw new Error("recall queue report unavailable");
  const throughDate = clinicDate(config.now ?? new Date(), config.timeZone);
  const budget = new PostgresClinikoRequestBudget(config.db, { apiKey: config.apiKey,
    ...(config.sharedBudgetUserRef ? { sharedUserRef: config.sharedBudgetUserRef } : {}) });
  const reader = ClinikoRecallReader.create({ scope: config.scope, apiKey: config.apiKey,
    contactEmail: config.contactEmail, rateBudget: budget }, config.fetchPort);
  if (!reader.ok) throw new Error("recall queue report unavailable");
  const pulse = await reader.value.queuePulse(config.scope, config.recallTypeId, throughDate);
  if (!pulse.ok) throw new Error("recall queue report unavailable");
  return pulse.value;
}

/** Drop scope, identifiers, notes and patient data even if a host adds fields later. */
export function publicRecallQueuePulse(pulse: ClinikoRecallQueuePulse) {
  return { schemaVersion: 1, kind: "cliniko-recall-queue-pulse" as const,
    observedAt: pulse.observedAt, throughDate: pulse.throughDate,
    scanned: pulse.scanned, pending: pulse.pending, overdue: pulse.overdue,
    markedRecalled: pulse.markedRecalled };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let db: Kysely<Database> | undefined;
  try {
    if (process.argv.length !== 2) throw new Error("invalid report arguments");
    db = connectPostgres(required("DATABASE_URL"));
    const pulse = await collectClinikoRecallQueuePulse({ db,
      scope: { tenantId: required("ABBY_TENANT_ID"), clinicId: required("ABBY_CLINIC_ID") },
      apiKey: required("ABBY_CLINIKO_API_KEY"),
      contactEmail: required("ABBY_CLINIKO_CONTACT_EMAIL"),
      recallTypeId: required("ABBY_CLINIKO_RECALL_TYPE_ID"),
      timeZone: required("ABBY_CLINIKO_RECALL_TIME_ZONE"),
      ...(process.env.ABBY_CLINIKO_BUDGET_USER_REF
        ? { sharedBudgetUserRef: process.env.ABBY_CLINIKO_BUDGET_USER_REF } : {}) });
    process.stdout.write(`${JSON.stringify(publicRecallQueuePulse(pulse))}\n`);
  } catch {
    process.stderr.write("recall queue report unavailable\n");
    process.exitCode = 1;
  } finally {
    try { await db?.destroy(); }
    catch {
      process.stderr.write("recall queue report unavailable\n");
      process.exitCode = 1;
    }
  }
}
