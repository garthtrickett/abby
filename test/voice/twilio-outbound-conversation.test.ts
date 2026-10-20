import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { ok } from "../../src/core/model.ts";
import type { MemoryLedger } from "../../src/core/ledger.ts";
import type { AdmissionReceipt } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import { outboundConversationProfileRef } from "../../src/voice/outbound-voice-entry.ts";
import type { OutboundConversationApproval } from "../../src/voice/outbound-voice-entry.ts";
import { twilioAbbyOutboundConversation } from "../../src/standalone/twilio-outbound-conversation.ts";
import { approvedSyntheticPolicy, syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import { outboundLaunchValue } from "../support/outbound-launch.ts";
import { twilioOutboundIngressFixture } from "../support/twilio-outbound-ingress.ts";
const now = "2026-11-01T10:00:00.000Z";
async function fixture(options: { changedRuntime?: boolean; revoked?: boolean; changedMedia?: boolean } = {}) {
  const scope = outboundLaunchValue().attempt.scope;
  const approval: OutboundConversationApproval = { purpose: "outboundContact", runtimeConfigurationHash: "a".repeat(64), mediaOptions: { silenceMs: 100 },
    policy: approvedSyntheticPolicy({ ...referenceDefaultPolicy(scope), automationEnabled: true,
      greeting: { scope, version: "outbound-v1", ownerRef: "clinic-owner", approved: true,
        approvedText: "Hello, this is Abby calling on behalf of the clinic.",
        effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z" } }) };
  let current = !options.revoked, opened = 0;
  let admitted: { ledger: MemoryLedger; receipt: AdmissionReceipt; sessionId: string } | undefined;
  const spoken: string[] = [], policies: unknown[] = [], turns: string[] = [];
  const f = await twilioOutboundIngressFixture({ profileRef: outboundConversationProfileRef(approval)!,
    conversation: runtime => twilioAbbyOutboundConversation({ runtime, runtimeConfigurationHash: (options.changedRuntime ? "b" : "a").repeat(64),
      source: { read: async call => { policies.push(call); return ok(approval); }, current: () => current }, readiness: async () => ok(true), now: () => now,
      mediaOptions: { silenceMs: options.changedMedia ? 200 : 100 },
      ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
        transcriptionFactory: sessionId => ({ accept: async () => ok([]), flush: async generation => ok([{ kind: "segmentFinal", sessionId, generation,
          utteranceId: "outgoing-one", text: "Hello, can you help?", quality: "clear" }]) }) }),
      session(ledger, receipt, sessionId, playback, _signal, original) {
        assert.deepEqual(original, f.original);
        opened++; admitted = { ledger, receipt, sessionId };
        const reception = new TextReception(ledger, withApprovedSyntheticVoice(new MemoryPolicyStore()), new ReferenceClinicHost([], []));
        return new VoiceSession(receipt.callId, sessionId, receipt.scope, ledger, reception, playback,
          async turn => { turns.push(turn.text); return ok({ kind: "clarify" }); });
      },
    }) });
  return { ...f, scope, approval, spoken, policies, turns, get opened() { return opened; }, get admitted() { return admitted; }, revoke() { current = false; } };
}
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
