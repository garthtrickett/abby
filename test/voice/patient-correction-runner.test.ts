import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { sql } from "kysely";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
describe("private corrections through the actual compiled runner", { concurrency: 2 }, () => {
  for (const scenario of ["postcode", "email", "unknown", "revoked", "decline"] as const) {
    test(`E2E-365 compiled signed correction ${scenario} preserves private fields and separate confirmation`, options, async () => {
      await withClinicalRunner("patientUpdate", async call => {
        await call.say("I need to update my contact details."); await call.mark();
        assert.equal(call.mutations.length, 0);
        await call.verify();
        // Terms and the following acknowledgment question have separate completed playback.
        await call.mark();
        await voiceUntil(() => call.spoken.some(s => s.includes("accept these privacy")), "private correction consent prompt");
        await call.mark();
        if (scenario === "decline") {
          await call.keypad("*"); await call.quietAfterPrivateInput();
          assert.equal(call.mutations.length, 0); return;
        }
        await call.digit("1"); await call.mark();
        const choice = scenario === "email" ? "4" : "11";
        const beforePrompt = call.spoken.length;
        // digit() awaits a new prompt, so send the complete menu selection as one private entry.
        await call.keypad(`${choice}#`);
        await voiceUntil(() => call.spoken.length > beforePrompt, "chosen private field prompt"); await call.mark();
        const corrected = scenario === "email" ? "corrected-private@example.test" : "3999";
        if (scenario === "email") { await call.say("C-O-R-R-E-C-T-E-D", true); await call.mark(); await call.say("continue dash private at example dot test", true); }
        else await call.say(corrected, true);
        await call.mark();
        await call.digit("2"); await call.mark(); await call.mark();
        if (scenario === "email") {
          await voiceUntil(() => call.messages.filter(m => m.kind === "verificationEmail").length === 2, "prospective address code");
          const code = call.messages.filter(m => m.kind === "verificationEmail").at(-1)!.code!;
          await call.keypad(`${code}#`);
          await voiceUntil(() => call.spoken.at(-1)?.includes("Press pound to return") === true, "prospective proof completed"); await call.mark();
        }
        await call.keypad("#");
        await call.quietAfterPrivateInput();
        assert.equal(call.mutations.length, 0);
        if (scenario === "revoked") {
          call.child.send({ kind: "denyPermission" });
          await call.say("Prepare the correction."); await call.mark();
          assert.equal(call.mutations.length, 0);
          await call.scan(["corrected-private@example.test", "correction-chart-canary"]); return;
        }
        await call.say("Prepare the correction."); await call.mark();
        assert.equal(call.mutations.length, 0);
        if (scenario === "unknown") call.child.send({ kind: "loseWrite" });
        await call.say("Yes"); await call.mark();
        const patches = call.mutations.filter(m => m.method === "PATCH" && m.path?.startsWith("/v1/patients/"));
        assert.equal(patches.length, 1);
        assert.deepEqual(patches[0]!.body, scenario === "email" ? { email: corrected } : { post_code: corrected });
        assert.equal(call.mutations.filter(m => m.path === "/v1/recalls").length, 1);
        assert.equal(call.mutations.some(m => m.path?.includes("individual_appointments")), false);
        assert.equal(call.messages.filter(m => m.kind === "modelTurn").some(m => m.text?.includes(corrected)), false);
        const pending = await sql<{ count: string }>`select count(*)::text as count from cliniko_contact_changes`.execute(call.db);
        assert.equal(pending.rows[0]!.count, scenario === "unknown" ? "2" : "0");
        const revisions = await sql<{ version: number }>`select version from cliniko_contact_revisions order by credential_fingerprint`.execute(call.db);
        assert.deepEqual(revisions.rows.map(r => r.version), scenario === "unknown" ? [1, 1] : [2, 2]);
        await call.say("What happened?"); await call.mark();
        await call.say("Prepare the correction."); await call.mark();
        assert.equal(call.mutations.filter(m => m.method === "PATCH").length, 1);
        await call.scan(["corrected-private@example.test", "correction-chart-canary", "1980-01-02", "1 Example Road"]);
      });
    });
  }
});
