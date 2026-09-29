import { ClinikoPatientCandidateReader } from "../src/cliniko/patients.ts";
import { ClinikoPhoneLookup } from "../src/standalone/cliniko-phone-lookup.ts";
import { PhoneIndexRefreshWorker } from "../src/standalone/phone-index-refresh-worker.ts";
import { connectPostgres } from "../src/storage/connect.ts";
import { PostgresPatientPhoneIndex } from "../src/storage/postgres-patient-phone-index.ts";
import { PostgresPatientPhoneScan } from "../src/storage/postgres-patient-phone-scan.ts";
import { PostgresPhoneRefreshGuard } from "../src/storage/postgres-phone-refresh-guard.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const scope = { tenantId: required("ABBY_TENANT_ID"), clinicId: required("ABBY_CLINIC_ID") };
const refreshEveryMs = Number(process.env.ABBY_PHONE_REFRESH_EVERY_MS ?? 900_000);
const pollEveryMs = Number(process.env.ABBY_PHONE_REFRESH_POLL_MS ?? 60_000);
const reader = ClinikoPatientCandidateReader.create({ scope, apiKey: required("ABBY_CLINIKO_API_KEY"),
  contactEmail: required("ABBY_CLINIKO_CONTACT_EMAIL") });
if (!reader.ok) throw new Error(`invalid Cliniko phone-index configuration: ${reader.error.kind}`);
const connectionString = required("DATABASE_URL");
const db = connectPostgres(connectionString);
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
try {
  const index = new PostgresPatientPhoneIndex(db);
  const lookup = new ClinikoPhoneLookup(reader.value, index, required("ABBY_COUNTRY_CALLING_CODE"),
    refreshEveryMs * 2, undefined, new PostgresPatientPhoneScan(db));
  const worker = new PhoneIndexRefreshWorker(index, [{ scope, lookup, refreshEveryMs }],
    undefined, new PostgresPhoneRefreshGuard(connectionString));
  await worker.runLoop(stop.signal, pollEveryMs, results => {
    for (const result of results) process.stdout.write(`phone-index refresh: ${result.kind}\n`);
  });
} finally {
  await db.destroy();
}
