import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { clinicFAQFixture } from "../support/clinic-faqs.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { publicServiceInformationFixture, publicServices, publicPrices } from "../support/public-service-information.ts";
import { publicInformationUnavailable } from "../../src/core/public-information.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const services = publicServices;

test("E2E-322 an unclear service request reads approved descriptions without selecting the default appointment type", { timeout: 60_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await clinicFAQFixture(); let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    let traffic = 0;
    try {
      await f.replaceFAQs({ facts: [...f.faqApproval.facts, { topic: "serviceGuidance", approvedText: services }] });
      call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { traffic++; return f.flowConfig.fetchPort!(...args); } },
        owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
          fetch: async (_url, init) => {
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const start = text === "I need to book an appointment.";
            const decision = { kind: start ? "workflow" : "unsupported", operation: start ? "book" : null, stage: null, from: null, to: null, choice: null };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }));
      await call.turn("I need to book an appointment."); await call.mark();
      await voiceUntil(() => f.mail.length === 1, "booking verification"); await call.verify(f.mail[0]!.code);
      const before = await call.state(), reads = traffic, mail = f.mail.length;
      await call.turn("I do not know which appointment type I need."); await call.mark();
      assert.equal(call.spoken.at(-1), services);
      assert.equal(traffic, reads); assert.equal(f.mail.length, mail); assert.equal(call.writes.length, 0);
      assert.deepEqual((await call.state()).actions, before.actions); assert.deepEqual((await call.state()).staffItems, before.staffItems);
    } finally { await call?.close(); await f.close(); }
  });
});

