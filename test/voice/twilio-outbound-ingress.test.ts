import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { twilioOutboundIngressFixture } from "../support/twilio-outbound-ingress.ts";

test("actual signed outbound HTTP and WebSocket reach one separate private owner and the real media decoder", { timeout: 10_000 }, async t => {
  const f = await twilioOutboundIngressFixture(), server = await f.listen(); t.after(server.close);
  const response = await server.post(); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const wire = await server.open(await response.text()); assert.equal(await wire.outcome, "ready");
  assert.deepEqual(f.state.frames, ["connected", "started"]); assert.equal(f.state.created, 1); assert.equal(f.state.claims.length, 1);
  const closed = once(wire.socket, "close"); wire.socket.close(); await closed;
  assert.equal(f.state.disconnected, 1);
});
for (const fault of ["signature", "foreignNumber", "inboundDirection", "clinicGrant", "clinicCurrent"] as const)
test(`outbound HTTP ${fault} cannot mint an admitted voice route`, { timeout: 10_000 }, async t => {
  const f = await twilioOutboundIngressFixture(), server = await f.listen(); t.after(server.close);
  if (fault === "clinicGrant") f.state.allowed = false;
  if (fault === "clinicCurrent") f.state.current = false;
  const response = await server.post("answer", fault === "foreignNumber" ? { To: "+61455550999" } : fault === "inboundDirection" ? { Direction: "inbound" } : {}, fault !== "signature");
  assert.equal(response.status, fault === "clinicGrant" || fault === "clinicCurrent" ? 503 : 403);
  assert.equal((await response.text()).includes("abbyOutbound"), false);
  assert.equal(f.state.created, 0); assert.deepEqual(f.state.claims, []);
});
for (const patch of [{ mediaFormat: { encoding: "audio/pcm", sampleRate: 16000, channels: 1 } }, { tracks: ["outbound"] },
  { tracks: ["inbound", "outbound"] }, { callSid: `CA${"d".repeat(32)}` }, { customParameters: {} }])
test(`foreign or unsupported outbound start ${Object.keys(patch)[0]} cannot consume the session or construct a call`, { timeout: 10_000 }, async t => {
  const f = await twilioOutboundIngressFixture(), server = await f.listen(); t.after(server.close);
  const answer = await server.post(), wire = await server.open(await answer.text(), patch);
  assert.equal(await wire.outcome, "closed"); assert.equal(f.state.created, 0); assert.deepEqual(f.state.claims, []);
});
test("a fresh cold server cannot replay the original session after its first owner disconnected", { timeout: 10_000 }, async t => {
  const f = await twilioOutboundIngressFixture(), first = await f.listen(); t.after(first.close);
  const answer = await first.post(), wire = await first.open(await answer.text()); assert.equal(await wire.outcome, "ready");
  await first.close();
  const cold = await f.listen(); t.after(cold.close);
  const replay = await cold.post(), second = await cold.open(await replay.text()); assert.equal(await second.outcome, "closed");
  assert.equal(f.state.created, 1); assert.equal(f.state.burned.size, 1); assert.equal(f.state.claims.length, 2);
});
test("permission lost during the actual session exclusion wait refuses construction and preserves the spent exclusion", { timeout: 10_000 }, async t => {
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
  const f = await twilioOutboundIngressFixture({ claimWait: async () => { entered(); await hold; } }), server = await f.listen(); t.after(server.close);
  const answer = await server.post(), wire = await server.open(await answer.text()); await waiting; f.state.current = false; release();
  assert.equal(await wire.outcome, "closed"); assert.equal(f.state.created, 0); assert.equal(f.state.burned.size, 1);
});
test("completed progress is a historical fact and never starts a session or claims the independent report action", { timeout: 10_000 }, async t => {
  const f = await twilioOutboundIngressFixture(), server = await f.listen(); t.after(server.close);
  const response = await server.post("status", { CallStatus: "completed" }); assert.equal(response.status, 204);
  assert.deepEqual(f.state.progress, ["completed"]); assert.deepEqual(f.state.claims, []); assert.equal(f.state.created, 0);
  assert.deepEqual(await f.runtime.inspectTerminal(), { kind: "unknown" });
});
test("an ignored authority abort cannot leave the signed HTTP handler waiting indefinitely", { timeout: 10_000 }, async t => {
  const f = await twilioOutboundIngressFixture({ deadlineMs: 30, allow: async () => new Promise<boolean>(() => {}) }), server = await f.listen(); t.after(server.close);
  const response = await server.post(); assert.equal(response.status, 503); assert.deepEqual(f.state.claims, []); assert.equal(f.state.created, 0);
});

test("contact permission withdrawn after the answer refuses the later signed stream before its permanent claim", { timeout: 10_000 }, async t => {
  const f = await twilioOutboundIngressFixture(), server = await f.listen(); t.after(server.close);
  const response = await server.post(); assert.equal(response.status, 200); const xml = await response.text();
  f.state.allowed = false; const wire = await server.open(xml);
  assert.equal(await wire.outcome, "closed"); assert.equal(f.state.created, 0); assert.deepEqual(f.state.claims, []);
});
test("two independent server instances still construct only one owner for the same original sealed session", { timeout: 10_000 }, async t => {
  const f = await twilioOutboundIngressFixture(), first = await f.listen(), second = await f.listen(); t.after(first.close); t.after(second.close);
  const [a, b] = await Promise.all([first.post(), second.post()]);
  const [one, two] = await Promise.all([first.open(await a.text()), second.open(await b.text())]);
  assert.deepEqual((await Promise.all([one.outcome, two.outcome])).sort(), ["closed", "ready"]);
  assert.equal(f.state.created, 1); assert.equal(f.state.burned.size, 1); assert.equal(f.state.claims.length, 2);
});
test("independent admission cannot edit the original send context it is being asked to approve", { timeout: 10_000 }, async t => {
  const f = await twilioOutboundIngressFixture({ allow: async query => {
    Object.assign(query.call.context.original.attempt.scope, { tenantId: "foreign" }); return true;
  } }), server = await f.listen(); t.after(server.close);
  assert.equal((await server.post()).status, 503); assert.equal(f.state.created, 0); assert.deepEqual(f.state.claims, []);
});

test("blocked startup cannot retain an unbounded queue of wire messages before the owner exists", { timeout: 10_000 }, async t => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
  const f = await twilioOutboundIngressFixture({ allow: async q => {
    if (q.operation === "startConversation") { enter(); await gate; } return true;
  } }), server = await f.listen(); t.after(server.close); t.after(release);
  const answer = await server.post(), wire = await server.open(await answer.text()); await entered;
  const observed = Promise.race([once(wire.socket, "pong"), once(wire.socket, "close")]);
  for (let n = 0; n < 80; n++) wire.socket.send(JSON.stringify({ event: "media", sequenceNumber: String(n + 2), media: {} }));
  wire.socket.ping("startup-flood"); await observed;
  assert.notEqual(wire.socket.readyState, 1, "wire backlog must close before the blocked admission is released");
  assert.equal(f.state.created, 0); assert.deepEqual(f.state.claims, []);
});
