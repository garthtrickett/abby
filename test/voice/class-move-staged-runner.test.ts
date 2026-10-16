// E2E-419: actual compiled signed voice, separate native phases and private renewal.
import assert from "node:assert/strict";
import test from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { affirmClassPassMove } from "../support/class-pass-move-runner.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

type Call = Parameters<Parameters<typeof withClinicalRunner>[1]>[0];
const writes = (call: Call) => call.mutations.filter(row => row.path?.startsWith("/v1/attendees"));
async function waitForQuota(call: Call, seconds: number) {
  assert.ok(Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 60);
  const before = writes(call).length, clocks = call.messages.filter(row => row.kind === "clockAdvanced").length;
  let sent = 0;
  // Real elapsed time releases the actual PostgreSQL budget. Synthetic clock
  // ticks and silent media preserve the existing lease and age the real proof;
  // no stored budget timestamp, limit, deadline or reservation is edited.
  const tick = () => { sent++; call.child.send({ kind: "advanceClock", milliseconds: 1000 }); };
  const ticks = setInterval(tick, 1000);
  const quiet = setInterval(() => call.media(false), 20);
  try { await new Promise<void>(resolve => setTimeout(resolve, seconds * 1000 + 500)); }
  finally { clearInterval(ticks); clearInterval(quiet); }
  // Timer scheduling must not make the proof-age assertion probabilistic.
  while (sent < seconds) { tick(); call.media(false); await voiceUntil(() => call.messages.filter(row => row.kind === "clockAdvanced").length >= clocks + sent, "bounded phase clock tick"); }
  await voiceUntil(() => call.messages.filter(row => row.kind === "clockAdvanced").length >= clocks + sent, "quota-window proof age");
  assert.equal(writes(call).length, before, "waiting cannot dispatch a stage");
}
for (const pass of [false, true]) test(`E2E-419 compiled signed ${pass ? "maximum-history cross-case pass" : "ordinary"} move requires every played phase`, {
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: pass ? 300000 : 180000,
}, async () => {
  await withClinicalRunner("reschedule", async call => {
    await call.say("Start"); await call.mark(); await call.verify();
    await call.say("Appointments"); await call.mark(); await call.say("The first time please."); await call.mark();
    await call.say("Times"); await call.mark(); await call.say("The first time please.");
    assert.match(call.spoken.at(-1)!, /Move only your/); assert.equal(writes(call).length, 0); await call.mark();
    await affirmClassPassMove(call);
    assert.equal(writes(call).length, 1); assert.match(call.spoken.at(-1)!, /overall class move is not confirmed/);
    await call.mark();
    for (const [index, stage] of (pass ? ["original", "association", "associationInspection"] : ["original"]).entries()) {
      const count = writes(call).length, mailCount = call.messages.filter(row => row.kind === "verificationEmail").length;
      await call.say("Continue my class move"); assert.equal(writes(call).length, count);
      for (let attempt = 0; attempt < 4; attempt++) {
        const wait = /wait about (\d+) seconds, then ask to continue/.exec(call.spoken.at(-1)!);
        if (wait) {
          await call.mark(); await waitForQuota(call, Number(wait[1]));
          await call.say("Continue my class move"); assert.equal(writes(call).length, count); continue;
        }
        if (/registered email again/.test(call.spoken.at(-1)!)) {
          await call.mark();
          await voiceUntil(() => call.messages.filter(row => row.kind === "verificationEmail").length > mailCount, "fresh private phase verification");
          await call.verify(); await call.say("Continue my class move"); assert.equal(writes(call).length, count); continue;
        }
        break;
      }
      const words = stage === "original" ? /separate confirmation to cancel the original/ : stage === "association" ? /separate confirmation to associate the replacement/ : /separate confirmation to inspect whether/;
      assert.match(call.spoken.at(-1)!, words);
      await call.mark(); await call.say("Yes");
      assert.equal(writes(call).length, count + (stage === "associationInspection" ? 0 : 1));
      assert.equal(call.messages.filter(row => row.kind === "classWriteOutcome").at(-1)!.actionStatus,
        "classMovement", "native receipt remains a staged movement receipt through final inspection");
      if (pass && index < 2) assert.match(call.spoken.at(-1)!, /overall class move is not confirmed/);
      await call.mark();
    }
    assert.equal(call.spoken.at(-1), "Your class move is confirmed.");
    const timings = call.messages.filter(row => row.kind === "classTurnTiming");
    assert.ok(timings.length > 0 && timings.every(row => typeof row.aheadByMs === "number" && row.aheadByMs <= 0),
      "the actual synthetic speech turn cannot outrun the captured host clock");
    assert.deepEqual(writes(call).map(row => [row.method, row.path]), pass ?
      [["POST", "/v1/attendees"], ["PATCH", "/v1/attendees/101/cancel"], ["PATCH", "/v1/attendees/401"]] :
      [["POST", "/v1/attendees"], ["PATCH", "/v1/attendees/101/cancel"]]);
    if (pass) assert.ok(call.messages.filter(row => row.kind === "verificationEmail").length >= 2, "final inspection renews the private same-patient proof");
    const rows = await call.db.selectFrom("cliniko_request_budgets").selectAll().execute();
    assert.ok(rows.length > 0 && rows.every(row => row.max_per_minute === 180 && Array.isArray(row.sent_at_ms) && row.sent_at_ms.length <= 180));
    assert.equal((await call.db.selectFrom("cliniko_request_reservations").selectAll().execute()).length, 0);
    // The actual phone lookup persists exactly its allowed phone-to-ID map.
    // Verify those columns explicitly; private grants, codes and clinical data
    // remain forbidden in every column and in the unfiltered backup.
    assert.deepEqual(await call.db.selectFrom("patient_phone_index").select(["normalized_phone", "patient_id"]).execute(),
      [{ normalized_phone: "+61400111222", patient_id: "482746192837465" }]);
    assert.deepEqual(resultValue(await scanPatientDataCanaries(call.db, [
      { label: "indexed_patient", value: "482746192837465" }, { label: "indexed_phone", value: "+61400111222" },
    ])), [{ label: "indexed_phone", table: "patient_phone_index", column: "normalized_phone" },
      { label: "indexed_patient", table: "patient_phone_index", column: "patient_id" }]);
    const codes = call.messages.filter(row => row.kind === "verificationEmail").map(row => row.code!);
    const payload = String(call.mutations.find(row => row.path === "/v1/recalls")!.body?.notes).split("\n").find(line => line.startsWith("z1:"));
    assert.ok(payload);
    const secrets = [...codes, ...verificationCanaries.slice(0, 2), "811222333444555666", "811222333444555667",
      "private-move-source-entitlement", "private-move-destination-entitlement", "staff-class-review:", "synthetic-private-move-pass-note",
      ...Array.from({ length: Math.ceil(payload.length / 200) }, (_, i) => payload.slice(Math.min(i * 200, payload.length - 4), (i + 1) * 200))];
    const publicOutput = JSON.stringify([call.spoken, call.messages.filter(row => ["modelTurn", "ordinaryFinal"].includes(row.kind))]);
    for (const value of [...secrets, "482746192837465", "+61400111222"]) assert.equal(publicOutput.includes(value), false);
    for (let offset = 0; offset < secrets.length; offset += 12) {
      const values = secrets.slice(offset, offset + 12);
      await call.scan(values);
      assert.deepEqual(await scanDisposableBackupCanaries(call.connectionString, values.map((value, i) => ({ label: `staged_${i}`, value }))), []);
    }
  }, { classes: true, classQuotaStaging: true, ...(pass ? { classPassMovement: "transfer", differentClass: true, multipleClasses: true, classPassHistory: 999, classRosterHistory: 201 } : {}) });
});
