import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { classBookingFixture } from "./class-booking.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

const input = JSON.parse(await new Promise<string>(resolve => { let text = "";
  process.stdin.on("data", part => { text += String(part); }); process.stdin.on("end", () => resolve(text)); }));
const providerPort: typeof fetch = async (value, init) => {
  const original = new URL(String(value)); if (original.origin !== "https://api.au5.cliniko.com") throw new Error("invalid synthetic provider");
  return fetch(input.proxy + original.pathname + original.search, { ...init, redirect: "error" });
};
const db = connectPostgres(process.env.DATABASE_URL!), apiKey = "synthetic-class-au5";
const budget = new PostgresClinikoRequestBudget(db, { apiKey });
try {
  if (input.mode === "recover") {
    const reader = resultValue(ClinikoRecallReader.create({ scope: input.scope, apiKey, contactEmail: "test@example.test", rateBudget: budget }, providerPort));
    const found = resultValue(await reader.discoverPendingReviews(input.scope, "7"));
    process.stdout.write(JSON.stringify({ pending: found.pending.length, valid: found.pending.filter(row => row.kind === "review").length,
      clinicalWrites: 0, replayed: false }) + "\n");
  } else {
    const f = await classBookingFixture({ scope: input.scope, folder: input.folder, budget,
      verificationBudget: new PostgresPatientVerificationBudget(db, input.scope), fetchAround: () => providerPort });
    try {
      await f.verify(); const action = await f.propose(); resultValue(await f.confirm()); resultValue(await f.drain());
      if ((await f.state()).actions[action.key]?.status !== "committed") throw new Error("synthetic class commit did not finish");
      await fetch(input.proxy + "/owner-finished", { method: "POST", body: "completed", signal: AbortSignal.timeout(15_000) });
    } finally { await f.close(); }
  }
} finally { await db.destroy(); }
