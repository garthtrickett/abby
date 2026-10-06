import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { clinicDayStartUtc } from "../../src/standalone/clinic-clock.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { staffRequestSubjects } from "../../src/core/staff-request-subject.ts";

const unavail = { ok: false, error: { kind: "intentUnavailable" } };
const decision = (kind: string, patch: Record<string, unknown> = {}) =>
  ({ kind, operation: null, stage: null, from: null, to: null, choice: null, ...patch });
const completed = (value: unknown) => Response.json({ status: "completed", output: [{ type: "message", status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value) }] }] });

test("clinic date range boundaries honor Sydney daylight saving transitions", () => {
  assert.equal(clinicDayStartUtc("Australia/Sydney", "2026-10-04"), "2026-10-03T14:00:00.000Z");
  assert.equal(clinicDayStartUtc("Australia/Sydney", "2026-10-05"), "2026-10-04T13:00:00.000Z");
  assert.equal(clinicDayStartUtc("Australia/Sydney", "2027-04-04"), "2027-04-03T13:00:00.000Z");
  assert.equal(clinicDayStartUtc("Australia/Sydney", "2027-04-05"), "2027-04-04T14:00:00.000Z");
});

test("E2E-304 clinical model rejects malformed, forged and wrong-phase decisions before any patient operation", async () => {
  const f = await bookingCallFlowFixture();
  try {
    const responses: Response[] = [
      completed({ ...decision("workflow", { operation: "book" }), patientRef: "forged" }),
      completed(decision("workflow", { operation: "delete" })),
      completed(decision("choice", { choice: 1 })),
      completed(decision("appointments", { operation: "cancel" })),
      completed(decision("menu", { from: "2026-10-02", to: "2026-10-02" })),
      completed(decision("menu", { from: "2026-10-08", to: "2026-10-16" })),
      Response.json({ status: "completed", output: [{ type: "function_call", name: "book" }] }),
      Response.json({ status: "completed", output: [{ type: "message", status: "completed",
        content: [{ type: "refusal", refusal: "cannot comply" }] }] }),
      Response.json({ status: "incomplete", output: [] }),
      new Response("x".repeat(20_000)),
      completed(decision("workflow", { operation: "book" })),
    ];
    let requests = 0;
    const resolver = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic-model-key", model: "configured-model",
      clinicDate: () => "2026-10-04", fetch: (async (_url, init) => {
        requests++;
        const body = String(init?.body);
        assert.deepEqual(Object.keys(JSON.parse(JSON.parse(body).input[1].content)).sort(), ["callerText", "lastAction", "lastMenu", "phase", "workflow"]);
        assert.equal(body.includes(f.callId), false); assert.equal(body.includes(f.sessionId), false);
        return responses.shift()!;
      }) as typeof fetch });
    for (let index = 0; index < 10; index++) assert.deepEqual(await resolver(f.turn(`unsafe-${index}`, "I want to book")), unavail);
    assert.equal(requests, 10); assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
    assert.deepEqual(await resolver(f.turn("code", "My code is 123456")), unavail);
    assert.equal(requests, 10, "a six-digit spoken code cannot be sent to the model");
    const valid = await resolver(f.turn("book", "I need to book"));
    assert.deepEqual(valid, { ok: true, value: { kind: "workflow", operation: "book" } });
    assert.equal(f.mail.length, 0, "the model alone cannot begin patient verification");
    const foreign = f.turn("foreign", "I need to book");
    assert.deepEqual(await resolver({ ...foreign, sessionId: "different-session" }), unavail);
    assert.equal(requests, 11);
    const controller = new AbortController(); controller.abort();
    assert.deepEqual(await resolver(f.turn("aborted", "I need to book"), controller.signal), unavail);
    assert.equal(requests, 11);
  } finally { f.flow.dispose(); await f.close(); }
});

test("clinical model cancellation returns promptly if a response provider ignores correction abort", async () => {
  const f = await bookingCallFlowFixture();
  try {
    const resolver = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic-model-key", model: "configured-model",
      clinicDate: () => "2026-10-04", fetch: (async () => new Promise<Response>(() => undefined)) as typeof fetch });
    const controller = new AbortController(), request = resolver(f.turn("slow", "I need to book"), controller.signal);
    controller.abort();
    assert.deepEqual(await Promise.race([request, new Promise(resolve => setTimeout(() => resolve("stalled"), 500))]), unavail);
    assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
  } finally { f.flow.dispose(); await f.close(); }
});

test("E2E-323 model staff categories carry no patient, free-text or clinical authority", async () => {
  const f = await bookingCallFlowFixture();
  try {
    let response: unknown;
    const resolver = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic-key", model: "synthetic-model",
      clinicDate: () => "2026-10-04", fetch: async () => completed(response) });
    let turn = 0;
    for (const requestSubject of staffRequestSubjects) {
      response = decision(requestSubject);
      assert.deepEqual(await resolver(f.turn(`purpose-${turn++}`, "Please look into my request.")), { ok: true, value: { kind: "staffRequest", requestSubject } });
      for (const patch of [{ operation: "book" }, { choice: 1 }, { patientRef: "forged" }, { taskText: "Send a refund now." }]) {
        response = decision(requestSubject, patch);
        assert.deepEqual(await resolver(f.turn(`forged-${turn++}`, "Please look into my request.")), unavail);
      }
    }
    response = decision("sendInvoice"); assert.deepEqual(await resolver(f.turn("unknown-purpose", "Please look into my request.")), unavail);
    assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
  } finally { f.flow.dispose(); await f.close(); }
});
