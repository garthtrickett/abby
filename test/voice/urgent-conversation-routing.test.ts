import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { DisabledStandaloneHost } from "../../src/standalone/disabled-host.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { urgentConversationFixture, urgentScript, urgentQuestion, urgentReply, urgentFallback } from "../support/urgent-conversation.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";
import { ok } from "../../src/core/model.ts";

const modelQuestion = "Please use the clinic’s immediate-help procedure for my request.";

test("E2E-317 signed urgent conversation routing uses only admitted approved wording without an unproven staff route", { timeout: 180_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["explicit", "model", "missing", "expired", "foreign", "draft", "malformed", "ordinaryStaff", "proposal", "committed", "uncertain", "disabledNewCall", "captured", "expiredModel", "interrupted", "forgedModel", "medicalMixed", "transferCue"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const f = await urgentConversationFixture({ staff: scenario === "ordinaryStaff", shortExpiry: scenario === "expiredModel", missing: scenario === "missing" });
      const bodies: string[] = [];
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        if (scenario === "expired") f.setUrgentOverride({ ...f.response, effectiveFrom: "2026-10-03T06:00:00.000Z", effectiveUntil: verificationNow });
        if (scenario === "foreign") f.setUrgentOverride({ ...f.response, scope: { ...f.scope, locationId: "other" } });
        if (scenario === "draft") f.setUrgentOverride({ ...f.response, approved: false });
        if (scenario === "malformed") f.setUrgentOverride({ ...f.response, approvedText: "" });
        const open = async () => clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, policyVersion: resultValue(await f.policies.read(f.scope)).policyVersion }, owner => {
          const resolve = createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            bodies.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            if (scenario === "expiredModel" && text === modelQuestion) f.setTime("2026-10-04T06:00:02.000Z");
            const start = text === "I need to book an appointment.", menu = text === "What times are available on October 8?";
            const decision = { kind: start ? "workflow" : menu ? "menu" : "urgent", operation: start ? "book" : null, stage: null,
              from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: null,
              ...(scenario === "forgedModel" ? { approvedText: "You are medically cleared." } : {}) };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } });
          return (turn, signal) => scenario === "transferCue" && turn.text === urgentQuestion
            ? Promise.resolve(ok({ kind: "transfer", reason: "potentiallyUrgent" } as const)) : resolve(turn, signal);
        }, { lostWrite: scenario === "uncertain" });
        call = await open();
        if (["proposal", "committed", "uncertain"].includes(scenario)) {
          await call.turn("I need to book an appointment."); await call.mark(); await voiceUntil(() => f.mail.length === 1, "original booking verification"); await call.verify(f.mail[0]!.code);
          await call.turn("What times are available on October 8?"); await call.mark(); await call.turn("The first time, please."); await call.mark();
          if (scenario !== "proposal") { await call.turn("Yes"); await call.mark(); }
        }
        if (scenario === "captured") resultValue(await f.disableUrgent());
        if (scenario === "disabledNewCall") { await call.close(); resultValue(await f.disableUrgent()); call = await open(); }
        const before = await call.state(), writes = call.writes.length, mail = f.mail.length;
        const text = ["model", "expiredModel", "forgedModel"].includes(scenario) ? modelQuestion : scenario === "medicalMixed"
          ? "Is it safe for me after treatment? I need urgent help." : urgentQuestion;
        await call.turn(text);
        const fallback = ["missing", "expired", "foreign", "draft", "malformed", "disabledNewCall", "expiredModel"].includes(scenario);
        if (scenario === "forgedModel") assert.equal(call.spoken.at(-1), "I couldn't understand that safely. Could you repeat your request, or contact the clinic directly?");
        else assert.equal(call.spoken.at(-1), fallback ? urgentFallback : urgentReply, scenario);
        const after = await call.state();
        assert.equal(f.mail.length, mail); assert.equal(call.writes.length, writes); assert.deepEqual(after.staffItems, before.staffItems, `${scenario}: urgent cue must preserve existing review work without creating another item`);
        assert.ok(!Object.values(after.effects).some(effect => effect.kind === "staffTask" && !before.effects[effect.id] || effect.kind === "hostWrite" && effect.status === "pending" && !before.effects[effect.id]));
        if (scenario === "ordinaryStaff") assert.equal(f.staffPosts, 0);
        for (const action of Object.values(before.actions)) {
          if (action.status === "awaitingConfirmation") assert.equal(after.actions[action.key]?.status, "canceled");
          else assert.deepEqual(after.actions[action.key], action);
        }
        if (scenario === "interrupted") { await call.turn(urgentQuestion, { interrupt: true }); assert.equal(call.spoken.at(-1), urgentReply); }
        assert.ok(bodies.every(body => verificationCanaries.every(canary => !body.includes(canary))));
        assert.ok(!call.spoken.some(text => /staff (?:have|has) received|I (?:have|am) transfer|staff will call|medically cleared/i.test(text)));
      } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const item = scenarios[next++]; if (!item) return; await run(item); } }));
    const failed = workers.find(worker => worker.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, i) => ({ label: `urgent_${i}`, value })))), []);
  });
});

