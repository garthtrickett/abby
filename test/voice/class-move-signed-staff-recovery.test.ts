// Prepared E2E-419 signed caller to independent cold staff observation.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { prepareSignedStagedReplacement, prepareSignedStagedPhase } from "../support/staged-class-move-journey.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import type { ClassMoveColdContext } from "../support/class-move-cold-context.ts";
import type { ClassMoveRecoveryStatus } from "../../src/standalone/cliniko-class-move-recovery.ts";

async function cold(context: ClassMoveColdContext, connectionString: string, allowed: boolean) {
  const input = { ...context, signedFixture: { resolutionAllowed: allowed } };
  const worker = fork(new URL("../support/class-move-recovery-worker.ts", import.meta.url), [], { execArgv: [],
    stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env, DATABASE_URL: connectionString }, signal: AbortSignal.timeout(30000) });
  const closed = once(worker, "close"); void closed.catch(() => {});
  let output = "", error = "";
  worker.stdout!.on("data", value => { output += String(value); }); worker.stderr!.on("data", value => { error += String(value); });
  try {
    worker.stdin!.end(JSON.stringify(input)); const [code] = await closed;
    if (!allowed) { assert.equal(code, 1); assert.equal(output, ""); }
    else { assert.equal(code, 0, error); }
    return { output, error, status: allowed ? (JSON.parse(output) as { status: ClassMoveRecoveryStatus }).status : undefined };
  } finally { if (worker.exitCode === null && worker.signalCode === null) { worker.kill("SIGKILL"); await closed; } }
}

test("E2E-419 signed uncertain staged movement stays ended while cold staff separately inspects native truth", {
  // Two caller quota windows, one fresh cold-account window and60s serving/scans.
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 240000,
}, async () => {
  await withClinicalRunner("reschedule", async call => {
    await prepareSignedStagedReplacement(call, { waits: 2 });
    await prepareSignedStagedPhase(call, "original"); await call.mark();
    call.child.send({ kind: "loseOriginal" }); await call.say("Yes");
    const nativeWrites = () => call.mutations.filter(row => row.path?.startsWith("/v1/attendees"));
    assert.deepEqual(nativeWrites().map(row => [row.method, row.path]), [["POST", "/v1/attendees"], ["PATCH", "/v1/attendees/101/cancel"]]);
    assert.match(call.spoken.at(-1)!, /not confirmed|can't confirm|couldn't confirm|unconfirmed/i);
    assert.notEqual(call.spoken.at(-1), "Your class move is confirmed.");
    await call.mark(); await call.endCallerForColdReview();
    const spoken = [...call.spoken], outcomes = call.messages.filter(row => row.kind === "classWriteOutcome"), mutationCount = call.mutations.length;
    const reviewRow = call.mutations.find(row => row.path === "/v1/recalls"); assert.ok(reviewRow);
    const envelope = resultValue(decodeClinikoReview(reviewRow.body?.notes)); assert.equal(envelope.request.operation.kind, "classMove");
    if (envelope.request.operation.kind !== "classMove") throw new Error("class review required");
    const payload = String(reviewRow.body?.notes).split("\n").find(line => line.startsWith("z1:")); assert.ok(payload);
    const privateValues = [...call.messages.filter(row => row.kind === "verificationEmail").flatMap(row => [row.code!, row.email!]),
      ...verificationCanaries.slice(0, 2), envelope.request.operation.attendanceActionId, "staff-class-review:",
      ...Array.from({ length: Math.ceil(payload.length / 200) }, (_, i) => payload.slice(Math.min(i * 200, payload.length - 4), (i + 1) * 200))];
    // Release only actual database time. No media, caller renewal or budget-row edits.
    await new Promise<void>(resolve => setTimeout(resolve, 60500));
    const clocks = call.messages.filter(row => row.kind === "clockAdvanced").length;
    for (const milliseconds of [15000, 15000, 15000, 15000, 500]) call.child.send({ kind: "advanceClock", milliseconds });
    await voiceUntil(() => call.messages.filter(row => row.kind === "clockAdvanced").length >= clocks + 5, "independent staff observation clock");
    const context = await call.coldReviewContext(), serialized = JSON.stringify(context);
    for (const value of [...privateValues, envelope.request.patientId, "+61400111222"]) assert.equal(serialized.includes(value), false);
    const auditBefore = await call.coldProviderAudit();
    const denied = await cold(context, call.connectionString, false), auditDenied = await call.coldProviderAudit();
    assert.equal(auditDenied.protectedReads, auditBefore.protectedReads, "investigation permission is separate from reading the selected admin review");
    const pending = await cold(context, call.connectionString, true);
    assert.equal(pending.status?.kind, "needsReview"); assert.equal(pending.status?.reviewAcknowledged, false);
    assert.deepEqual(pending.status?.progress, { original: "inspectedCancelled", replacement: "inspectedActive", caseAssociation: "notApplicable" });
    await call.acknowledgeColdReview(); // Separate synthetic-provider staff action; never a reader mutation.
    const acknowledged = await cold(context, call.connectionString, true), auditAfter = await call.coldProviderAudit();
    assert.equal(acknowledged.status?.kind, "reviewedMoved"); assert.equal(acknowledged.status?.reviewAcknowledged, true);
    assert.equal(auditAfter.nonGet, 0); assert.ok(auditAfter.protectedReads > auditDenied.protectedReads);
    assert.equal(call.mutations.length, mutationCount); assert.deepEqual(call.spoken, spoken);
    assert.deepEqual(call.messages.filter(row => row.kind === "classWriteOutcome"), outcomes, "staff observation cannot revive the ended caller action");
    const budget = await call.db.selectFrom("cliniko_request_budgets").selectAll().execute();
    assert.ok(budget.length && budget.every(row => row.max_per_minute === 180 && Array.isArray(row.sent_at_ms) && row.sent_at_ms.length <= 180));
    assert.equal((await call.db.selectFrom("cliniko_request_reservations").selectAll().execute()).length, 0);
    assert.deepEqual(resultValue(await scanPatientDataCanaries(call.db, [{ label: "patient", value: envelope.request.patientId }, { label: "phone", value: "+61400111222" }])),
      [{ label: "phone", table: "patient_phone_index", column: "normalized_phone" }, { label: "patient", table: "patient_phone_index", column: "patient_id" }]);
    for (let offset = 0; offset < privateValues.length; offset += 12) {
      const values = privateValues.slice(offset, offset + 12); await call.scan(values);
      assert.deepEqual(await scanDisposableBackupCanaries(call.connectionString, values.map((value, i) => ({ label: `cold_${i}`, value }))), []);
      for (const value of values) for (const result of [denied, pending, acknowledged]) assert.equal((result.output + result.error).includes(value), false);
    }
  }, { classes: true, classQuotaStaging: true, classColdRecovery: true });
});
