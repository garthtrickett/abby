import { fileURLToPath } from "node:url";
import { connectPostgres } from "../src/storage/connect.ts";
import { PostgresOperationalCounters } from "../src/storage/postgres-operational-counters.ts";
import type { OperationalCounterKind, OperationalDailyCounts } from "../src/voice/operational-counts.ts";
import { parseThresholds } from "../src/standalone/operational-alert.ts";
export { parseThresholds } from "../src/standalone/operational-alert.ts";

type Thresholds = Readonly<Partial<Record<OperationalCounterKind, number>>>;

function crossedDayThresholds(day: OperationalDailyCounts["days"][number], thresholds: Thresholds) {
  return Object.entries(thresholds).sort(([a], [b]) => a.localeCompare(b)).flatMap(([kind, threshold]) => {
    const count = day.counts[kind as OperationalCounterKind];
    return count >= threshold! ? [{ kind, count, threshold }] : [];
  });
}

export function crossedThresholds(daily: OperationalDailyCounts, thresholds: Thresholds) {
  const today = daily.days.at(-1);
  if (!today) throw new RangeError("operational day unavailable");
  return crossedDayThresholds(today, thresholds);
}

/** One clinic's retained UTC days; no patient, call, or credential fields leave this process. */
export async function checkVoiceOperationsWindow(env: NodeJS.ProcessEnv): Promise<Readonly<{
  date: string; days: readonly Readonly<{ date: string; alerts: ReturnType<typeof crossedThresholds> }>[];
}>> {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new RangeError("operational threshold check unavailable");
    return value;
  };
  const thresholds = parseThresholds(required("ABBY_VOICE_OPS_THRESHOLDS_JSON"));
  const scope = { tenantId: required("ABBY_TENANT_ID"), clinicId: required("ABBY_CLINIC_ID"),
    locationId: required("ABBY_LOCATION_ID") };
  const db = connectPostgres(required("DATABASE_URL"));
  try {
    const daily = await new PostgresOperationalCounters(db).daily(scope);
    const today = daily.days.at(-1);
    if (!today) throw new RangeError("operational day unavailable");
    return { date: today.date, days: daily.days.map(day => ({
      date: day.date, alerts: crossedDayThresholds(day, thresholds),
    })) };
  } finally { await db.destroy(); }
}

/** Today's threshold status for the owner CLI. */
export async function checkVoiceOperations(env: NodeJS.ProcessEnv): Promise<Readonly<{
  date: string; alerts: ReturnType<typeof crossedThresholds>;
}>> {
  const window = await checkVoiceOperationsWindow(env);
  return { date: window.date, alerts: window.days.at(-1)!.alerts };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 2) throw new RangeError("invalid arguments");
    const result = await checkVoiceOperations(process.env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.alerts.length) process.exitCode = 2;
  } catch {
    process.stderr.write("operational threshold check unavailable\n");
    process.exitCode = 1;
  }
}