test("E2E-317 agent urgent cue has no script, transfer or staff-send authority", async () => {
  const f = await urgentConversationFixture(), ledger = new MemoryLedger(async () => ({ ok: true, value: true }));
  try {
    let clock = verificationNow;
    const reception = new TextReception(ledger, f.policies, new DisabledStandaloneHost(), undefined, undefined, undefined, undefined, () => clock);
    const callId = "urgent-agent"; resultValue(await reception.startCall(callId, f.scope, verificationNow));
    const agent = new CommandGateway({ actorRef: "urgent-agent", role: "agent", scope: f.scope }, f.policies, reception);
    assert.ok(agent.listPermitted().some(cap => cap.id === "calls.urgent.respond.v1"));
    const command = { kind: "calls.urgent.respond.v1" as const, turn: { callId, turnId: "urgent", text: urgentQuestion, quality: "clear" as const, at: verificationNow }, now: verificationNow };
    const reply = resultValue(await agent.submit(command)); resultValue(await agent.submit(command));
    const state = resultValue(await ledger.read(callId, f.scope)); assert.equal(state.callerMessages.at(-1), urgentReply); assert.equal(state.callerMessages.length, 1);
    assert.equal(Object.keys(state.staffItems).length, 0); assert.equal(Object.keys(state.actions).length, 0);
    assert.equal((await agent.submit({ ...command, approvedText: urgentScript } as never)).ok, false);
    const foreign = new CommandGateway({ actorRef: "urgent-foreign", role: "agent", scope: { ...f.scope, locationId: "foreign" } }, f.policies, reception);
    assert.equal((await foreign.submit({ ...command, turn: { ...command.turn, turnId: "foreign" } })).ok, false);
    assert.deepEqual(resultValue(await ledger.read(callId, f.scope)), state);
    assert.ok(verificationCanaries.every(canary => !JSON.stringify(reply).includes(canary))); assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
    clock = "2026-10-05T06:00:00.000Z";
    // A fresh turn with an old public timestamp must not restore expired approval.
    resultValue(await agent.submit({ ...command, turn: { ...command.turn, turnId: "backdated" } }));
    const expired = resultValue(await ledger.read(callId, f.scope));
    assert.equal(expired.callerMessages.at(-1), urgentFallback);
    assert.equal(Object.keys(expired.staffItems).length, 0);
    clock = "invalid-clock";
    assert.deepEqual(await agent.submit({ ...command, turn: { ...command.turn, turnId: "invalid-clock" } }), { ok: false, error: { kind: "invalidTransition" } });
    assert.deepEqual(resultValue(await ledger.read(callId, f.scope)), expired);
  } finally { ledger.dispose(); await f.close(); }
});


test("E2E-317 negated and background urgency are not trusted positive cues", async () => {
  const f = await bookingCallFlowFixture();
  try {
    let requests = 0;
    const resolve = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
      fetch: async () => { requests++; return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
        text: JSON.stringify({ kind: "unsupported", operation: null, stage: null, from: null, to: null, choice: null }) }] }] }); } });
    for (const [index, text] of ["I do not need urgent medical attention.", "The television in the background said urgent help."].entries()) {
      const reply = await resolve(f.turn(`not-urgent-${index}`, text));
      assert.deepEqual(reply, { ok: false, error: { kind: "intentUnavailable" } });
    }
    assert.equal(requests, 2); assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
