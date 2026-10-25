import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { appointmentEnquiryFixture, enquiryThenBookingFixture } from "../support/cliniko-appointment-enquiry.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";

const begin = "I only want to check my appointments.";
const enquire = "Could you tell me when my next visit is? I do not want to change it.";

test("E2E-314 signed independent appointment enquiries verify only reads and preserve clinical appointments", { timeout: 180_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["shown", "empty", "multiple", "select", "changedSelection", "unplayed", "permission", "duringRead", "caller", "terms", "admin",
      "zone", "business", "unavailable", "closed", "noVerification", "mutation", "modelCancel", "email", "range", "dated", "disabledBefore", "datedCorrection", "automation", "clockAdvance"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const f = await appointmentEnquiryFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const requests: string[] = [];
      const readQueries: unknown[] = [];
      try {
        if (["multiple", "select", "changedSelection", "unplayed"].includes(scenario)) f.setMultiple();
        if (scenario === "disabledBefore") await f.replaceRead({ enabled: false });
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => {
          const read = owner.readAppointmentEnquiry.bind(owner);
          owner.readAppointmentEnquiry = async query => { const result = await read(query); readQueries.push({ from: query.from, to: query.to, now: query.now, error: result.ok ? null : result.error.kind }); return result; };
          return createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
          clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            const body = String(init?.body); requests.push(body);
            const text = JSON.parse(JSON.parse(body).input[1].content).callerText;
            const initial = text === begin, wrong = scenario === "modelCancel";
            if (!initial && scenario === "clockAdvance") f.setTime("2026-10-04T06:00:02.000Z");
            const answer = { kind: wrong ? "cancel" : initial ? "workflow" : "appointments", operation: initial && !wrong ? "appointments.read" : null,
              stage: null, from: !initial && scenario === "dated" ? "2026-10-08" : null, to: !initial && scenario === "dated" ? "2026-10-09" : null, choice: null };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] });
          } }); });
        await call.turn(begin); await call.mark();
        assert.equal(call.writes.length, 0); assert.doesNotMatch(call.spoken.join(" "), /Thursday 8 October/);
        if (scenario === "modelCancel" || scenario === "disabledBefore") { assert.equal(f.mail.length, 0); assert.equal(call.flow.workflow, undefined); return; }
        assert.equal(call.flow.workflow, "appointments.read");
        await voiceUntil(() => f.mail.length === 1, "independent read verification email");
        if (scenario === "noVerification") {
          assert.equal(call.flow.verificationRequired, true); assert.equal(f.reads, 0);
          assert.doesNotMatch(call.spoken.join(" "), /Thursday 8 October/); return;
        }
        await call.verify(f.mail[0]!.code);
        if (scenario === "empty") f.setEmpty();
        if (scenario === "permission") f.setPermitted(false);
        if (scenario === "duringRead") f.setOnRead(async () => f.replaceRead({ enabled: false }));
        if (scenario === "caller") await f.replaceApproval({ enabled: false });
        if (scenario === "terms") await f.replaceRead({ approved: false });
        if (scenario === "admin") await f.replaceAccount({ membershipVersion: "member-2" });
        if (scenario === "zone") f.setTimeZone("Australia/Perth");
        if (scenario === "business") f.setWrongBusiness();
        if (scenario === "unavailable") f.setFailure();
        if (scenario === "email") f.setReadEmail("changed@example.test");
        if (scenario === "automation") {
          const policy = resultValue(await f.policies.read(f.scope));
          assert.ok(policy.automationVersion);
          resultValue(await f.policies.changeAutomationEnabled(f.scope, policy.automationVersion, false, "synthetic-admin"));
        }
        if (scenario === "closed") f.setOnRead(async () => call!.flow.dispose());
        if (scenario === "range") {
          const binding = call.flow.binding();
          const result = await call.flow.readAppointmentEnquiry({ scope: f.scope, ...binding, policyVersion: f.sessionConfig.policyVersion,
            from: verificationNow, to: "2026-12-04T06:00:00.000Z", now: verificationNow, signal: new AbortController().signal });
          assert.equal(result.ok, false); assert.equal(f.reads, 0); return;
        }
        await call.turn(enquire); assert.equal(call.writes.length, 0);
        assert.ok(verificationCanaries.every(canary => requests.every(body => !body.includes(canary))));
        assert.ok(f.permissionOperations.every(operation => operation === "appointments.read"));
        assert.equal(Object.keys((await call.state()).actions).length, 0);
        if (["permission", "duringRead", "caller", "terms", "admin", "zone", "business", "unavailable", "closed", "email", "automation"].includes(scenario)) {
          assert.doesNotMatch(call.spoken.at(-1)!, /Thursday 8 October|I found .*appointments?/); return;
        }
        assert.match(call.spoken.at(-1)!, scenario === "dated" ? /checked upcoming appointments between 8 October 2026 and 9 October 2026/ : /checked upcoming appointments between 4 October 2026 and 3 November 2026/,
          `${scenario}: providerReads=${f.reads}, readQueries=${JSON.stringify(readQueries)}, readStatuses=${JSON.stringify((await call.state()).appointmentReads)}`);
        if (scenario === "empty") { assert.match(call.spoken.at(-1)!, /couldn't find an appointment in that time range/); return; }
        assert.match(call.spoken.at(-1)!, /Thursday 8 October/);
        if (["multiple", "select", "changedSelection", "unplayed"].includes(scenario)) assert.match(call.spoken.at(-1)!, /option one.*3:00 pm.*option two.*4:00 pm/s);
        if (scenario === "unplayed") {
          const reads = f.reads; await call.turn("The second appointment, please.", { interrupt: true });
          assert.equal(f.reads, reads); assert.doesNotMatch(call.spoken.at(-1)!, /I found an appointment on/); return;
        }
        await call.mark();
        if (scenario === "datedCorrection") {
          const requestsBefore = requests.length, reads = f.reads;
          await call.turn("Actually, Thursday."); assert.equal(requests.length, requestsBefore); assert.equal(f.reads, reads + 1);
          assert.match(call.spoken.at(-1)!, /between 8 October 2026 and 8 October 2026.*Thursday 8 October/s);
          assert.equal(Object.keys((await call.state()).actions).length, 0);
        }
        if (scenario === "select" || scenario === "changedSelection") {
          if (scenario === "changedSelection") f.setChanged();
          const reads = f.reads; await call.turn("The second appointment, please.");
          assert.equal(f.reads, reads + 1);
          if (scenario === "select") assert.match(call.spoken.at(-1)!, /I found an appointment on Thursday 8 October at 4:00 pm/);
          else assert.doesNotMatch(call.spoken.at(-1)!, /I found an appointment on/);
          assert.equal(call.writes.length, 0); assert.equal(Object.keys((await call.state()).actions).length, 0);
        }
        if (scenario === "mutation") {
          await call.turn("Cancel that appointment."); assert.equal(f.mail.length, 1); assert.equal(call.writes.length, 0);
          assert.equal(call.flow.workflow, "appointments.read"); assert.equal(Object.keys((await call.state()).actions).length, 0);
          assert.ok(f.permissionOperations.every(operation => operation === "appointments.read"));
        }
      } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const item = scenarios[next++]; if (!item) return; await run(item); } }));
    const failed = workers.find(worker => worker.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, i) => ({ label: `enquiry_${i}`, value })))), []);
  });
});

