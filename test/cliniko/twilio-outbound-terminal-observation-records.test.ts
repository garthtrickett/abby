import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoTwilioOutboundTerminalObservationRecords, twilioOutboundTerminalObservationRecordBinding } from "../../src/cliniko/twilio-outbound-terminal-observation-records.ts";
import type { TwilioOutboundTerminalObservationQuery } from "../../src/cliniko/twilio-outbound-terminal-observation-records.ts";
import { encodeTwilioOutboundTerminalObservation, TwilioOutboundTerminalObservationAuthentication } from "../../src/cliniko/twilio-outbound-terminal-observation.ts";
import { twilioOutboundTerminalObservationRecordsFixture as fixture } from "../support/twilio-outbound-terminal-observation-records.ts";
import { value } from "../support/outbound-records.ts";

test("dedicated notification family consumes only its derived action and independent cold reads provide no finality port", async () => {
  const f = await fixture(), retained = value(await f.retain()); assert.equal(retained.kind, "accepted");
  if (retained.kind !== "accepted") assert.fail();
  assert.deepEqual([...f.burned], [f.observation.actionRef]);
  for (const ref of [f.context.reportActionRef, f.context.sessionActionRef, f.context.original.attempt.actionRef]) assert.equal(f.burned.has(ref), false);
  const cold = value(ClinikoTwilioOutboundTerminalObservationRecords.createReadOnly(f.config, f.auth, f.authority, f.native.port));
  for (const name of ["retainObservationOnce", "inspectTerminal", "inspectContact", "releaseOnce"]) assert.equal(name in cold, false);
  const binding = { recallRef: retained.recallRef, actionRef: f.observation.actionRef, patientId: f.observation.patientId };
  const read = value(await cold.readObservation(binding, new AbortController().signal)); assert.deepEqual(read.record, f.observation);
  assert.ok(f.queries.some(q => q.operation === "readTerminalObservation" && !q.observation));
  assert.ok(f.queries.some(q => q.operation === "readTerminalObservation" && q.observation && q.observationDigest));
  assert.equal((await f.retain()).ok, false); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
});

for (const mode of ["mac", "original", "account"] as const)
test(`notification ${mode} mismatch refuses before quota, effect claim or native dispatch`, async () => {
  const f = await fixture(), observation = mode === "mac" ? { ...f.observation, number: "+12025550999" } : f.observation;
  const context = mode === "original" ? { ...f.context, sessionActionRef: randomUUID() } : f.context;
  assert.equal((await f.records.retainObservationOnce(observation, context, mode === "account" ? "AC" + "9".repeat(32) : observation.accountSid,
    "2026-11-02", new AbortController().signal)).ok, false);
  assert.equal(f.native.calls.length, 0); assert.equal(f.burned.size, 0); assert.equal(f.native.claims, 0);
});

for (const mode of ["broad", "producer", "current"] as const)
test(`independent notification ${mode} permission remains required`, async () => {
  const f = await fixture(); if (mode === "broad") f.state.allowed = false;
  if (mode === "producer") f.state.producer = false; if (mode === "current") f.state.live = false;
  assert.equal((await f.retain()).ok, false); assert.equal(f.native.calls.length, 0); assert.equal(f.burned.size, 0);
});

test("a valid MAC and broad record read cannot bypass decoded private evidence permission", async () => {
  const f = await fixture(), retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
  f.state.decoded = false;
  assert.equal((await f.records.readObservation({ recallRef: retained.recallRef, actionRef: f.observation.actionRef, patientId: f.observation.patientId }, new AbortController().signal)).ok, false);
});

test("native edits cannot promote notification timing to authenticated original evidence", async () => {
  const f = await fixture(), retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
  const row = f.native.rows.get(retained.recallRef.split(":").at(-1)!)!;
  row.notes = value(encodeTwilioOutboundTerminalObservation({ ...f.observation, receivedAt: "2026-11-01T10:02:59.000Z" }));
  assert.equal((await f.records.readObservation({ recallRef: retained.recallRef, actionRef: f.observation.actionRef, patientId: f.observation.patientId }, new AbortController().signal)).ok, false);
});

