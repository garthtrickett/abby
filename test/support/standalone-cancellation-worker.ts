import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { cancellationSessionFixture } from "./cancellation-session.ts";
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
  const db = input.composed ? connectPostgres(process.env.DATABASE_URL!) : undefined;
  try {
    const apiKey = input.composed ? "synthetic-session-au5" : "synthetic-cancel-path-au5";
    const reader = resultValue(ClinikoRecallReader.create({ scope: input.scope, apiKey,
      contactEmail: "test@example.test", ...(db ? { rateBudget: new PostgresClinikoRequestBudget(db, { apiKey }) } : {}) }, providerPort));
    const found = resultValue(await reader.discoverPendingReviews(input.scope, "7"));
    process.stdout.write(JSON.stringify({ pending: found.pending.length, valid: found.pending.filter(item => item.kind === "review").length,
      clinicalWrites: 0, replayed: false })+"\n");
  } finally { await db?.destroy(); }
} else if (input.composed) {
  const db = connectPostgres(process.env.DATABASE_URL!);
  const app = await cancellationSessionFixture({ scope: input.scope, fetchPort: providerPort,
    budget: new PostgresPatientVerificationBudget(db, input.scope),
    rateBudget: new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-session-au5" }) });
  try {
    app.owner.beginVerification();
    const deadline = Date.now() + 5000;
    while (!app.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    if (!app.mail[0] || !(await app.owner.submitCode(app.mail[0].code)).verified) throw new Error("synthetic verification unavailable");
    const grant = await app.owner.verified(); if (!grant) throw new Error("synthetic proof unavailable");
    resultValue(await app.read(grant.verificationRef)); await app.playPending();
    resultValue(await app.propose(grant.verificationRef)); await app.confirm();
    const finished = resultValue(await app.drain());
    if (Object.values(finished.actions)[0]?.status !== "committed") throw new Error("synthetic commit did not finish");
    await fetch(input.proxy+"/owner-finished", { method: "POST", body: "completed", signal: AbortSignal.timeout(15_000) });
  } finally { await app.close(); await db.destroy(); }
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
