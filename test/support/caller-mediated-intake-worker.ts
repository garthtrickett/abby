import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { intakeSessionFixture } from "./intake-session.ts";
import { intakeCredential, intakeNow } from "./intake-edge.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
const input = JSON.parse(await new Promise<string>(resolve => {
  let text = ""; process.stdin.on("data", part => { text += String(part); }); process.stdin.on("end", () => resolve(text));
}));
const db = connectPostgres(process.env.DATABASE_URL!);
const providerPort: typeof fetch = (value, init) => {
  const source = new URL(String(value)); if (source.origin !== "https://api.au5.cliniko.com") throw new Error("invalid synthetic provider");
  return fetch(input.proxy + source.pathname + source.search, { ...init, redirect: "error" });
};
try {
  const scope = { tenantId: "intake-policy", clinicId: "clinic", locationId: "main" };
  const f = await intakeSessionFixture({ rateBudget: new PostgresClinikoRequestBudget(db, { apiKey: intakeCredential }),
    verificationBudget: new PostgresPatientVerificationBudget(db, scope), fetchPort: providerPort, folder: input.folder });
  try {
    if (input.mode === "replacement") {
      const missing = await f.owner.resolveIntake({ scope, callId: f.callId, sessionId: f.sessionId, policyVersion: "policy-1", draftRef: "missing-lost-draft", now: intakeNow });
      await f.drain(); process.stdout.write(JSON.stringify({ resumed: missing.ok, created: f.posts, mail: f.mail.length, replayed: false })+"\n");
    } else {
      const ref = await f.prepare(); resultValue(await f.propose(ref)); resultValue(await f.confirm()); resultValue(await f.drain());
      if (Object.values((await f.state()).actions)[0]?.status !== "committed") throw new Error("synthetic intake failed");
      await fetch(input.proxy+"/owner-finished", { method: "POST", signal: AbortSignal.timeout(15_000) });
    }
  } finally { await f.close(); }
} finally { await db.destroy(); }
