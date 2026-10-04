import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { emailFixture } from "./email-patient-fixture.ts";

let input = "";
for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 1_000) throw new Error("invalid restart fixture"); }
const config = JSON.parse(input) as { scope: { tenantId: string; clinicId: string; locationId: string }; code: string };
if (!process.env.DATABASE_URL) throw new Error("restart database missing");
const db = connectPostgres(process.env.DATABASE_URL);
try {
  const budget = new PostgresPatientVerificationBudget(db, config.scope);
  const f = emailFixture({ scope: config.scope, budget });
  // No start call and no challenge/grant are recovered from storage.
  const answered = await f.authority.answer(config.code);
  const issued = await budget.reserve(config.scope, "issue");
  process.stdout.write(JSON.stringify({ verified: answered.ok, issueAllowed: issued })+"\n");
} finally { await db.destroy(); }