test("closed archived notification stays readable without allowing another action", async () => {
  const f = await fixture(), retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
  const row = f.native.rows.get(retained.recallRef.split(":").at(-1)!)!;
  row.recalled = true; row.recalled_at = f.observation.recordedAt; row.archived_at = f.observation.recordedAt;
  const cold = value(ClinikoTwilioOutboundTerminalObservationRecords.createReadOnly(f.config, f.auth, f.authority, f.native.port));
  const read = value(await cold.readObservation({ recallRef: retained.recallRef, actionRef: f.observation.actionRef, patientId: f.observation.patientId }, new AbortController().signal));
  assert.equal(read.archivedAt, f.observation.recordedAt); assert.deepEqual(read.record, f.observation);
  assert.equal((await f.retain()).ok, false); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
});

test("key selection is independently authorized and cannot reset the permanent notification purpose", async () => {
  const f = await fixture(), expected = f.auth.authenticationBinding(), wrong = new TwilioOutboundTerminalObservationAuthentication(Buffer.alloc(32, 29), f.auth.binding());
  assert.notEqual(wrong.authenticationBinding(), expected);
  assert.equal(twilioOutboundTerminalObservationRecordBinding(f.config, wrong), f.owner);
  const authority = { allows: async (q: TwilioOutboundTerminalObservationQuery) => q.authenticationBinding === expected,
    current: (q: TwilioOutboundTerminalObservationQuery) => q.authenticationBinding === expected,
    producerAdmitted: async (q: TwilioOutboundTerminalObservationQuery) => q.authenticationBinding === expected };
  const forged = value(wrong.sign(f.unsigned));
  const unapproved = value(ClinikoTwilioOutboundTerminalObservationRecords.create(f.config, wrong, authority, f.effects, f.native.port));
  assert.equal((await unapproved.retainObservationOnce(forged, f.context, forged.accountSid, "2026-11-02", new AbortController().signal)).ok, false);
  assert.equal(f.burned.size, 0); assert.equal(f.native.calls.length, 0);
  assert.equal(value(await f.retain()).kind, "accepted");
  const permissive = value(ClinikoTwilioOutboundTerminalObservationRecords.create(f.config, wrong,
    { allows: async () => true, current: () => true, producerAdmitted: async () => true }, f.effects, f.native.port));
  assert.equal((await permissive.retainObservationOnce(forged, f.context, forged.accountSid, "2026-11-02", new AbortController().signal)).ok, false);
  assert.deepEqual([...f.burned], [f.observation.actionRef]); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
});

test("lost native acknowledgement stays consumed; an exact permitted read can observe the stored record without another POST", async () => {
  const f = await fixture({ response: (row, method) => { if (method === "POST") throw Error("synthetic response lost after commit"); return Response.json(row); } });
  assert.equal(value(await f.retain()).kind, "uncertain"); assert.equal((await f.retain()).ok, false);
  const id = [...f.native.rows.keys()][0]!;
  const read = value(await f.records.readObservation({ recallRef: `cliniko:recall:${id}`, actionRef: f.observation.actionRef, patientId: f.observation.patientId }, new AbortController().signal));
  assert.deepEqual(read.record, f.observation); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
});

test("permission withdrawn during native budget wait refuses the spent effect before transport", async () => {
  const f = await fixture();
  const config = { ...f.config, rateBudget: { claim: async () => { f.state.live = false; return null; }, observe429: f.config.rateBudget.observe429 } };
  const records = value(ClinikoTwilioOutboundTerminalObservationRecords.create(config, f.auth, f.authority, f.effects, f.native.port));
  assert.equal((await records.retainObservationOnce(f.observation, f.context, f.observation.accountSid, "2026-11-02", new AbortController().signal)).ok, false);
  assert.deepEqual([...f.burned], [f.observation.actionRef]); assert.equal(f.native.calls.length, 0);
});