test("E2E-314 agent enquiry commands keep proof private, honor write stop and require played selection", async () => {
  const f = await appointmentEnquiryFixture(); f.setMultiple();
  try {
    const agent = new CommandGateway({ actorRef: "enquiry-agent", role: "agent", scope: f.scope }, f.policies, f.reception);
    const turn = (turnId: string, text: string) => ({ callId: f.callId, sessionId: f.sessionId, turnId, text, at: verificationNow, quality: "clear" as const });
    const play = async () => {
      const state = await f.state(); assert.ok(state.pendingPresentationId);
      resultValue(await f.runtime.startPresentation(f.callId, state.pendingPresentationId, f.sessionId, verificationNow));
      resultValue(await f.runtime.resolvePresentation(f.callId, state.pendingPresentationId, "played", f.sessionId, verificationNow));
    };
    resultValue(await f.ledger.stopWrites(f.scope, "synthetic-admin", "read remains independent"));
    const started = resultValue(await agent.submit({ kind: "appointments.enquiry.start.v1", turn: turn("begin", begin), now: verificationNow }));
    await voiceUntil(() => f.mail.length === 1, "agent independent read email"); await play();
    const read = { kind: "appointments.enquiry.read.v1" as const, turn: turn("read", enquire), from: verificationNow, to: "2026-10-09T06:00:00.000Z", now: verificationNow };
    const before = resultValue(await agent.submit(read)); assert.equal(f.reads, 0);
    assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
    const reply = resultValue(await agent.submit({ ...read, turn: turn("verifiedRead", enquire) })); assert.equal(reply.kind, "appointmentAnswer");
    assert.ok(verificationCanaries.every(canary => !JSON.stringify([started, before, reply]).includes(canary)));
    const forged = { ...read, turn: turn("forged", enquire), verificationRef: "caller-provided-proof", patientId: verificationCanaries[2] };
    assert.equal((await agent.submit(forged)).ok, false);
    const reads = f.reads;
    resultValue(await agent.submit({ kind: "appointments.enquiry.select.v1", turn: turn("unplayed", "Option two"), choice: 2, now: verificationNow }));
    assert.equal(f.reads, reads);
    resultValue(await agent.submit({ ...read, turn: turn("listAgain", enquire) })); await play();
    const selected = resultValue(await agent.submit({ kind: "appointments.enquiry.select.v1", turn: turn("select", "Option two"), choice: 2, now: verificationNow }));
    assert.equal(selected.kind, "appointmentAnswer"); assert.equal(f.reads, reads + 2);
    const state = await f.state(); assert.equal(Object.keys(state.actions).length, 0);
    assert.match(state.callerMessages.at(-1)!, /I found an appointment on Thursday 8 October at 4:00 pm/);
    assert.ok(f.traffic.every(request => request.startsWith("GET "))); assert.ok(f.permissionOperations.every(operation => operation === "appointments.read"));
  } finally { await f.close(); }
});

