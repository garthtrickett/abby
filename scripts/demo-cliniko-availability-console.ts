import { resolve } from "node:path";
import { ClinikoAvailabilityReader } from "../src/cliniko/availability.ts";
import { StandaloneAvailabilityTextRunner } from "../src/standalone/availability-text-runner.ts";
import { createAvailabilityConsoleServer } from "../src/standalone/availability-console/server.ts";
import { connectPostgres } from "../src/storage/connect.ts";
import { checkStandaloneTextDatabase } from "../src/storage/standalone-privacy-preflight.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("missing configuration");
  return value;
}

async function main(): Promise<void> {
  const scope = { tenantId: required("ABBY_TENANT_ID"), clinicId: required("ABBY_CLINIC_ID"),
    locationId: required("ABBY_LOCATION_ID") };
  const reader = ClinikoAvailabilityReader.create({ scope,
    apiKey: required("ABBY_CLINIKO_API_KEY"), contactEmail: required("ABBY_CLINIKO_CONTACT_EMAIL"),
    businessId: required("ABBY_CLINIKO_BUSINESS_ID"), practitionerId: required("ABBY_CLINIKO_PRACTITIONER_ID"),
    appointmentTypeId: required("ABBY_CLINIKO_APPOINTMENT_TYPE_ID") });
  if (!reader.ok) throw new Error("invalid Cliniko configuration");
  const db = connectPostgres(required("DATABASE_URL"));
  try {
    const safe = await checkStandaloneTextDatabase(db);
    if (!safe.ok) throw new Error("standalone database privacy preflight failed");
    const runner = new StandaloneAvailabilityTextRunner(db, scope, reader.value);
    const server = await createAvailabilityConsoleServer(runner, resolve("dist/availability-console/app.js"));
    const rawPort = process.env.ABBY_AVAILABILITY_PORT ?? "3401";
    const port = Number(rawPort);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
    try {
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => { server.off("error", reject); done(); });
      });
      process.stdout.write(`Abby availability console: http://127.0.0.1:${port}\n`);
      await new Promise<void>(done => {
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
    } finally {
      await new Promise<void>(done => server.close(() => done()));
    }
  } finally { await db.destroy(); }
}

try { await main(); }
catch { process.stderr.write("Availability console could not start. Check configuration and database safety.\n"); process.exitCode = 1; }
