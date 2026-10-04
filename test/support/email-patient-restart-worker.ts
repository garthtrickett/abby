import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { emailFixture } from "./email-patient-fixture.ts";

let input = "";
for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 1_000) throw new Error("invalid restart fixture"); }
const config = JSON.parse(input) as { scope: { tenantId: string; clinicId: string; locationId: string };
  mode: "issue" | "answer"; code?: string; proxy?: string };
if (!process.env.DATABASE_URL) throw new Error("restart database missing");
const db = connectPostgres(process.env.DATABASE_URL);
try {
  const budget = new PostgresPatientVerificationBudget(db, config.scope);
  if (config.mode === "issue") {
    const proxy = new URL(config.proxy!);
    if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1") throw new Error("invalid restart proxy");
    const f = emailFixture({ scope: config.scope, budget, delivery: async (_email, code, signal) => {
      const response = await fetch(`${proxy.origin}/email`, { method: "POST", body: code, signal }); return response.ok;
    } });
    await f.authority.start("appointments.read");
    // The provider accepted the code and start installed the volatile challenge.
    // Hold here until the parent SIGKILLs the owner; never print the code.
    await fetch(`${proxy.origin}/ready`, { method: "POST" });
    throw new Error("owner survived synthetic kill checkpoint");
  }
  if (config.mode !== "answer" || typeof config.code !== "string") throw new Error("invalid restart mode");
  const f = emailFixture({ scope: config.scope, budget });
  // No start call and no challenge/grant are recovered from storage.
  const answered = await f.authority.answer(config.code);
  const issued = await budget.reserve(config.scope, "issue");
  process.stdout.write(JSON.stringify({ verified: answered.ok, issueAllowed: issued })+"\n");
} finally { await db.destroy(); }
