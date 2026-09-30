import { ok } from "../src/core/model.ts";
import { referenceDefaultPolicy } from "../src/reference/policy-store.ts";
import { connectPostgres } from "../src/storage/connect.ts";
import { PostgresPolicyStore } from "../src/storage/postgres-policy-store.ts";
import { checkStandaloneTextDatabase } from "../src/storage/standalone-privacy-preflight.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action !== "enable" && action !== "disable") throw new Error("invalid action");
  if (required("ABBY_VOICE_TEST_MODE") !== "1") throw new Error("invalid ABBY_VOICE_TEST_MODE");
  const caller = required("ABBY_TWILIO_TEST_CALLER_NUMBER");
  const dialed = required("ABBY_TWILIO_TEST_NUMBER");
  const fallback = required("ABBY_TWILIO_FALLBACK_NUMBER");
  if ([caller, dialed, fallback].some(number => !/^\+[1-9]\d{1,14}$/.test(number)) ||
      new Set([caller, dialed, fallback]).size !== 3) throw new Error("invalid voice test numbers");
  const scope = { tenantId: required("ABBY_TENANT_ID"), clinicId: required("ABBY_CLINIC_ID"),
    locationId: required("ABBY_LOCATION_ID") };
  const expectedVersion = required("ABBY_AUTOMATION_EXPECTED_VERSION");
  if (!/^(0|[1-9]\d*)$/.test(expectedVersion)) throw new Error("invalid ABBY_AUTOMATION_EXPECTED_VERSION");
  const actor = required("ABBY_TEST_OPERATOR_REF");
  const db = connectPostgres(required("DATABASE_URL"));
  try {
    const privacy = await checkStandaloneTextDatabase(db);
    if (!privacy.ok) throw new Error("unsafe standalone storage");
    const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable",
      async () => ok(true), false, "standaloneMinimal");
    const result = await policy.changeAutomationEnabled(scope, expectedVersion, action === "enable", actor);
    if (!result.ok) throw new Error(`automation change refused: ${result.error.kind}`);
    process.stdout.write(`voice test automation ${action}d at version ${result.value.automationVersion}\n`);
  } finally { await db.destroy(); }
}

try { await main(); }
catch (error) {
  const message = error instanceof Error && /^(missing|invalid) ABBY_[A-Z0-9_]+$/.test(error.message)
    ? error.message : "voice test automation change failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
