import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { clinicFAQFixture } from "../support/clinic-faqs.ts";
import { clinikoWorkflowVoiceFixture } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { cancellationCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { publicDirections } from "../support/clinic-faqs.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

const cases = [
  { text: "I want a first visit for my young child.", expected: "I can't register a child or act for a child in this call. Please contact the clinic directly." },
  { text: "This is for my partner. Please move their appointment.", expected: "I can only handle an individual appointment for the verified caller. I can't change another person's appointment or combine different people's changes on this call. Please contact the clinic directly." },
  { text: "Please move both my visit and my partner's.", expected: "I can only handle an individual appointment for the verified caller. I can't change another person's appointment or combine different people's changes on this call. Please contact the clinic directly." },
  { text: "I need two clinicians free together for the same visit.", expected: "I can't arrange a visit requiring several practitioners together from this call. Please contact the clinic directly." },
  { text: "I cannot attend the group class tonight.", expected: "This call handles individual appointments. I can't manage group-class attendance here. Please contact the clinic directly about the class." },
] as const;

test("E2E-320 signed unsupported patient and coordinated appointment requests cannot start verification or substitute an individual booking", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const run = async (item: typeof cases[number]) => {
      const f = await clinicFAQFixture();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      let traffic = 0;
      try {
        call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { traffic++; return f.flowConfig.fetchPort!(...args); } },
          owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async () => Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
              text: JSON.stringify({ kind: "workflow", operation: "book", stage: null, from: null, to: null, choice: null }) }] }] }) }));
        const before = await call.state(), reads = traffic, mail = f.mail.length;
        await call.turn(item.text); await call.mark();
        assert.equal(call.spoken.at(-1), item.expected, item.text);
        const after = await call.state();
        assert.equal(traffic, reads); assert.equal(f.mail.length, mail); assert.equal(call.writes.length, 0);
        assert.deepEqual(after.actions, before.actions); assert.deepEqual(after.staffItems, before.staffItems);
        assert.equal(call.flow.workflow, undefined); assert.equal(call.flow.verificationRequired, false);
      } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const settled = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const item = cases[next++]; if (!item) return; await run(item); } }));
    for (const item of settled) if (item.status === "rejected") throw item.reason;
  });
});

