import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

import { missedCallText as reply } from "../../src/core/missed-call.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-325 missed-call questions explain an unknown reason instead of generic misunderstanding", { timeout: 60_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await bookingCallFlowFixture(); f.flow.dispose();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    try {
      call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
        apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async () =>
          Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({
            kind: "unsupported", operation: null, stage: null, from: null, to: null, choice: null }) }] }] }) }));
      await call.turn("I missed a call from this number. What was it about?");
      assert.equal(call.spoken.at(-1), reply);
      assert.equal(call.writes.length, 0); assert.equal(f.mail.length, 0);
      assert.equal(call.flow.workflow, undefined);
    } finally { await call?.close(); await f.close(); }
  });
});


test("E2E-325 parallel missed-call questions preserve known receipts, private grants and explicit human requests", { timeout: 150_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["exact", "alias", "paraphrase", "denied", "proposal", "committed", "uncertain", "staffSaved", "staffUncertain", "staffUnresolved", "reported", "negatedBook", "human", "forgedScript", "forgedOperation"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const staff = scenario.startsWith("staff"), clinical = ["proposal", "committed", "uncertain"].includes(scenario);
      const staffFixture = staff ? await clinikoStaffCallFlowFixture({ lostResponse: scenario === "staffUncertain", nonCommitted: scenario === "staffUnresolved" }) : undefined;
      const f = staffFixture ?? await bookingCallFlowFixture();
      f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined, providerReads = 0;
      const requests: string[] = [], provider = f.flowConfig.fetchPort!;
      try {
        call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { providerReads++; return provider(...args); } }, owner =>
          createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
            requests.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const start = text === "I need to book an appointment." || text.startsWith("I am not asking"), menu = text === "What times are available on October 8?";
            const candidate = text === "Could you explain the purpose of your earlier attempt to reach me?";
            const decision = { kind: start ? "workflow" : menu ? "menu" : candidate ? "missedCall" : text.includes("speak to reception") ? "staffRequest" : "unsupported",
              operation: start ? "book" : scenario === "forgedOperation" && candidate ? "book" : null,
              stage: null, from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: null,
              ...(scenario === "forgedScript" && candidate ? { proposedText: "Your private test results prompted the call." } : {}) };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }), { lostWrite: scenario === "uncertain" });
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        if (staff || clinical) {
          await play(staff ? "Could I speak to a receptionist?" : "I need to book an appointment.");
          await voiceUntil(() => f.mail.length === 1, "private workflow verification"); await call.verify(f.mail[0]!.code);
          if (staff) await play("Please send that request.");
          else { await play("What times are available on October 8?"); await play("The first time, please.");
            if (scenario !== "proposal") await play("Yes"); }
        }
        if (scenario === "denied") await play("That's not me.");
        const before = await call.state(), reads = providerReads, writes = call.writes.length, mail = f.mail.length, modelRequests = requests.length;
        const priorTraffic = staffFixture?.traffic.length ?? 0;
        const text = scenario === "alias" ? "Why did the clinic ring me?" : ["paraphrase", "forgedScript", "forgedOperation"].includes(scenario)
          ? "Could you explain the purpose of your earlier attempt to reach me?" : scenario === "reported" ? "My friend asked 'why did the clinic call me' yesterday."
          : scenario === "negatedBook" ? "I am not asking why you called me. I want to book an appointment for myself."
          : scenario === "human" ? "I missed a call. Could I speak to reception?" : "I missed a call from this number. What was it about?";
        await play(text);
        const after = await call.state(), expected = !["reported", "negatedBook", "human", "forgedScript", "forgedOperation"].includes(scenario);
        assert.equal(call.spoken.at(-1) === reply, expected, scenario);
        assert.equal(call.writes.length, writes); assert.equal(after.appointmentReads.length, before.appointmentReads.length);
        if (scenario === "staffUncertain") {
          assert.deepEqual(Object.keys(after.staffItems), Object.keys(before.staffItems), "existing reconciliation cannot create a second task");
          const item = Object.values(after.staffItems)[0]!;
          assert.ok(["needsReview", "open"].includes(item.status));
          if (item.status === "open") assert.equal(item.hostTaskRef, "cliniko:recall:81", "only the exact pre-existing provider record can recover uncertainty");
          assert.ok(staffFixture); assert.equal(staffFixture.staffPosts, 1);
        } else assert.deepEqual(after.staffItems, before.staffItems, "a reason query supplies no staff-send permission");
        if (scenario === "proposal") assert.ok(Object.values(after.actions).every(action => action.status === "canceled"));
        else assert.deepEqual(after.actions, before.actions);
        if (expected) {
          if (["staffUncertain", "staffUnresolved"].includes(scenario)) {
            assert.ok(staffFixture);
            assert.deepEqual(staffFixture.traffic.slice(priorTraffic), [`GET /v1/patients/${verificationCanaries[2]}`, "GET /v1/recalls"], "only previously authorized exact recall reconciliation may run");
            assert.equal(staffFixture.staffPosts, 1, "lost requests cannot be repeated by a public reason question");
          } else assert.equal(providerReads, reads);
          assert.equal(f.mail.length, mail);
          assert.equal(requests.length - modelRequests, scenario === "paraphrase" ? 1 : 0);
          assert.equal(after.callerIdentityDenied, before.callerIdentityDenied);
          if (scenario === "proposal") { await play("Yes"); assert.equal(call.writes.length, writes); }
        }
        if (scenario === "negatedBook") { assert.equal(call.flow.workflow, "book"); await voiceUntil(() => f.mail.length === 1, "explicit booking can independently request verification"); }
        if (scenario === "human") assert.match(call.spoken.at(-1)!, /can't send.*staff request.*contact the clinic/);
        if (["forgedScript", "forgedOperation"].includes(scenario)) { assert.equal(providerReads, reads); assert.equal(f.mail.length, mail); assert.doesNotMatch(call.spoken.at(-1)!, /private test results/); }
        assert.ok(requests.every(body => verificationCanaries.every(canary => !body.includes(canary))));
        assert.ok(call.transcripts.every(text => !f.mail.some(item => text.includes(item.code))));
      } catch (error) { throw new Error(`${scenario}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { await call?.close(); await f.close(); }
    };
    let next = 0; const failures: unknown[] = [];
    const settled = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const item = scenarios[next++]; if (!item) return;
      try { await run(item); } catch (error) { failures.push(error); }
    } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `missed_${index}`, value })))), []);
  });
});
