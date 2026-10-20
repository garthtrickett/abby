import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { CallRuntime } from "../../src/core/runtime.ts";
import { outboundConversationFixture as fixture } from "../support/twilio-outbound-conversation.ts";

test("signed actual outbound HTTP/WSS plays its greeting, handles a caller turn and stays unverified", { timeout: 10000 }, async t => {
  const f = await fixture(), server = await f.listen(); t.after(server.close);
  const response = await server.post(); assert.equal(response.status, 200);
  const wire = await server.open(await response.text()), messages: Record<string, unknown>[] = [];
  wire.socket.on("message", raw => { messages.push(JSON.parse(raw.toString())); });
  assert.equal(await wire.outcome, "ready");
  for (let i = 0; !messages.some(message => message.event === "mark") && i < 20; i++) await once(wire.socket, "message");
  assert.deepEqual(f.spoken, [f.approval.policy.greeting!.approvedText]); assert.equal(f.opened, 1);
  const owner = f.admitted!;
  assert.equal(owner.receipt.admission.direction, "outbound"); assert.equal("dialedNumber" in owner.receipt.admission, false);
  assert.deepEqual(Object.keys(f.policies[0] as object).sort(), ["clinicNumber", "key", "profileRef", "scope"]);
  const before = await owner.ledger.read(owner.receipt.callId, f.scope); assert.equal(before.ok, true);
  if (before.ok) assert.equal(Object.values(before.value.presentations)[0]?.status, "started");
  const marker = messages.find(message => message.event === "mark")!.mark;
  wire.socket.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid: f.streamSid, mark: marker }));
  // A WebSocket pong proves all earlier wire bytes reached the server before checking durable acknowledgement.
  const pong = once(wire.socket, "pong"); wire.socket.ping(); await pong;
  const runtime = new CallRuntime(owner.ledger, f.scope);
  let played = await runtime.read(owner.receipt.callId);
  for (let i = 0; played.ok && Object.values(played.value.presentations)[0]?.status !== "played" && i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 5)); played = await runtime.read(owner.receipt.callId);
  }
  assert.equal(played.ok, true); if (played.ok) {
    assert.equal(Object.values(played.value.presentations)[0]?.status, "played");
    assert.equal(played.value.lifecycle, "active"); assert.equal(Object.keys(played.value.actions).length, 0);
  }
  const followup = new Promise<void>((resolve, reject) => {
    wire.socket.on("message", raw => {
      const message = JSON.parse(raw.toString()) as { event?: string; mark?: { name?: string } };
      if (message.event === "mark" && message.mark?.name !== (marker as { name: string }).name) resolve();
    });
    wire.socket.once("close", () => reject(Error("Synthetic outgoing reply unavailable")));
  });

  for (let index = 0; index < 7; index++) wire.socket.send(JSON.stringify({ event: "media", sequenceNumber: String(index + 3), streamSid: f.streamSid,
    media: { track: "inbound", chunk: String(index + 1), timestamp: String(index * 20), payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
  await followup;
  assert.deepEqual(f.turns, ["Hello, can you help?"]); assert.equal(f.spoken.length, 2);
  const afterTurn = await runtime.read(owner.receipt.callId); assert.equal(afterTurn.ok, true);
  if (afterTurn.ok) { assert.equal(afterTurn.value.processedTurnIds.length, 1); assert.equal(Object.keys(afterTurn.value.actions).length, 0); }
  const authenticated = f.state.queries.find(query => query.operation === "startConversation")!.call;
  assert.equal(f.state.burned.has(authenticated.context.sessionActionRef), true);
  assert.equal(f.state.burned.has(authenticated.context.reportActionRef), false);
  assert.equal(f.state.burned.has(f.original.attempt.dncReferences!.actionRef), false);
  assert.deepEqual(await f.runtime.inspectTerminal(), { kind: "unknown" });
  const closed = once(wire.socket, "close"); wire.socket.close(); await closed;
});
for (const [label, options] of [["independent current approval", { revoked: true }], ["physical model configuration", { changedRuntime: true }],
  ["effective media options", { changedMedia: true }]] as const)
  test(`signed outbound ${label} failure spends its session exclusion but opens no speech or clinical session`, { timeout: 10000 }, async t => {
    const f = await fixture(options), server = await f.listen(); t.after(server.close);
    const response = await server.post(), wire = await server.open(await response.text());
    assert.equal(await wire.outcome, "closed"); assert.equal(f.opened, 0); assert.deepEqual(f.spoken, []);
    assert.equal(f.state.burned.size, 1); assert.deepEqual(await f.runtime.inspectTerminal(), { kind: "unknown" });
  });


for (const phase of ["accept", "flush"] as const)
test(`signed outbound ${phase} result after approval withdrawal never enters the session or intent`, { timeout: 10000 }, async t => {
  const f = await fixture({ withdrawDuringTranscription: phase }), server = await f.listen(); t.after(server.close);
  const response = await server.post(), wire = await server.open(await response.text()), messages: Record<string, unknown>[] = [];
  wire.socket.on("message", raw => { messages.push(JSON.parse(raw.toString())); }); assert.equal(await wire.outcome, "ready");
  for (let i = 0; !messages.some(m => m.event === "mark") && i < 20; i++) await once(wire.socket, "message");
  const marker = messages.find(m => m.event === "mark")!.mark;
  wire.socket.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid: f.streamSid, mark: marker }));
  const pong = once(wire.socket, "pong"); wire.socket.ping(); await pong;
  const closed = once(wire.socket, "close");
  for (let index = 0; index < 7; index++) wire.socket.send(JSON.stringify({ event: "media", sequenceNumber: String(index + 3), streamSid: f.streamSid,
    media: { track: "inbound", chunk: String(index + 1), timestamp: String(index * 20), payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
  await closed;
  assert.deepEqual(f.acceptedTranscripts, []); assert.deepEqual(f.turns, []); assert.equal(f.spoken.length, 1);
  assert.deepEqual(await f.runtime.inspectTerminal(), { kind: "unknown" });
});
