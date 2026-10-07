import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { conversationControl } from "../../src/core/conversation-control.ts";

const pauseNotice = "Of course. I'll wait up to thirty seconds. Let me know when you're ready.";
const limitNotice = "Please tell me what you need when you're ready, or call the clinic back.";
const goodbyeNotice = "Goodbye. If you have one more question, please tell me now.";
const resumeNotice = "I'm here. Please tell me what else you need.";
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("E2E-340 signed caller pauses and goodbye grace never confirm or duplicate a write, and keep message drafts private", { timeout: 150_000 }, async () => {
 await withDisposablePostgres(async db => {
  const modes = ["pause", "writing", "limit", "resume", "goodbye", "unplayed", "interrupt", "pending", "pendingAffirm", "committed", "unknown", "staffDraft", "staffUnplayed", "staffGoodbye"] as const;
  const failures: unknown[] = [];
  const run = async (mode: typeof modes[number]) => {
   const staff = mode.startsWith("staff"), f = staff ? await clinikoStaffCallFlowFixture() : await bookingCallFlowFixture(); f.flow.dispose();
   let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined; const models: string[] = []; let reads = 0;
   try {
    const port = f.flowConfig.fetchPort!;
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { if ((args[1]?.method ?? "GET") === "GET") reads++; return port(...args); } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
     models.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
     const start = text === "I need to book an appointment.", menu = text === "Show times on October 8.";
     const decision = { kind: start ? "workflow" : menu ? "menu" : "unsupported", operation: start ? "book" : null, stage: null, from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: null };
     return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
    } }), { lostWrite: mode === "unknown" });
    const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
    if (staff || ["pending", "pendingAffirm", "committed", "unknown"].includes(mode)) {
     await play(staff ? "I would like to leave a detailed message." : "I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "pause source verification"); await call.verify(f.mail[0]!.code);
     if (staff) await play("The message is: PauseMessageCanary needs a referral update.");
     else { await play("Show times on October 8."); await play("The first time, please."); }
     if (mode === "committed" || mode === "unknown") await play("Yes");
    }
    const count = models.length, queries = reads, writes = call.writeRequests.length, before = await call.state();
    if (["goodbye", "unplayed", "interrupt", "committed", "unknown", "staffGoodbye"].includes(mode)) {
     await call.turn("Thank you, goodbye."); assert.equal(models.length, count); assert.equal(call.spoken.at(-1), goodbyeNotice);
     if (mode === "unplayed") { await wait(6_000); assert.equal(call.closed, false, "unplayed farewell cannot close at its grace deadline"); }
     if (mode === "interrupt") { await call.turn("Actually, I have more.", { interrupt: true }); await call.mark(); assert.equal(call.spoken.at(-1), resumeNotice); }
     else { await call.mark(); if (mode === "goodbye" || mode === "unplayed") {
      const spoken = call.spoken.length; await voiceUntil(() => call!.closed, "real five-second goodbye closure", 8_000);
      assert.equal(call.closeCode, 1000); assert.equal((await call.state()).terminal?.reason, "sessionClosed"); assert.equal(call.spoken.length, spoken, "farewell never emits an idle retry");
     } else { await play("Actually, I have more."); assert.equal(call.spoken.at(-1), resumeNotice); if (!staff) {
      await play("Cancel it instead."); assert.match(call.spoken.at(-1)!, mode === "unknown" ? /can't confirm|unconfirmed|unknown/i : /confirmed|contact the clinic/i);
     } }
    }
   } else {
    await call.turn(mode === "writing" ? "Hold on, let me write that down." : "Please hold.");
    if (mode !== "staffUnplayed") await call.mark(); assert.equal(call.spoken.at(-1), pauseNotice); assert.equal(models.length, count);
    if (mode === "pause") { const spoken = call.spoken.length; await wait(16_000); assert.equal(call.closed, false); assert.equal(call.spoken.length, spoken, "played pause suppresses the ordinary fifteen-second nag"); }
    if (mode === "limit") { await play("Give me a moment."); assert.equal(call.spoken.at(-1), pauseNotice); await play("Please hold."); assert.equal(call.spoken.at(-1), limitNotice); }
    if (mode === "resume") { await play("Actually, one more thing."); assert.equal(call.spoken.at(-1), resumeNotice); }
    if (mode === "pending") {
     assert.ok(Object.values((await call.state()).actions).every(action => action.status === "canceled"));
     await play("Show times on October 8."); await play("The first time, please."); await play("Yes");
     assert.equal(call.writeRequests.length, 1); assert.equal(call.writeRequests[0]?.body.patient_id, verificationCanaries[2]); assert.equal(call.writeRequests[0]?.body.starts_at, "2026-10-08T04:00:00.000Z");
    }
    if (mode === "pendingAffirm") { await play("Yes"); assert.equal(call.writeRequests.length, 0);
     assert.ok(Object.values((await call.state()).actions).every(action => action.status === "canceled")); }
   }
   if (staff) { assert.equal(reads, queries); await call.turn("Please send the message.", mode === "staffUnplayed" ? { interrupt: true } : {}); await call.mark();
    assert.equal("staffPosts" in f ? f.staffPosts : 0, mode === "staffUnplayed" ? 0 : 1);
    if (mode !== "staffUnplayed") { const raw = String("recalls" in f ? f.recalls[0]?.notes : "");
     assert.equal(JSON.parse(raw.slice(raw.indexOf("{"))).messageText, "PauseMessageCanary needs a referral update."); }
   }
   if (mode !== "pending") assert.equal(call.writeRequests.length, writes);
   if (["committed", "unknown"].includes(mode)) assert.deepEqual((await call.state()).actions, before.actions);
   if (mode !== "pending" && !staff) assert.equal(reads, queries);
   assert.ok(models.every(body => !body.includes("PauseMessageCanary") && verificationCanaries.every(canary => !body.includes(canary))));
  } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  finally { await call?.close(); await f.close(); }
 };
 let next = 0; const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
 for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
 if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
 assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [...verificationCanaries, "PauseMessageCanary"].map((value, index) => ({ label: `caller_pause_${index}`, value })))), []);
 });
});
test("E2E-340 only complete caller control phrases bypass inference", () => {
 for (const text of ["Please wait while I check my diary.", "Please hold.", "Hold on, let me write that down.", "Give me a moment."]) assert.equal(conversationControl(text), "pause", text);
 for (const text of ["Goodbye.", "Thank you, goodbye."]) assert.equal(conversationControl(text), "goodbye", text);
 for (const text of ["Actually, I have more.", "Actually, one more thing.", "Wait, I have another question."]) assert.equal(conversationControl(text), "resume", text);
 for (const text of ["You have been placed on hold. Please wait.", "The message is: please hold.", "Don't say goodbye.", "If I say goodbye, please wait.", "Please hold. Book at 3 PM.", "Goodbye, cancel it.", "Thank you.", "Yes, I'm still here."]) assert.equal(conversationControl(text), undefined, text);
});
