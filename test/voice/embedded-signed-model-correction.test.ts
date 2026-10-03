import { syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import twilio from "twilio";
import WebSocket from "ws";
import { MemoryLedger } from "../../src/core/ledger.ts";
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
const accountSid = `AC${"4".repeat(32)}`;
const authToken = "synthetic-model-correction-token";
const webhookUrl = "https://buyer.example.test/twilio/inbound";
const streamUrl = "wss://buyer.example.test/twilio/media/";
const dialedNumber = "+6125550199";
const scope = { tenantId: "buyer-model", clinicId: "clinic", locationId: "main" };
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

test("E2E-240 signed embedded model answer completes and an in-flight correction suppresses its predecessor",
  { timeout: 60_000 }, async () => {
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
  const host = new ReferenceClinicHost([], []);
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: accountSid,
    dialedNumber, routeVersion: "model-route-v1" }]);
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { [dialedNumber]: "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x35), now: () => new Date(now) });
  const spoken = new Map<string, string[]>();
  let modelRequests = 0;
  let modelAborts = 0;
  const model = new ModelWork(new ModelIngress({ propose(_input, signal) {
    modelRequests += 1;
    if (modelRequests === 1) return Promise.resolve({ schemaVersion: 1, kind: "answer",
      sourceRefs: ["hours"], proposedText: oldAnswer });
    return new Promise(resolve => {
      signal.addEventListener("abort", () => {
        modelAborts += 1;
        setTimeout(() => resolve({ schemaVersion: 1, kind: "answer",
          sourceRefs: ["hours"], proposedText: oldAnswer }), 100);
      }, { once: true });
    });
  } }), "model-correction-v1");
  const server = createTwilioIngressServer({ ingress, async createCall(stream, send, close) {
    const callSid = stream.event.key.providerCallRef;
    const sessionId = `session-${callSid}`;
    let utterance = 0;
    const call = createEmbeddedTwilioVoiceComposition({ event: stream.event, sessionId,
      streamStartedAt: stream.streamStartedAt, send, closeTransport: close,
      ledger, policy, routing, host, knowledge, model, readiness: async () => ok(true), now: () => now,
      resolveIntent: async turn => ok(turn.text.startsWith("Actually")
        ? { kind: "answer", sourceRefs: ["parking"], proposedText: correctedAnswer }
        : { kind: "model" }),
      ...syntheticSpeech({ synthesis: { async *stream(text) {
        spoken.set(callSid, [...(spoken.get(callSid) ?? []), text]);
        yield pcm(text === oldAnswer ? 2_000 : text === correctedAnswer ? 3_000 : 1_000);
      } }, transcription: { async accept() { return ok([]); }, async flush(generation) {
        utterance += 1;
        return ok([{ kind: "segmentFinal", sessionId, generation, utteranceId: `model-${utterance}`,
          text: utterance === 1 ? "What are your hours?" : "Actually, where can I park?", quality: "clear" }]);
      } } }),

      mediaOptions: { silenceMs: 100 },
    });
    return { receive: raw => call.receive(raw), disconnect: () => call.disconnect() };
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const sockets: WebSocket[] = [];

  async function signedCall(index: number): Promise<Readonly<{
    callSid: string; socket: WebSocket; streamSid: string; sent: Outbound[];
    sendFrame: (voiced: boolean) => void; sendTurn: () => void; markGreeting: () => void;
  }>> {
    const callSid = `CA${String(index).repeat(32)}`;
    const streamSid = `MZ${String(index).repeat(32)}`;
    const form = { AccountSid: accountSid, CallSid: callSid, To: dialedNumber, From: "+6145550101" };
    const response = await fetch(`http://127.0.0.1:${port}/twilio/inbound`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
    }, body: new URLSearchParams(form).toString() });
    assert.equal(response.status, 200);
    const binding = (await response.text()).match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/twilio/media/`, { headers: {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
    } });
    sockets.push(socket);
    await once(socket, "open");
    const sent: Outbound[] = [];
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
    const sendFrame = (voiced: boolean) => socket.send(JSON.stringify({ event: "media",
      sequenceNumber: String(sequence++), streamSid,
      media: { track: "inbound", chunk: String(++chunk), timestamp: String((chunk - 1) * 20),
        payload: Buffer.alloc(160, voiced ? 0x9f : 0xff).toString("base64") } }));
    return {
      callSid, socket, streamSid, sent,
      markGreeting: () => socket.send(JSON.stringify({ event: "mark", sequenceNumber: String(sequence++),
        streamSid, mark: { name: sent[1]!.mark!.name } })),
      sendFrame,
      sendTurn: () => {
        for (let frame = 0; frame < 7; frame += 1) sendFrame(frame < 2);
      },
    };
  }

  try {
    const ordinary = await signedCall(5);
    ordinary.markGreeting();
    ordinary.sendTurn();
    await until(() => ordinary.sent.length >= 4, "model-approved knowledge answer");
    assert.equal(spoken.get(ordinary.callSid)?.at(-1), oldAnswer);
    assert.deepEqual(ordinary.sent.map(item => item.event), ["media", "mark", "media", "mark"]);
    const ordinaryState = await ledger.read(callIdFor({ accountRef: accountSid,
      providerCallRef: ordinary.callSid }), scope);
    assert.ok(ordinaryState.ok);
    assert.equal(ordinaryState.value.knowledgeAnswers.length, 1);
    assert.equal(host.bookings(scope).length, 0);
    ordinary.socket.terminate();
    await once(ordinary.socket, "close");

    const corrected = await signedCall(6);
    corrected.markGreeting();
    corrected.sendTurn();
    await until(() => modelRequests === 2, "stalled model request");
    assert.equal(corrected.sent.length, 2, "the old model has not produced audio");
    corrected.sendFrame(true);
    corrected.sendFrame(false);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(modelAborts, 0, "an isolated voiced frame cannot cancel model work");
    corrected.sendTurn();
    await until(() => modelAborts === 1 && corrected.sent.length >= 4, "corrected model response");
    assert.deepEqual(corrected.sent.map(item => item.event), ["media", "mark", "media", "mark"]);
    assert.equal(spoken.get(corrected.callSid)?.at(-1), correctedAnswer);
    assert.notEqual(corrected.sent[0]!.media!.payload, corrected.sent[2]!.media!.payload);
    const state = await ledger.read(callIdFor({ accountRef: accountSid,
      providerCallRef: corrected.callSid }), scope);
    assert.ok(state.ok);
    const oldEffect = Object.values(state.value.effects).find(effect => effect.kind === "model" &&
      effect.status === "canceled");
    assert.ok(oldEffect && oldEffect.kind === "model");
    assert.equal(model.input(oldEffect.taskRef), undefined, "the canceled caller input must be forgotten");
    assert.equal(state.value.knowledgeAnswers.length, 1);
    assert.equal(state.value.knowledgeAnswers[0]?.sourceRef, "parking");
    assert.equal(JSON.stringify(state.value).includes("What are your hours?"), false);
    assert.equal(JSON.stringify(state.value).includes("Actually, where can I park?"), false);
    assert.equal(host.bookings(scope).length, 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(spoken.get(corrected.callSid), [
      "Hello. How can I help you?", correctedAnswer,
    ]);
  } finally {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
        await once(socket, "close");
      }
    }
    server.close();
    await once(server, "close");
  }
});
