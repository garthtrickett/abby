import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { cancellationFixture } from "./standalone-cancellation.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

const input = JSON.parse(await new Promise<string>(resolve => { let text = "";
  process.stdin.on("data", part => { text += String(part); }); process.stdin.on("end", () => resolve(text)); }));
const base = "https://api.au5.cliniko.com";
const providerPort: typeof fetch = async (value, init) => {
  const original = new URL(String(value));
  if (original.origin !== base) throw new Error("invalid synthetic provider request");
  return fetch(input.proxy+original.pathname+original.search, { ...init, redirect: "error" });
};
if (input.mode === "recover") {
  const reader = resultValue(ClinikoRecallReader.create({ scope: input.scope, apiKey: "synthetic-cancel-path-au5",
    contactEmail: "test@example.test" }, providerPort));
  const found = resultValue(await reader.discoverPendingReviews(input.scope, "7"));
  process.stdout.write(JSON.stringify({ pending: found.pending.length, valid: found.pending.filter(item => item.kind === "review").length,
    clinicalWrites: 0, replayed: false })+"\n");
} else {
  const db = connectPostgres(process.env.DATABASE_URL!);
  const app = await cancellationFixture("success", scope => new PostgresPatientVerificationBudget(db, scope),
    { scope: input.scope, fetchPort: providerPort });
  try {
    resultValue(await app.propose(await app.verify())); await app.confirm();
    const finished = await app.drain();
    if (Object.values(finished.actions)[0]?.status !== "committed") throw new Error("synthetic commit did not finish");
    await fetch(input.proxy+"/owner-finished", { method: "POST", body: "completed", signal: AbortSignal.timeout(15_000) });
  } finally { app.host.dispose(); app.email.close(); await db.destroy(); }
}
