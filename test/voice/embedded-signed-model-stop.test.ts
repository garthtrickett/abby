import { syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import twilio from "twilio";
import WebSocket from "ws";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { KnowledgeHost, ModelKnowledgeContextHost } from "../../src/core/host.ts";
import { ok } from "../../src/core/model.ts";
import { ModelIngress } from "../../src/model/proposal.ts";
import { ModelWork } from "../../src/model/work.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedTwilioVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryKnowledgeCatalogue } from "../../src/reference/knowledge-catalogue.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";

const now = "2026-09-29T10:00:00.000Z";
const scope = { tenantId: "buyer-stop", clinicId: "clinic", locationId: "main" };
const accountSid = `AC${"4".repeat(32)}`;
const callSid = `CA${"7".repeat(32)}`;
const streamSid = `MZ${"7".repeat(32)}`;
const dialedNumber = "+6125550199";
const authToken = "synthetic-model-stop-token";
const webhookUrl = "https://buyer.example.test/twilio/inbound";
const streamUrl = "wss://buyer.example.test/twilio/media/";
const oldAnswer = "We close at five.";
const correctedAnswer = "Parking is behind the clinic.";
type Outbound = Readonly<{ event: string; media?: { payload: string }; mark?: { name: string } }>;

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), `${label} timed out`);
}

function pcm(tone: number): Uint8Array {
  const bytes = new Uint8Array(640);
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, tone, true);
  return bytes;
}

type Harness = Readonly<{
  ledger: MemoryLedger;
  model: ModelWork;
  host: ReferenceClinicHost;
  socket: WebSocket;
  sent: Outbound[];
  spoken: string[];
  observed: Readonly<{ modelStarts: number; modelAborts: number; knowledgeStarts: number;
    knowledgeAborts: number; ended: boolean }>;
  sendTurn(): void;
}>;

