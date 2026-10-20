import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { ok } from "../../src/core/model.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import type { PrivateKeypadInput } from "../../src/voice/private-keypad-input.ts";
import type { PreparedVoiceSession } from "../../src/voice/reception-voice-call.ts";
import type { OutboundVoicePreparation } from "../../src/standalone/twilio-outbound-conversation.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { intakeDeferred } from "../support/intake-edge.ts";
import { withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import { outboundConversationFixture } from "../support/twilio-outbound-conversation.ts";
import { twilioOutboundIngressFixture } from "../support/twilio-outbound-ingress.ts";

/** Transport witness only. This input grants no patient proof/clinical action. */
class SyntheticPrivateInput implements PrivateKeypadInput {
  claims = 0; starts = 0; stops = 0; digits = "";
  readonly accepted = intakeDeferred<void>();
  readonly started = intakeDeferred<void>();
  readonly stopped = intakeDeferred<void>();
  #claimed = false; #started = false; #closed = false; #answered = false;
  readonly context: OutboundVoicePreparation;
  readonly wrongSession: boolean;
  constructor(context: OutboundVoicePreparation, wrongSession = false) { this.context = context; this.wrongSession = wrongSession; }
  claim(callId: string, sessionId: string) {
    this.claims++;
    if (this.#claimed || this.#closed || callId !== callIdFor(this.context.call.key) || this.wrongSession || sessionId !== this.context.sessionId) return false;
    this.#claimed = true; return true;
  }
  start() { this.starts++; if (!this.#claimed || this.#closed || this.#started) return false; this.#started = true; this.started.resolve(); return true; }
  blocked() { return !this.#answered || this.#closed; }
  async accept(digit: string): Promise<"pending" | "verified" | "failed"> {
    if (!this.#started || this.#closed) return "failed";
    if (digit === "#") { this.#answered = true; this.accepted.resolve(); return "verified"; }
    this.digits += digit; return "pending";
  }
  stop() { this.stops++; this.#closed = true; this.stopped.resolve(); }
}

async function open(f: Awaited<ReturnType<typeof outboundConversationFixture>>) {
  const server = await f.listen(), response = await server.post(), wire = await server.open(await response.text());
  return { server, wire };
}

test("signed outgoing prepared input owns wire digits and discards secret audio before ordinary intent", { timeout: 12000 }, async t => {
  let input!: SyntheticPrivateInput;
  const f = await outboundConversationFixture({ prepare: async (context, create) => {
    assert.equal("inbound" in context, false); assert.equal("dialedNumber" in context.call, false);
    assert.equal(Object.isFrozen(context.call.key), true);
    input = new SyntheticPrivateInput(context); return { create, privateKeypadInput: input };
  } });
  const { server, wire } = await open(f); t.after(server.close);
  const messages: Record<string, unknown>[] = [];
  wire.socket.on("message", raw => { messages.push(JSON.parse(raw.toString())); });
  assert.equal(await wire.outcome, "ready");
  while (!messages.some(m => m.event === "mark")) await once(wire.socket, "message");
  await input.started.promise;
  assert.equal(input.claims, 1); assert.equal(input.starts, 1); assert.equal(f.opened, 1);
  const marker = messages.find(m => m.event === "mark")!.mark;
  let sequence = 1;
  const send = (message: object) => wire.socket.send(JSON.stringify({ ...message, streamSid: f.streamSid, sequenceNumber: String(++sequence) }));
  send({ event: "mark", mark: marker });
  for (let i = 0; i < 7; i++) send({ event: "media", media: { track: "inbound", chunk: String(i + 1), timestamp: String(i * 20),
    payload: Buffer.alloc(160, i < 2 ? 0x9f : 0xff).toString("base64") } });
  for (const digit of "527419#") send({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
  await input.accepted.promise;
  assert.equal(input.digits, "527419"); assert.deepEqual(f.acceptedTranscripts, []); assert.deepEqual(f.turns, []);
  // Finish the actual fresh quiet-drain interval before starting ordinary speech.
  // The in-process wire pong follows all preceding synchronous discard work.
  for (let i = 0; i < 25; i++) send({ event: "media", media: { track: "inbound", chunk: String(i + 8), timestamp: String((i + 7) * 20),
    payload: Buffer.alloc(160, 0xff).toString("base64") } });
  const pong = once(wire.socket, "pong"); wire.socket.ping(); await pong;
  const replied = new Promise<void>((resolve, reject) => {
    wire.socket.on("message", raw => {
      const message = JSON.parse(raw.toString()) as { event?: string; mark?: { name?: string } };
      if (message.event === "mark" && message.mark?.name !== (marker as { name: string }).name) resolve();
    });
    wire.socket.once("close", () => reject(Error("Prepared input could not resume ordinary speech")));
  });
  for (let i = 0; i < 7; i++) send({ event: "media", media: { track: "inbound", chunk: String(i + 33), timestamp: String((i + 32) * 20),
    payload: Buffer.alloc(160, i < 2 ? 0x9f : 0xff).toString("base64") } });
  await replied;
  assert.deepEqual(f.turns, ["Hello, can you help?"]); assert.equal(f.spoken.length, 2);
  assert.equal(JSON.stringify([messages, f.spoken, f.acceptedTranscripts, f.turns]).includes("527419"), false);
  const closed = once(wire.socket, "close"); wire.socket.close(); await closed; await input.stopped.promise;
  assert.equal(input.stops, 1); assert.deepEqual(await f.runtime.inspectTerminal(), { kind: "unknown" });
});

for (const failure of ["approval", "wrongSession", "malformed", "factoryThrow", "extraField"] as const)
test(`prepared ${failure} refusal opens no conversation and retires its input once`, { timeout: 10000 }, async t => {
  let input!: SyntheticPrivateInput;
  const entered = intakeDeferred<void>(), release = intakeDeferred<void>();
  const f = await outboundConversationFixture({ prepare: async (context, create) => {
    input = new SyntheticPrivateInput(context, failure === "wrongSession"); entered.resolve(); await release.promise;
    if (failure === "malformed") return { create: undefined, privateKeypadInput: input } as unknown as PreparedVoiceSession;
    if (failure === "factoryThrow") return { create() { throw Error("Synthetic factory refusal"); }, privateKeypadInput: input };
    if (failure === "extraField") return { create, privateKeypadInput: input, unsupported: true } as PreparedVoiceSession;
    return { create, privateKeypadInput: input };
  } });
  const { server, wire } = await open(f); t.after(server.close); t.after(() => release.resolve());
  await entered.promise;
  if (failure === "approval") f.revoke();
  release.resolve(); assert.equal(await wire.outcome, "closed"); await input.stopped.promise;
  assert.equal(input.stops, 1); assert.equal(input.starts, 0); assert.equal(f.opened, 0); assert.deepEqual(f.spoken, []);
  assert.equal(f.state.burned.size, 1);
});

for (const cause of ["disconnect", "wireDeadline"] as const)
test(`late prepared input after ${cause} is discarded without reviving a session`, { timeout: 12000 }, async t => {
  let input!: SyntheticPrivateInput;
  const ready = intakeDeferred<SyntheticPrivateInput>();
  const entered = intakeDeferred<OutboundVoicePreparation>(), release = intakeDeferred<void>();
  const f = await outboundConversationFixture({ prepare: async (context, create) => {
    entered.resolve(context); await release.promise;
    input = new SyntheticPrivateInput(context); ready.resolve(input); return { create, privateKeypadInput: input };
  } });
  const { server, wire } = await open(f); t.after(server.close); t.after(() => release.resolve());
  const context = await entered.promise;
  if (cause === "disconnect") wire.socket.close();
  assert.equal(await wire.outcome, "closed"); assert.equal(context.signal.aborted, true);
  release.resolve();
  input = await ready.promise;
  await input.stopped.promise;
  assert.equal(input.stops, 1); assert.equal(input.starts, 0); assert.equal(f.opened, 0); assert.deepEqual(f.spoken, []);
});

test("one selected prepared factory keeps two real outgoing call/session inputs separate", { timeout: 12000 }, async t => {
  const inputs: SyntheticPrivateInput[] = [];
  const f = await outboundConversationFixture({ prepare: async (context) => {
    const input = new SyntheticPrivateInput(context); inputs.push(input);
    return { privateKeypadInput: input, create(receipt, sessionId, playback) {
      assert.equal(receipt.callId, callIdFor(context.call.key)); assert.equal(sessionId, context.sessionId);
      const reception = new TextReception(context.ledger, withApprovedSyntheticVoice(new MemoryPolicyStore()), new ReferenceClinicHost([], []));
      return new VoiceSession(receipt.callId, sessionId, receipt.scope, context.ledger, reception, playback, async () => ok({ kind: "clarify" }));
    } };
  } });
  const first = await open(f); t.after(first.server.close); assert.equal(await first.wire.outcome, "ready");
  const peer = await twilioOutboundIngressFixture({ profileRef: f.runtime.binding().profileRef, callSid: `CA${randomUUID().replaceAll("-", "")}`,
    streamSid: `MZ${randomUUID().replaceAll("-", "")}`, conversation: () => f.conversation });
  const server = await peer.listen(); t.after(server.close); const response = await server.post(), second = await server.open(await response.text());
  assert.equal(await second.outcome, "ready"); assert.equal(inputs.length, 2);
  assert.notEqual(inputs[0]!.context.sessionId, inputs[1]!.context.sessionId);
  assert.notDeepEqual(inputs[0]!.context.call.key, inputs[1]!.context.call.key);
  assert.notEqual(inputs[0]!.context.ledger, inputs[1]!.context.ledger);
  const firstClosed = once(first.wire.socket, "close"); first.wire.socket.close(); await firstClosed; await inputs[0]!.stopped.promise;
  assert.equal(inputs[0]!.stops, 1); assert.equal(inputs[1]!.stops, 0); assert.equal(inputs[1]!.starts, 1);
});