test("E2E-314 a signed caller moves from enquiry to booking only with new operation verification and exact confirmation", { timeout: 60_000 }, async () => {
  await withDisposablePostgres(async db => {
    for (const unavailable of [false, true]) {
      const f = await enquiryThenBookingFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        let failRead = unavailable;
        const config = { ...f.flowConfig, fetchPort: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = new URL(String(input));
          if (failRead && (init?.method ?? "GET") === "GET" && url.pathname === "/v1/individual_appointments" &&
              url.searchParams.getAll("q[]").some(filter => filter.startsWith("starts_at:>"))) return new Response(null, { status: 503 });
          return f.flowConfig.fetchPort!(input, init);
        } };
        call = await clinikoWorkflowVoiceFixture(db, config, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
          clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const operation = text === begin ? "appointments.read" : text === "I need to book an appointment." ? "book" : null;
            const menu = text === "What times are available on October 8?";
            const decision = { kind: operation ? "workflow" : menu ? "menu" : "appointments", operation, stage: null,
              from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: null };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }));
        await call.turn(begin); await call.mark(); await voiceUntil(() => f.mail.length === 1, "read email"); await call.verify(f.mail[0]!.code);
        await call.turn(enquire); await call.mark(); assert.equal(call.flow.workflow, "appointments.read");
        assert.match(call.spoken.at(-1)!, unavailable ? /can't check appointments right now/ : /I found an appointment/);
        assert.equal((await call.state()).appointmentReads.at(-1)?.status, unavailable ? "failed" : "shown");
        failRead = false;
        await call.turn("I need to book an appointment."); await call.mark();
        assert.equal(call.flow.workflow, "book"); assert.equal(call.flow.verificationRequired, true); assert.equal(call.writes.length, 0);
        assert.equal(Object.keys((await call.state()).actions).length, 0);
        await voiceUntil(() => f.mail.length === 2, "new independent booking email"); await call.verify(f.mail[1]!.code);
        await call.turn("What times are available on October 8?"); await call.mark(); await call.turn("The first time, please.");
        assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "awaitingConfirmation"); assert.equal(call.writes.length, 0);
        await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 1);
        assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "committed");
        assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, i) => ({ label: `enquiry_switch_${i}`, value })))), []);
      } finally { await call?.close(); await f.close(); }
    }
  });
});

test("E2E-314 a retired signed enquiry cannot publish its late successful appointment read", { timeout: 30_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await appointmentEnquiryFixture(); f.flow.dispose();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    let held = false, returned = false, release = () => {};
    const waiting = new Promise<void>(resolve => { release = resolve; });
    try {
      const original = f.flowConfig.fetchPort!;
      const config = { ...f.flowConfig, fetchPort: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await original(input, init);
        if (held && new URL(String(input)).pathname === "/v1/individual_appointments") returned = true;
        return response;
      } };
      call = await clinikoWorkflowVoiceFixture(db, config, () => async turn => ok(turn.text === begin
        ? { kind: "workflow", operation: "appointments.read" }
        : { kind: "appointmentEnquiry", from: verificationNow, to: "2026-10-09T06:00:00.000Z" }));
      await call.turn(begin); await call.mark();
      await voiceUntil(() => f.mail.length === 1, "retired enquiry verification email"); await call.verify(f.mail[0]!.code);
      f.setOnRead(async () => { held = true; await waiting; });
      const pending = call.turn(enquire).then(() => undefined, error => error);
      await voiceUntil(() => held, "held actual appointment fetch");
      call.flow.dispose(); await pending;
      const beforeLate = await call.state(), spokenBeforeLate = [...call.spoken];
      assert.ok(beforeLate.appointmentReads.every(read => read.status === "failed"));
      assert.deepEqual(beforeLate.actions, {}); assert.equal(call.writeRequests.length, 0);
      release(); await voiceUntil(() => returned, "late successful native fixture response");
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(await call.state(), beforeLate);
      assert.deepEqual(call.spoken, spokenBeforeLate);
      assert.doesNotMatch(call.spoken.join(" "), /I found an appointment|couldn't find an appointment|booking is confirmed/i);
      assert.equal(call.writeRequests.length, 0);
      assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, i) => ({ label: `retired_enquiry_${i}`, value })))), []);
    } finally { release(); try { await call?.close(); } finally { await f.close(); } }
  });
});
