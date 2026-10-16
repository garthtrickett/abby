import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sql } from "kysely";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
describe("private correction edits through the compiled runner", { concurrency: 2 }, () => {
  for (const point of ["afterReadback", "afterPreparation", "prospectiveEmail", "resetFields"] as const) {
    test(`E2E-367 compiled correction edit ${point} withdraws previous evidence and confirms only revised fields`, options, async () => {
      await withClinicalRunner("patientUpdate", async call => {
        await call.say("I need to update my contact details."); await call.mark();
        await call.verify(); await call.mark();
        await voiceUntil(() => call.spoken.some(s => s.includes("accept these privacy")), "private consent prompt");
        await call.mark(); await call.digit("1"); await call.mark();
        const field = point === "prospectiveEmail" ? "4" : "11";
        const enterField = async (value: string) => {
          const before = call.spoken.length; await call.keypad(`${field}#`);
          await voiceUntil(() => call.spoken.length > before, "private edit field prompt"); await call.mark();
          await call.say(value, true); await call.mark();
          await call.digit("2"); await call.mark(); await call.mark();
        };
        if (point === "resetFields") {
          const before = call.spoken.length; await call.keypad("9#");
          await voiceUntil(() => call.spoken.length > before, "private city prompt"); await call.mark();
          await call.say("discarded-private-city", true); await call.mark();
          await call.digit("1"); await call.mark();
        }
        const previous = point === "prospectiveEmail" ? "old-private@example.test" : "3001";
        await enterField(previous);
        if (point === "afterPreparation") {
          await call.keypad("#"); await call.quietAfterPrivateInput();
          await call.say("Prepare the correction."); await call.mark();
          assert.equal(call.mutations.length, 0);
        }
        // Pound before any prospective-code digits returns to edits; ready callers use one.
        await call.digit(point === "prospectiveEmail" ? "#" : point === "resetFields" ? "3" : "1"); await call.mark();
        if (point === "afterPreparation") {
          call.child.send({ kind: "inspectCorrectionState" });
          await voiceUntil(() => call.messages.some(m => m.kind === "correctionState"), "actual transient correction action state");
          assert.equal(call.messages.find(m => m.kind === "correctionState")!.actionStatus, "canceled");
        }
        const corrected = point === "prospectiveEmail" ? "revised-private@example.test" : "3999";
        await enterField(corrected);
        if (point === "prospectiveEmail") {
          await voiceUntil(() => call.messages.filter(m => m.kind === "verificationEmail").length === 3, "revised prospective challenge");
          const code = call.messages.filter(m => m.kind === "verificationEmail").at(-1)!.code!;
          await call.keypad(`${code}#`);
          await voiceUntil(() => call.spoken.at(-1)?.includes("Press pound to return") === true, "revised address verified"); await call.mark();
        }
        await call.keypad("#"); await call.quietAfterPrivateInput();
        assert.equal(call.mutations.length, 0);
        await call.say("Prepare the correction."); await call.mark();
        assert.equal(call.mutations.length, 0);
        await call.say("Yes"); await call.mark();
        const patches = call.mutations.filter(m => m.method === "PATCH");
        assert.equal(patches.length, 1);
        assert.deepEqual(patches[0]!.body, point === "prospectiveEmail" ? { email: corrected } : { post_code: corrected });
        assert.equal(call.mutations.filter(m => m.path === "/v1/recalls").length, 1);
        assert.equal(call.messages.filter(m => m.kind === "modelTurn").some(m => m.text?.includes(previous) || m.text?.includes(corrected)), false);
        const pending = await sql<{ count: string }>`select count(*)::text as count from cliniko_contact_changes`.execute(call.db);
        assert.equal(pending.rows[0]!.count, "0");
        await call.scan(["discarded-private-city", "old-private@example.test", "revised-private@example.test", "correction-chart-canary", "1980-01-02", "1 Example Road"]);
      });
    });
  }
});