test("E2E-322 approved service and fee questions remain public, pinned, interruptible and separate from clinical choices", { timeout: 180_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["initial", "verified", "price", "missingService", "missingPrice", "revoked", "expired", "admin", "changed", "newCall", "lateApproval", "duringModel", "model", "modelPrice", "quoted", "negated", "wrongFields", "forged", "faqOrdinal", "symptoms", "medical", "proposal", "committed", "uncertain", "denied", "repeat", "interrupted"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const f = await publicServiceInformationFixture({ services: !["missingService", "lateApproval"].includes(scenario), prices: scenario !== "missingPrice" });
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      let traffic = 0, models = 0; const bodies: string[] = [];
      try {
        const open = () => clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { traffic++; return f.flowConfig.fetchPort!(...args); } },
          owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_url, init) => {
              models++; bodies.push(String(init?.body));
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
              const start = text === "I need to book an appointment.", menu = text === "What times are available on October 8?";
              if (scenario === "duringModel" && text === "Could you explain the different visit categories?") await f.replaceFAQs({ enabled: false });
              const cue = !start && !menu;
              const decision = { kind: text === "I am not the patient you found." ? "identityDisagreement" : start ? "workflow" : menu ? "menu" : ["quoted", "negated"].includes(scenario) ? "unsupported" :
                scenario === "faqOrdinal" ? "faq" : scenario === "modelPrice" ? "priceAndFees" : "serviceGuidance",
                operation: start ? "book" : cue && scenario === "wrongFields" ? "book" : null,
                stage: null, from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: cue && scenario === "faqOrdinal" ? 4 : null,
                ...(cue && scenario === "forged" ? { proposedText: "You need surgery. I booked it and waived the fee." } : {}) };
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
            } }), { lostWrite: scenario === "uncertain" });
        call = await open(); const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        if (["verified", "proposal", "committed", "uncertain"].includes(scenario)) {
          await play("I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "private booking email");
          await call.verify(f.mail[0]!.code);
          if (scenario !== "verified") {
            await play("What times are available on October 8?"); await play("The first time, please.");
            if (scenario !== "proposal") await play("Yes");
          }
        }
        if (scenario === "denied") { await play("I am not the patient you found."); assert.equal((await call.state()).callerIdentityDenied, "identityDisagreement", "setup must actually revoke patient access before the public question"); }
        if (scenario === "revoked") await f.replaceFAQs({ approved: false });
        if (scenario === "expired") await f.replaceFAQs({ effectiveUntil: "2026-10-04T06:00:00.000Z" });
        if (scenario === "admin") await f.replaceAccount([]);
        if (["changed", "newCall"].includes(scenario)) await f.replaceFAQs({ facts: f.faqApproval.facts.map(fact => fact.topic === "serviceGuidance" ? { ...fact, approvedText: "The clinic now publishes a different service list. Contact clinic staff to choose a service." } : fact) });
        if (scenario === "lateApproval") await f.replaceFAQs({ facts: [...f.faqApproval.facts, { topic: "serviceGuidance", approvedText: publicServices }] });
        const before = await call.state(), reads = traffic, mail = f.mail.length, writes = call.writes.length, count = models;
        const price = ["price", "missingPrice"].includes(scenario), model = ["model", "duringModel", "wrongFields", "forged", "faqOrdinal"].includes(scenario);
        const question = price ? "What would this visit cost, and would I pay a fee to cancel?" : model ? "Could you explain the different visit categories?" :
          scenario === "modelPrice" ? "What charges might a consultation and its cancellation attract?" : scenario === "quoted" ? "My friend asked 'which appointment type do I need' yesterday." :
          scenario === "negated" ? "I am not asking for service descriptions." : scenario === "symptoms" ? "My knee hurts. Which appointment type should I book?" :
          scenario === "medical" ? "Is it safe for me to attend after surgery?" : "I do not know which appointment type I need.";
        await call.turn(question); if (scenario !== "interrupted") await call.mark();
        if (["quoted", "negated", "wrongFields", "forged", "faqOrdinal"].includes(scenario)) {
          assert.ok(!call.spoken.includes(publicServices)); assert.ok(!call.spoken.includes(publicPrices));
        } else if (scenario === "medical") assert.match(call.spoken.at(-1)!, /can’t give medical advice/);
        else if (["missingService", "revoked", "expired", "admin", "changed", "newCall", "lateApproval", "duringModel"].includes(scenario))
          assert.equal(call.spoken.at(-1), publicInformationUnavailable("serviceGuidance"), scenario);
        else assert.equal(call.spoken.at(-1), scenario === "missingPrice" ? publicInformationUnavailable("priceAndFees") : price || scenario === "modelPrice" ? publicPrices : publicServices, scenario);
        assert.equal(traffic, reads); assert.equal(f.mail.length, mail); assert.equal(call.writes.length, writes);
        const after = await call.state(); assert.deepEqual(after.staffItems, before.staffItems);
        assert.equal(Object.keys(after.actions).length, Object.keys(before.actions).length);
        for (const action of Object.values(before.actions)) assert.deepEqual(after.actions[action.key], action.status === "awaitingConfirmation" ? { ...action, status: "canceled" } : action);
        assert.ok(verificationCanaries.every(canary => bodies.every(body => !body.includes(canary))));
        assert.doesNotMatch(call.spoken.at(-1)!, /You need surgery|I booked it|waived the fee/);
        if (model || scenario === "modelPrice" || ["quoted", "negated", "symptoms"].includes(scenario)) assert.equal(models, count + 1);
        else assert.equal(models, count);
        if (scenario === "proposal") { await play("Yes"); assert.equal(call.writes.length, 0); }
        if (scenario === "repeat" || scenario === "interrupted") { await call.turn("I do not know which appointment type I need.", { interrupt: scenario === "interrupted" }); await call.mark(); assert.equal(call.spoken.at(-1), publicServices); }
        if (scenario === "denied") assert.equal((await call.state()).callerIdentityDenied, "identityDisagreement");
        if (scenario === "newCall") { await call.close(); call = await open(); await play(question); assert.equal(call.spoken.at(-1), f.faqApproval.facts.find(fact => fact.topic === "serviceGuidance")!.approvedText); }
      } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const settled = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const item = scenarios[next++]; if (!item) return; await run(item); } }));
    for (const result of settled) if (result.status === "rejected") throw result.reason;
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, i) => ({ label: `public_information_${i}`, value })))), []);
  });
});
