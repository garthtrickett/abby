import assert from "node:assert/strict";
import test from "node:test";
import { chmod, rm } from "node:fs/promises";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { DisabledStandaloneHost } from "../../src/standalone/disabled-host.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { clinicFAQFixture, publicDirections } from "../support/clinic-faqs.ts";
import { clinikoWorkflowVoiceFixture } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";

const question = "Where is your entrance, and could you repeat the directions slowly?";
const unavailable = "I can't verify that information right now.";

test("E2E-315 signed public clinic FAQs use current call-pinned facts without patient verification or writes", { timeout: 180_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["directions", "repeat", "hours", "contact", "draft", "disabled", "revoked", "duringModel", "changedText", "newVersion", "newCall", "newApproval", "expired", "admin", "membership", "scope", "missing", "permissions", "unknown", "medical", "medicalParaphrase", "automation", "duringAutomation", "forged", "interrupted", "closed"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const f = await clinicFAQFixture();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const bodies: string[] = [];
      try {
        if (scenario === "draft" || scenario === "newApproval") await f.replaceFAQs({ approved: false });
        if (scenario === "disabled") await f.replaceFAQs({ enabled: false });
        const open = () => clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
          clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            bodies.push(String(init?.body));
            if (scenario === "duringModel") await f.replaceFAQs({ enabled: false });
            if (scenario === "duringAutomation") {
              const policy = resultValue(await f.policies.read(f.scope));
              resultValue(await f.policies.changeAutomationEnabled(f.scope, policy.automationVersion!, false, "synthetic-admin"));
            }
            if (scenario === "closed") owner.dispose();
            const choice = scenario === "hours" ? 2 : scenario === "contact" ? 3 : scenario === "unknown" ? null : 1;
            const decision = { kind: "faq", operation: null, stage: null, from: null, to: null, choice,
              ...(scenario === "forged" ? { proposedText: "A fabricated private address." } : {}) };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }));
        call = await open();
        if (scenario === "automation") {
          const policy = resultValue(await f.policies.read(f.scope));
          resultValue(await f.policies.changeAutomationEnabled(f.scope, policy.automationVersion!, false, "synthetic-admin"));
        }
        if (scenario === "revoked") await f.replaceFAQs({ approved: false });
        if (scenario === "changedText") await f.replaceFAQs({ facts: [{ topic: "directionsAndParking", approvedText: "The entrance is now on Changed Street." }] });
        if (scenario === "newCall") await f.replaceFAQs({ revision: "public-faqs-2", facts: [{ topic: "directionsAndParking", approvedText: "Demo North now has its entrance on Example Lane." }] });
        if (scenario === "newVersion") await f.replaceFAQs({ revision: "public-faqs-2" });
        if (scenario === "newApproval") await f.replaceFAQs({ approved: true });
        if (scenario === "expired") await f.replaceFAQs({ effectiveUntil: verificationNow });
        if (scenario === "admin") await f.replaceAccount({ membershipVersion: "member-2", actor: { actorRef: "synthetic-admin", role: "staff", scope: f.scope } });
        if (scenario === "membership") await f.replaceAccount({ membershipVersion: "member-2" });
        if (scenario === "scope") await f.replaceFAQs({ scope: { ...f.scope, locationId: "other" } });
        if (scenario === "missing") await rm(f.faqPath);
        if (scenario === "permissions") await chmod(f.faqPath, 0o644);
        await call.turn(scenario === "medical" ? "Is it safe for me to attend after a recent treatment?" : scenario === "medicalParaphrase" ? "Can I safely come after surgery?" : scenario === "hours" ? "When do you open?" : scenario === "contact" ? "What is the clinic phone number?" : question);
        const expected = ["medical", "medicalParaphrase"].includes(scenario) ? "I can’t give medical advice or confirm it is safe to attend. Please contact your clinician or the clinic for advice." : ["directions", "repeat", "interrupted"].includes(scenario) ? publicDirections : scenario === "hours" ? f.faqApproval.facts[1]!.approvedText
          : scenario === "contact" ? f.faqApproval.facts[2]!.approvedText : unavailable;
        if (scenario === "forged" || scenario === "closed") assert.doesNotMatch(call.spoken.at(-1)!, /10 Example Street|fabricated private address/);
        else assert.equal(call.spoken.at(-1), expected, scenario);
        if (scenario === "repeat") { await call.mark(); await call.turn("Could you repeat the entrance directions?"); assert.equal(call.spoken.at(-1), publicDirections); }
        if (scenario === "interrupted") { await call.turn("Could you repeat that?", { interrupt: true }); assert.equal(call.spoken.at(-1), publicDirections); }
        if (scenario === "newCall") {
          await call.close(); call = await open(); await call.turn(question);
          assert.equal(call.spoken.at(-1), "Demo North now has its entrance on Example Lane.");
          assert.equal((await call.state()).knowledgeAnswers.length, 1);
        }
        if (["medical", "medicalParaphrase"].includes(scenario)) assert.equal(bodies.length, 0, "clinical clearance cannot be turned into a public fact by a model");
        assert.equal(f.mail.length, 0); assert.equal(call.flow.workflow, undefined); assert.equal(call.writes.length, 0);
        const state = await call.state(); assert.equal(Object.keys(state.actions).length, 0);
        if (!["directions", "repeat", "hours", "contact", "interrupted", "newCall"].includes(scenario)) assert.equal(state.knowledgeAnswers.length, 0);
        assert.ok(verificationCanaries.every(canary => bodies.every(body => !body.includes(canary))));
        if (["draft", "disabled", "revoked", "changedText", "newVersion", "newCall", "newApproval", "expired", "admin", "membership", "scope", "missing", "permissions"].includes(scenario))
          assert.ok(bodies.every(body => !body.includes(publicDirections)), `${scenario}: unavailable text must not enter the model`);
      } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const item = scenarios[next++]; if (!item) return; await run(item); } }));
    const failed = workers.find(worker => worker.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, i) => ({ label: `faq_${i}`, value })))), []);
  });
});

