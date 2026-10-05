import assert from "node:assert/strict";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { intakeBookingSessionFixture } from "./intake-booking-session.ts";
import { intakeCredential } from "./intake-edge.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

const input = JSON.parse(await new Promise<string>(resolve => {
  let value = ""; process.stdin.on("data", part => { value += String(part); }); process.stdin.on("end", () => resolve(value));
}));
const db = connectPostgres(process.env.DATABASE_URL!);
const providerPort: typeof fetch = (value, init) => {
  const source = new URL(String(value)); if (source.origin !== "https://api.au5.cliniko.com") throw new Error("invalid synthetic provider");
  return fetch(input.proxy+source.pathname+source.search, { ...init, redirect: "error" });
};
try {
  const scope = { tenantId: "intake-policy", clinicId: "clinic", locationId: "main" };
  const f = await intakeBookingSessionFixture({ rateBudget: new PostgresClinikoRequestBudget(db, { apiKey: intakeCredential, maxPerMinute: 200 }),
    verificationBudget: new PostgresPatientVerificationBudget(db, scope), fetchPort: providerPort, folder: input.folder });
  try {
    if (input.mode === "replacement") {
      assert.equal(await f.owner.intake.createdPatient(), undefined); resultValue(await f.readMenu()); resultValue(await f.drain());
      const reviews = resultValue(await f.discover());
      for (const item of reviews.pending) {
        assert.equal(item.kind, "review");
        if (item.kind === "review") {
          assert.equal(item.envelope.request.operation.kind, "book");
          assert.equal(item.envelope.request.patientId, "42");
          assert.equal(item.envelope.request.operation.startsAt, "2026-10-08T04:00:00.000Z");
        }
      }
      assert.equal(Object.values((await f.state()).actions).length, 0); assert.equal(f.mail.length, 0);
      process.stdout.write(JSON.stringify({ resumed: false, mail: 0, replayed: false, reviews: reviews.pending.length })+"\n");
    } else {
      await f.register(); await f.playPending();
      if (input.stage === "beforeReview") await fetch(input.proxy+"/checkpoint", { method: "POST", signal: AbortSignal.timeout(15_000) });
      resultValue(await f.readMenu()); await f.playPending(); resultValue(await f.select()); resultValue(await f.confirm("book")); resultValue(await f.drain());
      assert.equal(Object.values((await f.state()).actions).find(action => action.kind === "book")!.status, "committed");
      await fetch(input.proxy+"/checkpoint", { method: "POST", signal: AbortSignal.timeout(15_000) });
    }
  } finally { await f.close(); }
} finally { await db.destroy(); }
