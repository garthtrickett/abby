import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const message = "My appointment referral is awaiting a response. Synthetic-message-canary.";
const addition = "Please email the receipt. Callback after 5:30 tomorrow is preferred.";
const replacement = "Please check my MRI referral. Synthetic-correction-canary.";
test("E2E-338 message additions and replacements reach one verified Cliniko request, never the classifier or durable Abby storage", { timeout: 150_000 }, async () => {
 await withDisposablePostgres(async db => {
  const modes = ["generic", "saved", "added", "email", "callback", "replaced", "discarded", "lost", "unplayed", "revoked", "changed", "expired", "affirmation", "question", "questionResume", "lateAddition", "lostAddition", "oversize", "unapproved", "modelGuess", "interruptedAddition"] as const;
  const failures: unknown[] = [];
  const run = async (mode: typeof modes[number]) => {
   const f = await clinikoStaffCallFlowFixture({ approved: mode !== "unapproved", lostResponse: mode === "lost" || mode === "lostAddition" }); f.flow.dispose();
   let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined; const models: string[] = [];
   try {
    call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
     models.push(String(init?.body)); return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ kind: "staffRequest", operation: null, stage: null, from: null, to: null, choice: null }) }] }] });
    } }));
    const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
    if (mode === "modelGuess") {
     await play("Could somebody arrange detailed clinical correspondence?");
     await voiceUntil(() => f.mail.length === 1, "model cannot supply actual send permission"); await call.verify(f.mail[0]!.code);
     await play("Please explain what you found."); assert.equal(models.length, 2); assert.equal(f.staffPosts, 0); assert.equal(f.recalls.length, 0); return;
    }
    await play(mode === "generic" ? "Please leave a message." : "I would like to leave a detailed message."); assert.equal(models.length, 0, "explicit message staging must not use model inference");
    if (mode === "unapproved") { assert.equal(f.mail.length, 0); assert.equal(f.staffPosts, 0); return; }
    await voiceUntil(() => f.mail.length === 1, "independent staff message proof"); assert.equal(f.staffPosts, 0); await call.verify(f.mail[0]!.code);
    if (mode === "generic") { await play("Please send the message."); assert.equal(f.staffPosts, 1); assert.equal(models.length, 0); assert.doesNotMatch(String(f.recalls[0]?.notes), /messageText/); return; }
    await call.turn(`The message is: ${message}`); if (mode !== "unplayed" && mode !== "interruptedAddition") await call.mark();
    assert.equal(f.staffPosts, 0); assert.equal(models.length, 0); assert.equal(Object.keys((await call.state()).staffItems).length, 0);
    if (mode === "interruptedAddition") { await call.turn(`Please add: ${addition}`, { interrupt: true }); await call.mark(); }
    if (mode === "email") await play("Could you make sure they send it to my email, please?");
    if (mode === "callback") await play("Please call me after 5:30 pm tomorrow.");
    if (mode === "added") await play(`Please add: ${addition}`);
    if (mode === "replaced") { await play(`Please add: ${addition}`); await play(`Please replace the message with: ${replacement}`); }
    if (mode === "discarded") { await play("Discard the message."); assert.match(call.spoken.at(-1)!, /discarded.*not sent/); return; }
    if (mode === "revoked") f.denyStaffPermission();
    if (mode === "changed") await f.replaceStaffApproval({ reviewCadenceMinutes: 45 });
    if (mode === "expired") await f.replaceStaffApproval({ effectiveUntil: "2026-10-04T06:00:00.000Z" });
    if (mode === "questionResume") { await play("Did you send the message?"); assert.equal(f.staffPosts, 0); }
    if (mode === "question") { await play("Did you send the message?"); assert.equal(f.staffPosts, 0); assert.match(call.spoken.at(-1)!, /not.*sent|not confirmed/); return; }
    if (mode === "oversize") { await play(`Please add: ${"x".repeat(351)}`); assert.equal(f.staffPosts, 0); assert.match(call.spoken.at(-1)!, /couldn.t.*include|too long/); return; }
    await call.turn(mode === "affirmation" ? "Yes" : "Please send the message.", mode === "unplayed" ? { interrupt: true } : {}); await call.mark();
    const blocked = ["unplayed", "revoked", "changed", "expired", "affirmation"].includes(mode);
    assert.equal(f.staffPosts, blocked ? 0 : 1, call.spoken.at(-1)); assert.equal(call.writeRequests.length, 0);
    if (blocked) return;
    const raw = String(f.recalls[0]?.notes), notes = JSON.parse(raw.slice(raw.indexOf("{")));
    assert.equal(notes.messageText, mode === "replaced" ? replacement : message + (mode === "email" ? "\nCould you make sure they send it to my email, please?" : mode === "callback" ? "\nPlease call me after 5:30 pm tomorrow." : ["added", "interruptedAddition"].includes(mode) ? "\n" + addition : ""));
    assert.equal(Object.values((await call.state()).staffItems).at(-1)?.status, mode === "lost" || mode === "lostAddition" ? "needsReview" : "open");
    assert.ok(raw.length < 1100); assert.match(call.spoken.at(-1)!, /can.t.*promise a callback time|can.t confirm whether/); assert.ok(JSON.stringify(f.recalls[0]?.patient).includes(`/patients/${verificationCanaries[2]}`));
    assert.ok(JSON.stringify(f.recalls[0]?.recall_type).includes("/recall_types/8"));
    if (mode === "lateAddition" || mode === "lostAddition") { await play(`Please add: ${addition}`); assert.match(call.spoken.at(-1)!, /can.t append.*won.t send another request/); assert.equal(f.staffPosts, 1); assert.equal(String(f.recalls[0]?.notes), raw); if (mode === "lostAddition") assert.match(call.spoken.at(-1)!, /can.t confirm whether.*saved or received/); }
    assert.ok(models.every(body => !body.includes(message) && !body.includes(addition) && !body.includes(replacement) && verificationCanaries.every(canary => !body.includes(canary))));
    assert.doesNotMatch(JSON.stringify(await call.state()), /Synthetic-message-canary|Synthetic-correction-canary|Callback after/);
   } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
   finally { await call?.close(); await f.close(); }
  };
  let next = 0; const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
  for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
  assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [...verificationCanaries, message, addition, replacement].map((value, index) => ({ label: `message_${index}`, value })))), []);
 });
});
