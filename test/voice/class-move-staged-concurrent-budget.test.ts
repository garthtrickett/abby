// E2E-419 source preparation: staged allocation versus another account consumer.
import assert from "node:assert/strict";
import test from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { prepareSignedStagedReplacement, prepareSignedStagedPhase } from "../support/staged-class-move-journey.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-419 compiled staged allocation survives a separate account consumer and still needs fresh phase consent", {
  // At most three real quota windows plus60s serving/scanning. Existing cases unchanged.
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 240000,
}, async () => {
  await withClinicalRunner("reschedule", async call => {
    call.child.send({ kind: "holdClassReplacement" });
    await voiceUntil(() => call.messages.some(row => row.kind === "classReplacementHoldArmed"), "replacement hold armed");
    const initial = prepareSignedStagedReplacement(call, { waits: 3 });
    // Observe rejection immediately while preserving the original promise for cleanup.
    let preparationFailed = false;
    void initial.catch(() => { preparationFailed = true; });
    try {
      await voiceUntil(() => preparationFailed || call.messages.some(row => row.kind === "classReplacementHeld"),
        "staged replacement reached its own allocation", 120000);
      if (preparationFailed) await initial;
      const outsider = new PostgresClinikoRequestBudget(call.db, { apiKey: "synthetic-key-au5", maxPerMinute: 180 });
      const held = await call.db.selectFrom("cliniko_request_reservations").selectAll().execute();
      const before = await call.db.selectFrom("cliniko_request_budgets").selectAll().execute();
      assert.equal(held.length, 1); assert.ok(held[0]!.remaining > 0 && held[0]!.remaining < 180);
      assert.equal(before.length, 1); const sentAt = before[0]!.sent_at_ms; assert.ok(Array.isArray(sentAt));
      const used = sentAt.length, reserved = held[0]!.remaining;
      assert.ok(used + reserved <= 180);
      // These actual SQL claims are from the test parent, a separate process
      // from serving. They model competing account usage, not clinical writes.
      let claimed = 0, denied = false;
      for (let index = 0; index <= 180; index++) {
        const result = await outsider.claim();
        if (result) { assert.equal(result.kind, "rateLimited"); denied = true; break; }
        claimed++;
      }
      assert.equal(denied, true); assert.equal(claimed, 180 - used - reserved);
      const unchanged = await call.db.selectFrom("cliniko_request_reservations").selectAll().execute();
      assert.deepEqual(unchanged, held, "another account client cannot consume or release the held stage allowance");
      assert.equal((await outsider.checkHeadroom(1))?.kind, "rateLimited");
      assert.equal((await outsider.withReservation(1, new AbortController().signal,
        async () => assert.fail("competing client stole held stage capacity"))).kind, "denied");
    } finally { call.child.send({ kind: "releaseClassReplacement" }); await initial; }
    const writes = () => call.mutations.filter(row => row.path?.startsWith("/v1/attendees"));
    assert.equal(writes().length, 1); assert.match(call.spoken.at(-1)!, /overall class move is not confirmed/);
    await prepareSignedStagedPhase(call, "original"); assert.equal(writes().length, 1);
    await call.mark(); await call.say("Yes"); await call.mark();
    assert.equal(call.spoken.at(-1), "Your class move is confirmed.");
    assert.deepEqual(writes().map(row => [row.method, row.path]), [["POST", "/v1/attendees"], ["PATCH", "/v1/attendees/101/cancel"]]);
    assert.equal(call.mutations.filter(row => row.path === "/v1/recalls").length, 1);
    assert.ok(call.spoken.filter(words => /wait about \d+ seconds/.test(words)).length <= 3);
    const budgets = await call.db.selectFrom("cliniko_request_budgets").selectAll().execute();
    assert.ok(budgets.length && budgets.every(row => row.max_per_minute === 180 && Array.isArray(row.sent_at_ms) && row.sent_at_ms.length <= 180));
    assert.equal((await call.db.selectFrom("cliniko_request_reservations").selectAll().execute()).length, 0);
    const envelope = resultValue(decodeClinikoReview(call.mutations.find(row => row.path === "/v1/recalls")!.body?.notes));
    assert.equal(envelope.request.operation.kind, "classMove");
    if (envelope.request.operation.kind !== "classMove") throw new Error("class move review required");
    const payload = String(call.mutations.find(row => row.path === "/v1/recalls")!.body?.notes).split("\n").find(line => line.startsWith("z1:"));
    assert.ok(payload);
    const secrets = [...call.messages.filter(row => row.kind === "verificationEmail").flatMap(row => [row.code!, row.email!]),
      ...verificationCanaries.slice(0, 2), envelope.request.operation.attendanceActionId, "staff-class-review:",
      ...Array.from({ length: Math.ceil(payload.length / 200) }, (_, index) => payload.slice(Math.min(index * 200, payload.length - 4), (index + 1) * 200))];
    const publicOutput = JSON.stringify([call.spoken, call.messages.filter(row => row.kind === "modelTurn" || row.kind === "ordinaryFinal")]);
    for (const value of [...secrets, envelope.request.patientId, "+61400111222", "lease_ref"]) assert.equal(publicOutput.includes(value), false);
    assert.deepEqual(resultValue(await scanPatientDataCanaries(call.db, [{ label: "patient", value: envelope.request.patientId }, { label: "phone", value: "+61400111222" }])),
      [{ label: "phone", table: "patient_phone_index", column: "normalized_phone" }, { label: "patient", table: "patient_phone_index", column: "patient_id" }]);
    for (let offset = 0; offset < secrets.length; offset += 12) {
      const values = secrets.slice(offset, offset + 12); await call.scan(values);
      assert.deepEqual(await scanDisposableBackupCanaries(call.connectionString, values.map((value, index) => ({ label: `concurrent_${index}`, value }))), []);
    }
  }, { classes: true, classQuotaStaging: true });
});