test("E2E-320 signed boundaries clear unsent selections, require fresh self verification and retain sent clinical and staff outcomes", { timeout: 180_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["proposal", "cancel", "move", "committed", "uncertain", "staffSaved", "modelMinor", "modelProxy", "modelJoint", "modelClass", "forged", "wrongFields", "negated"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const f = scenario === "cancel" ? await cancellationCallFlowFixture() : scenario === "move" ? await reschedulingCallFlowFixture()
        : scenario === "staffSaved" ? await clinikoStaffCallFlowFixture() : await clinicFAQFixture();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const bodies: string[] = []; let traffic = 0;
      const paraphrases = { modelMinor: ["Please enroll the youngster I care for.", "minorIntake"],
        modelProxy: ["Please rearrange the visit of the other member of my household.", "proxyPatient"],
        modelJoint: ["Can several providers take part in a shared session with me?", "jointPractitioners"],
        modelClass: ["Could you remove me from this evening's Pilates cohort?", "groupClass"] } as const;
      try {
        call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { traffic++; return f.flowConfig.fetchPort!(...args); } },
          owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_url, init) => {
              bodies.push(String(init?.body));
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
              const start = ["I need to book an appointment.", "I need to cancel an appointment.", "I need to move an appointment."].includes(text);
              const targets = text === "Show my existing appointments from October 4 through October 9.";
              const appointments = text === "Show me my appointments from October 4 through October 9.";
              const offers = text === "What times are available on October 8?" || text === "Show move times on October 8.";
              const mapped = Object.values(paraphrases).find(([utterance]) => utterance === text)?.[1];
              const invalid = text === "Please enroll the youngster I care for." && ["forged", "wrongFields"].includes(scenario);
              const decision = { kind: start ? "workflow" : targets || offers ? "menu" : appointments ? "appointments" : mapped ?? (invalid ? "minorIntake" : text === "What happened to that action?" ? "outcome" : text === "Where is the clinic and where can I park?" ? "faq" : "unsupported"),
                operation: start ? text.includes("cancel") ? "cancel" : text.includes("move") ? "reschedule" : "book" : invalid && scenario === "wrongFields" ? "book" : null,
                stage: targets ? "targets" : text === "Show move times on October 8." ? "offers" : null,
                from: targets || appointments ? "2026-10-04" : offers ? "2026-10-08" : null,
                to: targets || appointments ? "2026-10-09" : offers ? "2026-10-08" : null,
                choice: text === "Where is the clinic and where can I park?" ? 1 : null,
                ...(invalid && scenario === "forged" ? { patientId: "other-patient", proposedText: "I registered the child." } : {}) };
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
            } }), { lostWrite: scenario === "uncertain" });
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        const prepared = ["proposal", "cancel", "move", "committed", "uncertain", "staffSaved", "negated"].includes(scenario);
        if (prepared) {
          await play(scenario === "cancel" ? "I need to cancel an appointment." : scenario === "move" ? "I need to move an appointment."
            : scenario === "staffSaved" ? "Could I speak to a receptionist?" : "I need to book an appointment.");
          await voiceUntil(() => f.mail.length === 1, "initial email proof"); await call.verify(f.mail[0]!.code);
          if (scenario === "cancel") { await play("Show me my appointments from October 4 through October 9."); await play("Cancel that appointment."); }
          else if (scenario === "move") { await play("Show my existing appointments from October 4 through October 9."); await play("My first existing appointment.");
            await play("Show move times on October 8."); await play("The first time, please."); }
          else if (scenario === "staffSaved") await play("Please send that request.");
          else { await play("What times are available on October 8?"); await play("The first time, please."); }
          if (["committed", "uncertain"].includes(scenario)) await play("Yes");
        }
        if (scenario === "negated") {
          for (const text of ["I don't need two clinicians; just one for my own visit.", "This booking is for me, not my partner.", "My neighbour said 'I cannot attend the group class tonight'."]) {
            await play(text); assert.ok(!cases.some(item => call!.spoken.at(-1) === item.expected));
            assert.equal(call.flow.workflow, "book"); assert.equal(call.flow.patientAccessDenied, false);
          }
          return;
        }
        const before = await call.state(), reads = traffic, mail = f.mail.length, writes = call.writes.length;
        const modelCase = scenario in paraphrases ? paraphrases[scenario as keyof typeof paraphrases] : undefined;
        await play(modelCase?.[0] ?? (["forged", "wrongFields"].includes(scenario) ? paraphrases.modelMinor[0] : cases[1].text));
        if (["forged", "wrongFields"].includes(scenario)) {
          assert.equal(call.spoken.at(-1), "I couldn't understand that safely. Could you repeat your request, or contact the clinic directly?");
          assert.equal(call.flow.workflow, undefined); assert.equal(call.flow.verificationRequired, false); return;
        }
        const notice = modelCase ? cases.find(item => item.text === ({ minorIntake: cases[0].text, proxyPatient: cases[1].text, jointPractitioners: cases[3].text, groupClass: cases[4].text })[modelCase[1]])!.expected : cases[1].expected;
        const prefix = scenario === "committed" ? "Your booking is confirmed. " : scenario === "uncertain" ? "I can't confirm that action yet. It is pending review. Please contact the clinic before trying again. I won't send that action again from this call. " : "";
        assert.equal(call.spoken.at(-1), prefix + notice, scenario);
        const after = await call.state();
        assert.equal(traffic, reads); assert.equal(f.mail.length, mail); assert.equal(call.writes.length, writes);
        assert.deepEqual(after.staffItems, before.staffItems);
        for (const action of Object.values(before.actions)) {
          if (action.status === "awaitingConfirmation") assert.equal(after.actions[action.key]?.status, "canceled");
          else assert.deepEqual(after.actions[action.key], action);
        }
        const sent = ["committed", "uncertain", "staffSaved"].includes(scenario);
        if (sent) {
          await play(scenario === "staffSaved" ? "Was my staff request saved?" : "What happened to that action?");
          assert.match(call.spoken.at(-1)!, scenario === "committed" ? /booking is confirmed/ : scenario === "uncertain" ? /can't confirm.*pending review/ : /request.*saved/i);
          assert.equal(call.writes.length, writes); assert.equal(f.mail.length, mail);
        } else {
          assert.equal(call.flow.workflow, undefined); assert.equal(call.flow.verificationRequired, false);
          assert.equal((await call.flow.submitCode(f.mail[0]?.code ?? "000000")).verified, false);
          for (const text of ["Yes", "Cancel that appointment.", "The first time, please."]) await play(text);
          assert.equal(call.writes.length, writes); assert.equal(f.mail.length, mail);
          assert.ok(!Object.values((await call.state()).actions).some(action => action.status === "awaitingConfirmation"));
          if (prepared) {
            await play(scenario === "cancel" ? "I need to cancel an appointment." : scenario === "move" ? "I need to move an appointment." : "I need to book an appointment.");
            await voiceUntil(() => f.mail.length === 2, `fresh self email proof for ${scenario}`);
            assert.equal(call.flow.verificationRequired, true); await call.verify(f.mail[1]!.code);
            await play(scenario === "cancel" ? "Show me my appointments from October 4 through October 9." : scenario === "move"
              ? "Show my existing appointments from October 4 through October 9." : "What times are available on October 8?");
            assert.match(call.spoken.at(-1)!, scenario === "cancel" ? /appointment on/i : /Option one/i);
          }
        }
        if ("knowledge" in f) { await play("Where is the clinic and where can I park?"); assert.equal(call.spoken.at(-1), publicDirections); }
        assert.ok(bodies.every(body => verificationCanaries.every(canary => !body.includes(canary))));
      } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const settled = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const item = scenarios[next++]; if (!item) return; await run(item); } }));
    for (const item of settled) if (item.status === "rejected") throw item.reason;
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `request_boundary_${index}`, value })))), []);
  });
});
