import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import type { ClinikoRecallQueuePulse } from "../src/cliniko/recalls.ts";
import { collectClinikoRecallQueuePulse } from "../src/standalone/cliniko-queue-pulse.ts";
export { collectClinikoRecallQueuePulse } from "../src/standalone/cliniko-queue-pulse.ts";
import { connectPostgres } from "../src/storage/connect.ts";
import type Database from "../src/storage/generated/Database.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error("recall queue report unavailable");
  return value;
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