async function signedModelCall(mode: "modelHeld" | "knowledgeHeld", run: (call: Harness) => Promise<void>): Promise<void> {
  const ledger = new MemoryLedger();
  const policy = withApprovedSyntheticVoice(new MemoryPolicyStore("execute", () => now, async () => ok(true)));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  const knowledge = new MemoryKnowledgeCatalogue();
  for (const [sourceRef, text] of [["hours", oldAnswer], ["parking", correctedAnswer]]) {
    const draft = await knowledge.saveDraft(scope, sourceRef!, "0", "practice-manager", text!,
      "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "clinic-admin");
    assert.ok(draft.ok);
    assert.ok((await knowledge.approve(scope, sourceRef!, draft.value.version, "clinic-admin")).ok);
  }
  const observed = { modelStarts: 0, modelAborts: 0, knowledgeStarts: 0, knowledgeAborts: 0, ended: false };
  const knowledgePort: KnowledgeHost & ModelKnowledgeContextHost = {
    listModelKnowledge: (candidateScope, at) => knowledge.listModelKnowledge(candidateScope, at),
    readKnowledge: (candidateScope, refs, signal) => {
      const result = knowledge.readKnowledge(candidateScope, refs);
      if (mode !== "knowledgeHeld" || observed.knowledgeStarts > 0) return result;
      observed.knowledgeStarts += 1;
      return new Promise(resolve => {
        signal?.addEventListener("abort", () => {
          observed.knowledgeAborts += 1;
          setTimeout(() => { void result.then(resolve); }, 100);
        }, { once: true });
      });
    },
  };
  const model = new ModelWork(new ModelIngress({ propose(_input, signal) {
    observed.modelStarts += 1;
    if (mode !== "modelHeld") return Promise.resolve({ schemaVersion: 1, kind: "answer",
      sourceRefs: ["hours"], proposedText: oldAnswer });
    return new Promise(resolve => {
      signal.addEventListener("abort", () => {
        observed.modelAborts += 1;
        setTimeout(() => resolve({ schemaVersion: 1, kind: "answer",
          sourceRefs: ["hours"], proposedText: oldAnswer }), 100);
      }, { once: true });
    });
  } }), "model-stop-v1", 10_000);
  const host = new ReferenceClinicHost([], []);
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: accountSid,
    dialedNumber, routeVersion: "model-stop-v1" }]);
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { [dialedNumber]: "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x36), now: () => new Date(now) });
  const sent: Outbound[] = [];
  const spoken: string[] = [];
  const server = createTwilioIngressServer({ ingress, async createCall(stream, send, close) {
    const sessionId = `session-${callSid}`;
    let utterance = 0;
    const call = createEmbeddedTwilioVoiceComposition({ event: stream.event, sessionId,
      streamStartedAt: stream.streamStartedAt, send, closeTransport: close,
      ledger, policy, routing, host, knowledge: knowledgePort, model,
      readiness: async () => ok(true), now: () => now,
      resolveIntent: async turn => ok(turn.text.startsWith("Actually")
        ? { kind: "answer", sourceRefs: ["parking"], proposedText: correctedAnswer }
        : { kind: "model" }),
      ...syntheticSpeech({ synthesis: { async *stream(text) {
        spoken.push(text);
        yield pcm(text === oldAnswer ? 2_000 : text === correctedAnswer ? 3_000 : 1_000);
      } }, transcription: { async accept() { return ok([]); }, async flush(generation) {
        utterance += 1;
        return ok([{ kind: "segmentFinal", sessionId, generation, utteranceId: `stop-${utterance}`,
          text: utterance === 1 ? "What are your hours?" : "Actually, where can I park?", quality: "clear" }]);
      } } }),

      mediaOptions: { silenceMs: 100 },
    });
    return { receive: raw => call.receive(raw), disconnect: async () => {
      await call.disconnect();
      observed.ended = true;
    } };
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let socket: WebSocket | undefined;
  try {
    const form = { AccountSid: accountSid, CallSid: callSid, To: dialedNumber, From: "+6145550101" };
    const response = await fetch(`http://127.0.0.1:${address.port}/twilio/inbound`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
    }, body: new URLSearchParams(form).toString() });
    assert.equal(response.status, 200);
    const binding = (await response.text()).match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/twilio/media/`, { headers: {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
    } });
    await once(socket, "open");
    socket.on("message", data => sent.push(JSON.parse(data.toString()) as Outbound));
    let sequence = 1;
    let chunk = 0;
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: String(sequence++), streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    await until(() => sent.length >= 2, "greeting media");
    assert.deepEqual(sent.map(item => item.event), ["media", "mark"]);
    socket.send(JSON.stringify({ event: "mark", sequenceNumber: String(sequence++), streamSid,
      mark: { name: sent[1]!.mark!.name } }));
    const sendFrame = (voiced: boolean) => socket!.send(JSON.stringify({ event: "media",
      sequenceNumber: String(sequence++), streamSid,
      media: { track: "inbound", chunk: String(++chunk), timestamp: String((chunk - 1) * 20),
        payload: Buffer.alloc(160, voiced ? 0x9f : 0xff).toString("base64") } }));
    await run({ ledger, model, host, socket, sent, spoken, observed, sendTurn: () => {
      for (let frame = 0; frame < 7; frame += 1) sendFrame(frame < 2);
    } });
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
      await once(socket, "close");
    }
    server.close();
    await once(server, "close");
  }
}

async function endedState(call: Harness) {
  await until(() => call.observed.ended, "call end after hangup");
  const state = await call.ledger.read(callIdFor({ accountRef: accountSid, providerCallRef: callSid }), scope);
  assert.ok(state.ok);
  assert.equal(state.value.lifecycle, "ended");
  assert.equal(state.value.terminal?.reason, "callerDisconnected");
  assert.equal(JSON.stringify(state.value).includes("What are your hours?"), false);
  assert.equal(call.host.bookings(scope).length, 0);
  return state.value;
}

test("E2E-241 signed caller hangup aborts an in-flight model proposal", { timeout: 30_000 }, async () => {
  await signedModelCall("modelHeld", async call => {
    call.sendTurn();
    await until(() => call.observed.modelStarts === 1, "model proposal");
    assert.equal(call.sent.length, 2);
    const hungUpAt = Date.now();
    call.socket.terminate();
    await once(call.socket, "close");
    await until(() => call.observed.modelAborts === 1 && call.observed.ended, "model abort and call end");
    assert.ok(Date.now() - hungUpAt < 5_000, "hangup beats the ten-second model deadline");
    const state = await endedState(call);
    const canceled = Object.values(state.effects).find(effect => effect.kind === "model");
    assert.ok(canceled && canceled.kind === "model");
    assert.equal(canceled.status, "canceled");
    assert.equal(call.model.input(canceled.taskRef), undefined);
    assert.equal(state.knowledgeAnswers.length, 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(call.spoken, ["Hello. How can I help you?"]);
  });
});

test("E2E-242 signed caller hangup aborts a held approved-knowledge read", { timeout: 30_000 }, async () => {
  await signedModelCall("knowledgeHeld", async call => {
    call.sendTurn();
    await until(() => call.observed.knowledgeStarts === 1, "approved-knowledge read");
    assert.equal(call.sent.length, 2);
    const hungUpAt = Date.now();
    call.socket.terminate();
    await once(call.socket, "close");
    await until(() => call.observed.knowledgeAborts === 1 && call.observed.ended, "knowledge abort and call end");
    assert.ok(Date.now() - hungUpAt < 5_000, "hangup beats the knowledge deadline");
    const state = await endedState(call);
    const canceled = Object.values(state.effects).find(effect => effect.kind === "modelKnowledge");
    assert.ok(canceled && canceled.kind === "modelKnowledge");
    assert.equal(canceled.status, "canceled");
    assert.equal(call.model.input(canceled.taskRef), undefined);
    assert.equal(state.knowledgeAnswers.length, 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(call.spoken, ["Hello. How can I help you?"]);
  });
});

test("E2E-243 signed correction aborts a held knowledge read and speaks only the corrected source",
  { timeout: 30_000 }, async () => {
    await signedModelCall("knowledgeHeld", async call => {
      call.sendTurn();
      await until(() => call.observed.knowledgeStarts === 1, "old approved-knowledge read");
      assert.equal(call.sent.length, 2);
      call.sendTurn();
      await until(() => call.observed.knowledgeAborts === 1 && call.sent.length >= 4,
        "corrected approved-knowledge speech");
      assert.deepEqual(call.sent.map(item => item.event), ["media", "mark", "media", "mark"]);
      assert.equal(call.spoken.at(-1), correctedAnswer);
      const state = await call.ledger.read(callIdFor({ accountRef: accountSid, providerCallRef: callSid }), scope);
      assert.ok(state.ok);
      assert.equal(state.value.knowledgeAnswers.length, 1);
      assert.equal(state.value.knowledgeAnswers[0]?.sourceRef, "parking");
      const canceled = Object.values(state.value.effects).find(effect =>
        effect.kind === "modelKnowledge" && effect.status === "canceled");
      assert.ok(canceled && canceled.kind === "modelKnowledge");
      assert.equal(call.model.input(canceled.taskRef), undefined);
      assert.equal(JSON.stringify(state.value).includes("What are your hours?"), false);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.deepEqual(call.spoken, ["Hello. How can I help you?", correctedAnswer]);
      assert.equal(call.host.bookings(scope).length, 0);
    });
  });
