import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import twilio from "twilio";
import WebSocket from "ws";
import type { Kysely } from "kysely";
import type Database from "../../src/storage/generated/Database.ts";
import type { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import { createStandaloneTransientVoiceCall } from "../../src/standalone/transient-voice-composition.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import type { IntentResolver } from "../../src/voice/voice-session.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { approvedSyntheticPolicy, syntheticSpeech } from "./approved-voice.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationCanaries, verificationNow } from "./caller-verification.ts";

export async function voiceUntil(check: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.ok(check(), `${label} timed out`);
}

/** Real HTTP/WS ingress and serving composition; public clinical approvals, mail,
 * Cliniko HTTP, clear-final transcription and speech synthesis are explicitly synthetic. */
export async function clinikoWorkflowVoiceFixture(db: Kysely<Database>, config: ClinikoCallFlowConfig,
  intent: (flow: ClinikoCallFlow) => IntentResolver, options: { lostWrite?: boolean } = {}) {
  const accountSid = `AC${"4".repeat(32)}`, callSid = `CA${randomUUID().replaceAll("-", "")}`, streamSid = `MZ${randomUUID().replaceAll("-", "")}`;
  const webhookUrl = "https://workflow.example.test/twilio/inbound", streamUrl = "wss://workflow.example.test/twilio/media/";
  const authToken = "synthetic-workflow-voice-token", now = config.clock ?? (() => verificationNow), scope = config.receipt.scope;
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
    fallbackNumbers: { [config.inbound.dialedNumber]: "+6125550188" }, bindingKey: Buffer.alloc(32, 0x38), now: () => new Date(now()) });
  const policy = new Proxy(config.policies, { get(target, key) {
    if (key === "read") return async (...args: Parameters<typeof target.read>) => {
      const found = await target.read(...args); return found.ok ? ok(approvedSyntheticPolicy(found.value)) : found;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const sent: { event: string; mark?: { name: string } }[] = [], spoken: string[] = [], transcripts: string[] = [], modelTurns: string[] = [];
  const inputs: string[] = [], privateInputs: string[] = [], privateTranscripts: string[] = [], writes: string[] = [];
  const failures: string[] = [];
  const acknowledged = new Set<string>();
  let ledger: MemoryLedger | undefined, flow: ClinikoCallFlow | undefined, socket: WebSocket | undefined, closed = false;
  let after: Record<string, unknown> | undefined, sequence = 1, chunk = 0, utterance = 0, transcriptionFrames = 0;
  let processedChunk = 0, processedSequence = 0, hostWritesStarted = 0, hostWritesSettled = 0;
  const callId = callIdFor({ accountRef: accountSid, providerCallRef: callSid });
  const base = "https://api.au5.cliniko.com/v1", port = config.fetchPort!;
  const provider: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (after && method === "GET" && url.pathname === "/v1/individual_appointments/91") return Response.json(after);
    if (method === "GET" && url.pathname === "/v1/individual_appointments/91/conflicts") return Response.json({ conflicts: { exist: false } });
    if ((method === "POST" && url.pathname === "/v1/individual_appointments") ||
        (method === "PATCH" && url.pathname.startsWith("/v1/individual_appointments/"))) {
      const state = resultValue(await ledger!.read(callId, scope));
      const action = Object.values(state.actions).find(action => action.status === "dispatched")!; assert.ok(action);
      assert.equal(state.presentations[action.presentationId]?.status, "played");
      assert.ok(Object.values(state.effects).some(effect => effect.kind === "hostWrite" && effect.actionKey === action.key));
      writes.push(`${method} ${url.pathname}`); assert.equal(writes.length, 1);
      const body = JSON.parse(String(init?.body));
      const before = method === "PATCH" ? await (await port(`${base}/individual_appointments/91`, { method: "GET", redirect: "error", ...(init?.signal ? { signal: init.signal } : {}) })).json() : {};
      const starts = body.starts_at ?? before.starts_at;
      after = { ...before, id: "91", notes: body.notes ?? before.notes, starts_at: starts, ends_at: new Date(Date.parse(starts) + 1_800_000).toISOString(), archived_at: null, deleted_at: null,
        cancelled_at: url.pathname.endsWith("/cancel") ? now() : null,
        patient: { links: { self: `${base}/patients/${body.patient_id ?? verificationCanaries[2]}` } },
        business: { links: { self: `${base}/businesses/11` } }, practitioner: { links: { self: `${base}/practitioners/22` } },
        appointment_type: { links: { self: `${base}/appointment_types/33` } } };
      if (options.lostWrite) throw new Error("synthetic lost voice write response");
      if (url.pathname.endsWith("/cancel")) return new Response(null, { status: 204 });
      return Response.json(after, { status: method === "POST" ? 201 : 200 });
    }
    return port(value, init);
  };
  const server = createTwilioIngressServer({ ingress, createCall: async (stream, send, close) => {
    const composed = resultValue(await createStandaloneTransientVoiceCall({ db,
      routingHost: new ReferenceNumberRoutingHost([{ accountRef: accountSid, dialedNumber: config.inbound.dialedNumber, ...scope, routeVersion: "workflow-voice" }]),
      stream, send, closeTransport: close, readiness: async () => ok(true), now, resolveIntent: async () => ok({ kind: "model" }),
      clinicalWorkflow: { policies: policy,
        create(context) { ledger = context.ledger; flow = resultValue(ClinikoCallFlow.create({ ...config, ...context,
          policyVersion: config.policyVersion, fetchPort: provider,
          ...(config.intake ? { intake: { ...config.intake, presentation: context.privatePresentation } } : {}) }));
          const write = flow.write.bind(flow);
          flow.write = async (...args: Parameters<ClinikoCallFlow["write"]>) => {
            hostWritesStarted++;
            try { return await write(...args); } finally { hostWritesSettled++; }
          };
          return flow; },
        intent(owner) { const resolve = intent(owner); return async (turn, signal) => { modelTurns.push(turn.text); return resolve(turn, signal); }; },
        ...(config.intake ? { privateIntakeTranscription: (sessionId: string) => ({ async accept() { return ok([]); }, async flush(generation: number) {
          const text = privateInputs.shift(); assert.ok(text); privateTranscripts.push(text);
          return ok([{ kind: "segmentFinal" as const, sessionId, generation, utteranceId: `private-${privateTranscripts.length}`, text, quality: "clear" as const }]);
        } }) } : {}),
      },
      ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
        transcriptionFactory: sessionId => ({ async accept() { transcriptionFrames++; return ok([]); }, async flush(generation) {
          const text = inputs.shift(); assert.ok(text, "every ordinary final must have a caller-supplied text fixture"); transcripts.push(text);
          return ok([{ kind: "segmentFinal", sessionId, generation, utteranceId: `workflow-${++utterance}`, text, quality: "clear" }]);
        } }) }), mediaOptions: { silenceMs: 100 },
    }));
    return { receive: async raw => { const result = await composed.receive(raw);
      if (!result.ok) failures.push("error" in result ? String((result.error as { kind: string }).kind) : "unknown");
      const decoded = JSON.parse(raw); if (decoded.event === "media") processedChunk = Number(decoded.media.chunk);
      if (decoded.sequenceNumber) processedSequence = Math.max(processedSequence, Number(decoded.sequenceNumber));
      return result; },
      disconnect: async () => { await composed.disconnect(); closed = true; } };
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const close = async () => {
    try { if (socket && socket.readyState !== WebSocket.CLOSED) { socket.terminate(); await once(socket, "close"); }
      if (flow) await voiceUntil(() => closed, "call owner cleanup"); }
    finally { server.close(); await once(server, "close"); }
  };
  try {
    const form = { AccountSid: accountSid, CallSid: callSid, To: config.inbound.dialedNumber, From: config.inbound.presentedCallerNumber! };
    const endpoint = `http://127.0.0.1:${address.port}/twilio/inbound`, body = new URLSearchParams(form).toString();
    const unsigned = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }); assert.equal(unsigned.status, 403);
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form) }, body }); assert.equal(response.status, 200);
    const binding = (await response.text()).match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1]; assert.ok(binding);
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/twilio/media/`, { headers: { "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}) } });
    await once(socket, "open"); socket.on("message", data => sent.push(JSON.parse(data.toString())));
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: String(sequence++), streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: { abbyBinding: binding } } }));
    await voiceUntil(() => sent.some(item => item.event === "mark"), "greeting mark");
    const sendEvent = (event: Record<string, unknown>) => socket!.send(JSON.stringify({ ...event, streamSid, sequenceNumber: String(sequence++) }));
    const media = (voiced: boolean) => sendEvent({ event: "media", media: { track: "inbound", chunk: String(++chunk), timestamp: String((chunk - 1) * 20),
      payload: Buffer.alloc(160, voiced ? 0x9f : 0xff).toString("base64") } });
    const mark = async () => {
      await voiceUntil(() => sent.some(item => item.event === "mark" && item.mark && !acknowledged.has(item.mark.name)), "fresh queued playback marker");
      const marker = sent.filter(item => item.event === "mark" && item.mark && !acknowledged.has(item.mark.name)).at(-1)?.mark; assert.ok(marker);
      acknowledged.add(marker.name);
      const markSequence = sequence;
      sendEvent({ event: "mark", mark: { name: marker.name } });
      await voiceUntil(() => processedSequence >= markSequence, "processed playback receipt");
    };
    await mark();
    return { callId, sent, spoken, transcripts, privateTranscripts, modelTurns, writes, close, mark, media, sendEvent,
      get flow() { assert.ok(flow); return flow; }, get transcriptionFrames() { return transcriptionFrames; },
      state: async () => resultValue(await ledger!.read(callId, scope)),
      async privateField(text: string) {
        const marks = sent.filter(item => item.event === "mark").length; privateInputs.push(text);
        for (let frame = 0; frame < 7; frame++) media(frame < 2);
        await voiceUntil(() => sent.filter(item => item.event === "mark").length > marks || failures.length > 0, "next private field prompt");
        assert.deepEqual(failures, []);
      },
      async privateDigit(digit: string) {
        const marks = sent.filter(item => item.event === "mark").length;
        sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
        await voiceUntil(() => sent.filter(item => item.event === "mark").length > marks || failures.length > 0, "private registration prompt");
        assert.deepEqual(failures, []);
      },
      async turn(text: string, options: { expectedFailure?: "confirmationMissing"; interrupt?: boolean } = {}) {
        const marks = sent.filter(item => item.event === "mark").length, clears = sent.filter(item => item.event === "clear").length;
        const interruptedMark = sent.filter(item => item.event === "mark").at(-1)?.mark;
        const pending = text === "Yes" && !options.expectedFailure
          ? Object.values(resultValue(await ledger!.read(callId, scope)).actions).find(action => action.status === "awaitingConfirmation") : undefined;
        const beforeWrites = hostWritesStarted;
        inputs.push(text); media(true); media(true);
        if (options.interrupt) {
          assert.ok(interruptedMark); await voiceUntil(() => sent.filter(item => item.event === "clear").length > clears, "interrupted speech clear");
          const fenceMark = sent.filter(item => item.event === "mark").at(-1)?.mark; assert.ok(fenceMark); assert.notEqual(fenceMark.name, interruptedMark.name);
          sendEvent({ event: "mark", mark: { name: interruptedMark.name } });
          sendEvent({ event: "mark", mark: { name: fenceMark.name } });
          acknowledged.add(interruptedMark.name); acknowledged.add(fenceMark.name);
        }
        for (let frame = 0; frame < 5; frame++) media(false);
        const finalChunk = chunk;
        try {
          if (pending) {
            // Observe the actual host boundary without repeatedly cloning the SAM
            // state. Confirmation validation and playback retain their own waits.
            await voiceUntil(() => hostWritesStarted > beforeWrites || processedChunk >= finalChunk || failures.length > 0,
              "confirmed caller turn dispatch");
            if (hostWritesStarted > beforeWrites) {
              // EffectWorker starts its unchanged 15-second host deadline before
              // invoking write; start this observation only after that invocation.
              await voiceUntil(() => hostWritesSettled > beforeWrites || failures.length > 0, "host write settlement", 15_000);
            }
          }
          await voiceUntil(() => sent.filter(item => item.event === "mark").length >= marks + (options.interrupt ? 2 : 1) || failures.length > 0, "caller turn speech");
        } catch (error) {
          const state = resultValue(await ledger!.read(callId, scope));
          throw new Error(`caller turn delivery stalled: ${JSON.stringify({ closed, workflowClosed: flow?.closed,
            workflow: flow?.workflow, lifecycle: state.lifecycle, queuedInputs: inputs.length, processedChunk, chunk,
            modelTurns: modelTurns.length, transcriptionFrames, writes: writes.length, hostWritesStarted, hostWritesSettled, failures, stageFailure: error instanceof Error ? error.message : "unknown",
            actions: Object.values(state.actions).map(action => action.status),
            presentations: Object.values(state.presentations).map(presentation => presentation.status),
            effects: Object.values(state.effects).map(effect => ({ kind: effect.kind, status: effect.status })) })}`, { cause: error });
        }
        assert.deepEqual(failures, options.expectedFailure ? [options.expectedFailure] : [], `wire failure after ${modelTurns.length} model turns and ${transcriptionFrames} transcribed frames`);
        await voiceUntil(() => processedChunk >= finalChunk, "completed caller media turn"); },
      async verify(code: string) { for (const digit of `${code}#`) sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
        await voiceUntil(() => !flow!.verificationRequired, "private code verification");
        for (let frame = 0; frame < 25; frame++) media(false);
        const resumeChunk = chunk; await voiceUntil(() => processedChunk >= resumeChunk, "fresh private-audio quiet interval"); },
    };
  } catch (error) { await close(); throw error; }
}