test("E2E-315 agent answers use the same pinned approval and reject invented wording", async () => {
  const f = await clinicFAQFixture();
  const ledger = new MemoryLedger(async () => ({ ok: true, value: true }));
  try {
    const reception = new TextReception(ledger, f.policies, new DisabledStandaloneHost(), undefined, undefined, undefined, f.knowledge);
    const callId = "public-faq-agent";
    const state = resultValue(await reception.startCall(callId, f.scope, verificationNow)); assert.equal(state.policy.knowledgeSnapshot?.length, 3);
    const agent = new CommandGateway({ actorRef: "faq-agent", role: "agent", scope: f.scope }, f.policies, reception, undefined, undefined, undefined, ledger);
    const answer = async (turnId: string, proposedText: string) => agent.submit({ kind: "knowledge.answer.v2",
      turn: { callId, turnId, text: question, quality: "clear", at: verificationNow }, sourceRefs: ["clinic-public-directionsAndParking"], proposedText, now: verificationNow });
    resultValue(await answer("approved", publicDirections));
    assert.equal(resultValue(await ledger.read(callId, f.scope)).callerMessages.at(-1), publicDirections);
    resultValue(await answer("invented", "The clinic is on Imaginary Street."));
    assert.equal(resultValue(await ledger.read(callId, f.scope)).callerMessages.at(-1), unavailable);
    await f.replaceFAQs({ approved: false }); resultValue(await answer("revoked", publicDirections));
    assert.equal(resultValue(await ledger.read(callId, f.scope)).callerMessages.at(-1), unavailable);
    await f.replaceFAQs({ approved: true });
    const policy = resultValue(await f.policies.read(f.scope));
    resultValue(await f.policies.changeAutomationEnabled(f.scope, policy.automationVersion!, false, "synthetic-admin"));
    resultValue(await answer("automation", publicDirections));
    assert.equal(resultValue(await ledger.read(callId, f.scope)).callerMessages.at(-1), unavailable);
    assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
  } finally { ledger.dispose(); await f.close(); }
});
