import assert from "node:assert/strict";
import test from "node:test";
import { representativeRequestLanguage } from "../../src/standalone/representative-request-language.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { representativeCallOwnerFixture, representativeInputOptions } from "../support/representative-call-owner.ts";

test("E2E-386 explicit related-person requests select only an operation and retain urgent request precedence", async () => {
  assert.equal(representativeRequestLanguage("Book an appointment for my daughter"), "book");
  assert.equal(representativeRequestLanguage("Cancel an appointment for my husband"), "cancel");
  assert.equal(representativeRequestLanguage("Change an appointment for someone else"), "reschedule");
  assert.equal(representativeRequestLanguage("Check the appointment time for my wife"), "appointments.read");
  for (const text of ["Book my appointment", "Don't cancel an appointment for my son", "My daughter works here", "My appointment is with Susan"])
    assert.equal(representativeRequestLanguage(text), undefined);
  const f = await bookingCallFlowFixture(); let modelCalls = 0;
  try {
    const resolve = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: f.flow, clinicDate: () => "2026-10-04",
      fetch: async () => { modelCalls++; throw new Error("unexpected public model request"); } });
    assert.deepEqual(resultValue(await resolve(f.turn("family", "Book an appointment for my daughter"), new AbortController().signal)),
      { kind: "requestBoundary", reason: "proxyPatient" });
    assert.equal(resultValue(await resolve(f.turn("family-human", "Can I speak to a receptionist about booking an appointment for my daughter?"),
      new AbortController().signal)).kind, "staffRequest");
    const urgent = resultValue(await resolve(f.turn("urgent-family", "My daughter cannot breathe. Book an appointment for my daughter"), new AbortController().signal));
    assert.equal(urgent.kind, "handoff"); assert.equal(modelCalls, 0);
  } finally { await f.close(); }
  const g = await representativeCallOwnerFixture(); g.flow.dispose();
  const flow = resultValue(ClinikoCallFlow.create({ ...g.flowConfig, representativeInput: representativeInputOptions(g) }));
  try {
    const resolve = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
      fetch: async () => { throw new Error("unexpected model request"); } });
    assert.deepEqual(resultValue(await resolve(g.f.turn("configured-family", "Book an appointment for my daughter"), new AbortController().signal)),
      { kind: "workflow", operation: "book", forAnotherPerson: true });
    assert.equal(resultValue(await resolve(g.f.turn("configured-human", "Can I speak to a receptionist about booking an appointment for my daughter?"),
      new AbortController().signal)).kind, "staffRequest");
    assert.equal(flow.representativeInputOwner, undefined); assert.equal(g.mail.length, 0);
  } finally { flow.dispose(); await g.close(); }
});
