import { ClinikoAvailabilityReader } from "../src/cliniko/availability.ts";
import { StandaloneAvailabilityTextRunner } from "../src/standalone/availability-text-runner.ts";
import { connectPostgres } from "../src/storage/connect.ts";
import { checkStandaloneTextDatabase } from "../src/storage/standalone-privacy-preflight.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("missing configuration");
  return value;
}

async function input(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 8_192) throw new Error("invalid input");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function write(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve());
  });
  responseWritten = true;
}

let responseWritten = false;

async function main(): Promise<void> {
  const scope = { tenantId: required("ABBY_TENANT_ID"), clinicId: required("ABBY_CLINIC_ID"),
    locationId: required("ABBY_LOCATION_ID") };
  const reader = ClinikoAvailabilityReader.create({ scope,
    apiKey: required("ABBY_CLINIKO_API_KEY"), contactEmail: required("ABBY_CLINIKO_CONTACT_EMAIL"),
    businessId: required("ABBY_CLINIKO_BUSINESS_ID"), practitionerId: required("ABBY_CLINIKO_PRACTITIONER_ID"),
    appointmentTypeId: required("ABBY_CLINIKO_APPOINTMENT_TYPE_ID") });
  if (!reader.ok) { await write({ ok: false, error: reader.error }); process.exitCode = 1; return; }
  const db = connectPostgres(required("DATABASE_URL"));
  try {
    const safe = await checkStandaloneTextDatabase(db);
    if (!safe.ok) { await write(safe); process.exitCode = 1; return; }
    const request = await input();
    const runner = new StandaloneAvailabilityTextRunner(db, scope, reader.value);
    const prepared = await runner.prepare(request as Parameters<typeof runner.prepare>[0]);
    if (!prepared.ok) { await write(prepared); process.exitCode = 1; return; }
    await write({ ok: true, value: { status: prepared.value.status, message: prepared.value.message } });
    const acknowledged = await runner.confirmWritten(prepared.value);
    if (!acknowledged.ok) process.exitCode = 1;
  } finally { await db.destroy(); }
}

try { await main(); }
catch { if (!responseWritten) {
    try { await write({ ok: false, error: { kind: "unavailable" } }); } catch { /* stdout unavailable */ }
  }
  process.exitCode = 1; }
