import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import twilio from "twilio";
import WebSocket from "ws";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedTwilioVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryKnowledgeCatalogue } from "../../src/reference/knowledge-catalogue.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";

test("E2E-004 signed embedded voice rechecks an approved answer after revocation", { timeout: 15_000 }, async () => {
  const accountSid = `AC${"4".repeat(32)}`;
  const authToken = "synthetic-knowledge-token";
  const webhookUrl = "https://buyer.example.test/twilio/inbound";
  const streamUrl = "wss://buyer.example.test/twilio/media/";
  const dialedNumber = "+6125550199";
  const now = "2026-09-29T10:00:00.000Z";
  const scope = { tenantId: "buyer", clinicId: "clinic", locationId: "main" };
  const approvedText = "Parking is behind the clinic.";
  const unavailableText = "I can't verify that information right now.";
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore("execute", () => now, async () => ok(true));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  const knowledge = new MemoryKnowledgeCatalogue();
  const draft = await knowledge.saveDraft(scope, "parking", "0", "practice-manager", approvedText,
    "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "clinic-admin");
  assert.ok(draft.ok);
  const approved = await knowledge.approve(scope, "parking", draft.value.version, "clinic-admin");
  assert.ok(approved.ok);
  const approvedVersion = approved.value.version;
  const host = new ReferenceClinicHost([], []);
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: accountSid,
    dialedNumber, routeVersion: "buyer-route-v1" }]);
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { [dialedNumber]: "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x36), now: () => new Date(now) });
  const spoken = new Map<string, string[]>();
  const played = new EventEmitter();
  const server = createTwilioIngressServer({ ingress, async createCall(stream, send, close) {
    const callSid = stream.event.key.providerCallRef;
    const sessionId = `session-${callSid}`;
    let playedCount = 0;
    let utterance = 0;
    const call = createEmbeddedTwilioVoiceComposition({ event: stream.event, sessionId,
      streamStartedAt: stream.streamStartedAt, send, closeTransport: close, ledger, policy, routing,
      host, knowledge, readiness: async () => ok(true), now: () => now,
      resolveIntent: async () => ok({ kind: "answer", sourceRefs: ["parking"], proposedText: approvedText }),
      transcription: { async accept() { return ok([]); }, async flush(generation) {
        utterance += 1;
        return ok([{ kind: "segmentFinal", sessionId, generation,
          utteranceId: `parking-${utterance}`, text: "Where is parking?", quality: "clear" }]);
      } },
      synthesis: { async *stream(text) {
        spoken.set(callSid, [...(spoken.get(callSid) ?? []), text]);
        yield new Uint8Array(640);
      } },
      mediaOptions: { silenceMs: 100 },
    });
    return { async receive(raw: string) {
      const result = await call.receive(raw);
      if (result.ok && result.value.kind === "played") {
        playedCount += 1;
        played.emit(`${callSid}:${playedCount}`);
      }
      return result;
    }, disconnect: () => call.disconnect() };
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  async function signedCall(index: number, answers: readonly string[]) {
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
    await once(socket, "open");
    const sent: Record<string, unknown>[] = [];
    const waiters: Array<{ count: number; resolve: () => void }> = [];
    socket.on("message", data => {
      sent.push(JSON.parse(data.toString()) as Record<string, unknown>);
      for (const waiter of waiters) if (sent.length >= waiter.count) waiter.resolve();
    });
    function waitFor(count: number): Promise<void> {
      if (sent.length >= count) return Promise.resolve();
      return new Promise(resolve => { waiters.push({ count, resolve }); });
    }
    let sequence = 1;
    let mediaChunk = 0;
    function acknowledge(markIndex: number, playedIndex: number): Promise<unknown[]> {
      const handled = once(played, `${callSid}:${playedIndex}`);
      socket.send(JSON.stringify({ event: "mark", sequenceNumber: String(sequence++), streamSid,
        mark: { name: (sent[markIndex]?.mark as { name: string }).name } }));
      return handled;
    }
    try {
      socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      socket.send(JSON.stringify({ event: "start", sequenceNumber: String(sequence++), streamSid,
        start: { accountSid, callSid, streamSid, tracks: ["inbound"],
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          customParameters: { abbyBinding: binding } } }));
      await waitFor(2);
      assert.deepEqual(sent.map(message => message.event), ["media", "mark"]);
      await acknowledge(1, 1);
      for (let turn = 0; turn < answers.length; turn += 1) {
        const count = sent.length + 2;
        for (let frame = 0; frame < 7; frame += 1) {
          socket.send(JSON.stringify({ event: "media", sequenceNumber: String(sequence++), streamSid,
            media: { track: "inbound", chunk: String(++mediaChunk),
              timestamp: String((mediaChunk - 1) * 20),
              payload: Buffer.alloc(160, frame < 2 ? 0x9f : 0xff).toString("base64") } }));
        }
        await waitFor(count);
        assert.deepEqual(sent.slice(-2).map(message => message.event), ["media", "mark"]);
        await acknowledge(sent.length - 1, turn + 2);
        assert.equal(spoken.get(callSid)?.at(-1), answers[turn]);
        const state = await ledger.read(callIdFor({ accountRef: accountSid, providerCallRef: callSid }), scope);
        assert.ok(state.ok);
        assert.equal(Object.keys(state.value.actions).length, 0);
        if (turn === 0 && answers.length > 1) {
          assert.deepEqual(state.value.policy.knowledgeSnapshot, [{ sourceRef: "parking", version: "2" }]);
          assert.equal(state.value.knowledgeAnswers.length, 1);
          const revoked = await knowledge.revoke(scope, "parking", approvedVersion, "clinic-admin");
          assert.ok(revoked.ok);
        } else if (answers.length === 1) {
          assert.deepEqual(state.value.policy.knowledgeSnapshot, []);
          assert.equal(state.value.knowledgeAnswers.length, 0);
        } else {
          assert.equal(state.value.knowledgeAnswers.length, 1);
        }
      }
    } finally {
      socket.terminate();
      await once(socket, "close");
    }
  }

  try {
    await signedCall(5, [approvedText, unavailableText]);
    await signedCall(6, [unavailableText]);
    assert.equal(host.bookings(scope).length, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});
