import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { patientCorrectionCallFlowFixture } from "../support/patient-correction-call-flow.ts";

test("E2E-365 contact routing keeps inline values private and preserves urgent, financial and caller-identity boundaries", async () => {
  const f = await patientCorrectionCallFlowFixture();
  let modelRequests = 0;
  try {
    const resolve = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic-model-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
      fetch: async () => { modelRequests++; throw new Error("local routing must not send these values to a model"); } });
    const turn = (text: string) => ({ callId: f.callId, sessionId: f.sessionId, turnId: crypto.randomUUID(), text, quality: "clear" as const, at: f.config.clock() });
    assert.deepEqual(await resolve(turn("Please update my email to private-routing@example.test.")), { ok: true, value: { kind: "workflow", operation: "patientUpdate" } });
    const urgent = await resolve(turn("This is a medical emergency. Please update my email."));
    assert.ok(urgent.ok); assert.equal(urgent.value.kind, "handoff");
    const financial = await resolve(turn("Please update my email. My card number is 4111 1111 1111 1111."));
    assert.ok(financial.ok); assert.equal(financial.value.kind, "clarify");
    const identity = await resolve(turn("That's not me. Please update my email."));
    assert.ok(identity.ok); assert.equal(identity.value.kind, "callerIdentityDenied");
    assert.equal(modelRequests, 0);
  } finally { await f.close(); }
});
