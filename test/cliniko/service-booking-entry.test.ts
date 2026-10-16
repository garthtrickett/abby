import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { serviceBookingFixture } from "../support/service-booking-catalogue.ts";

const decision = (patch: Record<string, unknown> = {}) => ({ kind: "workflow", operation: "book", stage: null, from: null, to: null, choice: null, ...patch });
const response = (value: unknown) => Response.json({ status: "completed", output: [{ type: "message", status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value) }] }] });

test("E2E-350 a model-routed booking starts only public questions; direct choice and unplayed answers cannot issue proof", async () => {
  const f = await serviceBookingFixture(); let requests = 0;
  try {
    const resolve = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
      fetch: async () => { requests++; return response(decision()); } });
    const result = await resolve(f.turn("entry", "Can I arrange a physiotherapy appointment?"));
    assert.equal(result.ok && result.value.kind, "serviceQuestion");
    assert.equal(f.mail.length, 0); assert.equal(f.posts, 0); assert.equal(f.flow.workflow, undefined);
    const reply = await resolve(f.turn("unplayed-reply", "Physiotherapy."));
    assert.deepEqual(reply, { ok: true, value: { kind: "clarify", reason: "serviceChoiceChanged" } });
    assert.equal(requests, 1); assert.equal(f.mail.length, 0);
    assert.equal((await f.flow.choose("book")).ok, false, "the routing hook must not authorize direct no-choice booking");
  } finally { await f.close(); }
});

test("E2E-350 forged selection, malformed routes and canceled responses cannot become guided authority", async () => {
  const f = await serviceBookingFixture();
  try {
    const controller = new AbortController();
    const rows = [decision({ serviceChoice: { name: "Physiotherapy", durationMinutes: 60, visitKind: "initial" } }),
      decision({ stage: "offers" }), decision({ from: "2026-10-08", to: "2026-10-08" })];
    const resolve = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
      fetch: async () => { if (rows.length) return response(rows.shift()); controller.abort(); return response(decision()); } });
    for (let index = 0; index < 3; index++) assert.deepEqual(await resolve(f.turn(`forged-${index}`, "Can I arrange an appointment?")),
      { ok: false, error: { kind: "intentUnavailable" } });
    assert.deepEqual(await resolve(f.turn("aborted", "Can I arrange an appointment?"), controller.signal), { ok: false, error: { kind: "intentUnavailable" } });
    assert.equal(await f.flow.serviceDialogueIntent(f.turn("not-started", "Physiotherapy.")), undefined);
    assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
