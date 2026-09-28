import { readFileSync } from "node:fs";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";

type Input = Readonly<{
  apiKey: string;
  contactEmail: string;
  businessId: string;
  practitionerId: string;
  appointmentTypeId: string;
  date: string;
}>;

async function main(): Promise<void> {
  const input = JSON.parse(readFileSync(0, "utf8")) as Input;
  const scope = { tenantId: "demo-probe", clinicId: "demo-probe", locationId: "demo-probe" };
  const created = ClinikoAvailabilityReader.create({ scope, apiKey: input.apiKey, contactEmail: input.contactEmail,
    businessId: input.businessId, practitionerId: input.practitionerId, appointmentTypeId: input.appointmentTypeId });
  if (!created.ok) {
    process.stdout.write(JSON.stringify({ ok: false, reason: created.error.kind }) + "\n");
    process.exitCode = 1;
    return;
  }
  const result = await created.value.list(scope, input.date, input.date);
  if (!result.ok || result.value.kind !== "times") {
    process.stdout.write(JSON.stringify({ ok: false, reason: result.ok ? result.value.kind : result.error.kind }) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({ ok: true, kind: "times", count: result.value.startsAt.length,
    timeZone: result.value.timeZone, reservable: result.value.reservable }) + "\n");
}

await main();
