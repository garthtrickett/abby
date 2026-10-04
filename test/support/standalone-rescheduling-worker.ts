import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { reschedulingSessionFixture } from "./rescheduling-session.ts";
import { reschedulingAuthorityFixture } from "./rescheduling-authority.ts";
import { standaloneReschedulingFixture } from "./standalone-rescheduling.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
const input = JSON.parse(await new Promise<string>(resolve => { let text = "";
  process.stdin.on("data", part => { text += String(part); }); process.stdin.on("end", () => resolve(text)); }));
const providerPort: typeof fetch = async (value, init) => {
  const original = new URL(String(value)); if (original.origin !== "https://api.au5.cliniko.com") throw new Error("invalid synthetic request");
  return fetch(input.proxy+original.pathname+original.search, { ...init, redirect: "error" });
};
const db = connectPostgres(process.env.DATABASE_URL!), apiKey = "synthetic-session-au5";
const rateBudget = new PostgresClinikoRequestBudget(db, { apiKey });
try {
  if (input.mode === "recover") {
    const reader = resultValue(ClinikoRecallReader.create({ scope: input.scope, apiKey, contactEmail: "test@example.test", rateBudget }, providerPort));
    const found = resultValue(await reader.discoverPendingReviews(input.scope, "7"));
    process.stdout.write(JSON.stringify({ pending: found.pending.length, valid: found.pending.filter(item => item.kind === "review").length,
      clinicalWrites: 0, replayed: false })+"\n");
  } else {
    const app = await (input.session ? reschedulingSessionFixture : input.concrete ? reschedulingAuthorityFixture : standaloneReschedulingFixture)({ scope: input.scope, fetchPort: providerPort, rateBudget, folder: input.folder,
      verificationBudget: new PostgresPatientVerificationBudget(db, input.scope) });
    try {
      const ref = await app.verify();
      if ("proposalJourney" in app) await app.proposalJourney();
      else if ("proposeSelection" in app) resultValue(await app.proposeSelection(ref, await app.select(ref)));
      else resultValue(await app.propose(ref)); resultValue(await app.confirm());
      const finished = resultValue(await app.drain());
      if (Object.values(finished.actions)[0]?.status !== "committed") throw new Error("synthetic commit did not finish");
      await fetch(input.proxy+"/owner-finished", { method: "POST", body: "completed", signal: AbortSignal.timeout(15_000) });
    } finally { await app.close(); }
  }
} finally { await db.destroy(); }
