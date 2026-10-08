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
import { ClinikoCallFlow, clinikoStaffPreparationDeadlineMs } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import { createStandaloneTransientVoiceCall } from "../../src/standalone/transient-voice-composition.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import type { IntentResolver } from "../../src/voice/voice-session.ts";
import type { TranscriptEvent } from "../../src/voice/turn-assembler.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { approvedSyntheticPolicy, syntheticSpeech } from "./approved-voice.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationCanaries, verificationNow } from "./caller-verification.ts";
import { bookingMenuDeadlineMs } from "../../src/reference/booking-menu-turns.ts";
import { reschedulingMenuDeadlineMs } from "../../src/reference/rescheduling-menu-turns.ts";
import { appointmentProposalEvidenceDeadlineMs } from "../../src/reference/text-reception.ts";

export async function voiceUntil(check: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.ok(check(), `${label} timed out`);
}

/** Real HTTP/WS ingress and serving composition; public clinical approvals, mail,
 * Cliniko HTTP, clear-final transcription and speech synthesis are explicitly synthetic. */
export async function clinikoWorkflowVoiceFixture(db: Kysely<Database>, config: ClinikoCallFlowConfig,
  intent: (flow: ClinikoCallFlow) => IntentResolver, options: { lostWrite?: boolean;
    beforeWriteResponse?: () => Promise<void>;
    transcriptFinal?: (event: Extract<TranscriptEvent, { kind: "segmentFinal" }>) => readonly TranscriptEvent[] } = {}) {
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
  // Synthetic fixture memory only: inspect the actual provider mutation body,
  // separately from public speech and the SAM proposal being exercised.
  const writeRequests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const failures: string[] = [];
  const acknowledged = new Set<string>();
  // Fixed stage names and timings only; diagnostics never retain caller text,
  // provider paths, patient refs or verification material.
  const stages: { name: string; started: number; settled?: number; deadlineMs?: number; signal?: AbortSignal }[] = [];
  const observe = <Args extends unknown[], Value>(name: string, run: (...args: Args) => Promise<Value>, deadlineMs?: number,
    signalFor?: (...args: Args) => AbortSignal | undefined) =>
    async (...args: Args): Promise<Value> => {
      const signal = signalFor?.(...args);
      const stage: typeof stages[number] = { name, started: performance.now(), ...(deadlineMs === undefined ? {} : { deadlineMs }),
        ...(signal ? { signal } : {}) };
      if (stages.length >= 64) stages.shift();
      stages.push(stage);
      try { return await run(...args); } finally { stage.settled = performance.now(); }
    };
  let ledger: MemoryLedger | undefined, flow: ClinikoCallFlow | undefined, socket: WebSocket | undefined, closed = false;
  let disposedState: ReturnType<MemoryLedger["read"]> | undefined, closeCode: number | undefined;
  let after: Record<string, unknown> | undefined, sequence = 1, chunk = 0, utterance = 0, transcriptionFrames = 0;
  let processedChunk = 0, processedSequence = 0, hostWritesStarted = 0, hostWritesSettled = 0;
  let staffPreparationsStarted = 0, staffPreparationsSettled = 0, staffWritesStarted = 0, staffWritesSettled = 0;
  const callId = callIdFor({ accountRef: accountSid, providerCallRef: callSid });
  const base = "https://api.au5.cliniko.com/v1", port = config.fetchPort!;
  const provider: typeof fetch = observe("providerRequest", async (value: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (after && method === "GET" && url.pathname === `/v1/individual_appointments/${after.id}`) return Response.json(after);
    if (method === "GET" && url.pathname === "/v1/individual_appointments/91/conflicts") return Response.json({ conflicts: { exist: false } });
    if ((method === "POST" && url.pathname === "/v1/individual_appointments") ||
        (method === "PATCH" && url.pathname.startsWith("/v1/individual_appointments/"))) {
      const state = resultValue(await ledger!.read(callId, scope));
      const action = Object.values(state.actions).find(action => action.status === "dispatched")!; assert.ok(action);
      assert.equal(state.presentations[action.presentationId]?.status, "played");
      assert.ok(Object.values(state.effects).some(effect => effect.kind === "hostWrite" && effect.actionKey === action.key));
      writes.push(`${method} ${url.pathname}`); assert.equal(writes.length, 1);
      const body = JSON.parse(String(init?.body));
      writeRequests.push({ method, path: url.pathname, body: structuredClone(body) });
      const appointmentId = method === "PATCH" ? url.pathname.split("/")[3]! : "91";
      const before = method === "PATCH" ? await (await port(`${base}/individual_appointments/${appointmentId}`, { method: "GET", redirect: "error", ...(init?.signal ? { signal: init.signal } : {}) })).json() : {};
      const starts = body.starts_at ?? before.starts_at;
      after = { ...before, id: appointmentId, notes: body.notes ?? before.notes, starts_at: starts, ends_at: new Date(Date.parse(starts) + 1_800_000).toISOString(), archived_at: null, deleted_at: null,
        cancelled_at: url.pathname.endsWith("/cancel") ? now() : null,
        patient: { links: { self: `${base}/patients/${body.patient_id ?? verificationCanaries[2]}` } },
        business: { links: { self: `${base}/businesses/11` } }, practitioner: { links: { self: `${base}/practitioners/${body.practitioner_id ?? "22"}` } },
        appointment_type: { links: { self: `${base}/appointment_types/33` } } };
      if (options.beforeWriteResponse) await options.beforeWriteResponse();
      if (options.lostWrite) throw new Error("synthetic lost voice write response");
      if (url.pathname.endsWith("/cancel")) return new Response(null, { status: 204 });
      return Response.json(after, { status: method === "POST" ? 201 : 200 });
    }
    return port(value, init);
  });
  const server = createTwilioIngressServer({ ingress, createCall: async (stream, send, close) => {
    const composed = resultValue(await createStandaloneTransientVoiceCall({ db,
      routingHost: new ReferenceNumberRoutingHost([{ accountRef: accountSid, dialedNumber: config.inbound.dialedNumber, ...scope, routeVersion: "workflow-voice" }]),
      stream, send, closeTransport: close, readiness: async () => ok(true), now, resolveIntent: async () => ok({ kind: "model" }),
      clinicalWorkflow: { policies: policy,
        ...(config.publicKnowledge ? { publicKnowledge: config.publicKnowledge } : {}),
        create(context) { ledger = context.ledger;
          // Test-only observation before actual transient disposal; nothing is
          // persisted and the production ledger still releases every call.
          const callLedger = ledger, dispose = callLedger.dispose.bind(callLedger);
          callLedger.dispose = () => { disposedState ??= callLedger.read(callId, scope); dispose(); };
          flow = resultValue(ClinikoCallFlow.create({ ...config, ...context,
          policyVersion: config.policyVersion, fetchPort: provider,
          ...(config.intake ? { intake: { ...config.intake, presentation: context.privatePresentation } } : {}) }));
          flow.readBookingMenu = observe("bookingMenuRead", flow.readBookingMenu.bind(flow), bookingMenuDeadlineMs, query => query.signal);
          flow.selectBookingMenu = observe("bookingMenuSelect", flow.selectBookingMenu.bind(flow), bookingMenuDeadlineMs, query => query.signal);
          flow.readReschedulingMenu = observe("reschedulingMenuRead", flow.readReschedulingMenu.bind(flow), reschedulingMenuDeadlineMs, query => query.signal);
          flow.selectReschedulingMenu = observe("reschedulingMenuSelect", flow.selectReschedulingMenu.bind(flow), reschedulingMenuDeadlineMs, query => query.signal);
          flow.resolveBooking = observe("bookingEvidence", flow.resolveBooking.bind(flow), appointmentProposalEvidenceDeadlineMs,
            (_scope, _verificationRef, _offerRef, _now, signal) => signal);
          flow.resolveAppointmentChange = observe("appointmentChangeEvidence", flow.resolveAppointmentChange.bind(flow), appointmentProposalEvidenceDeadlineMs,
            (_query, signal) => signal);
          flow.correctionIntent = observe("menuCorrection", flow.correctionIntent.bind(flow));
          const write = flow.write.bind(flow);
          flow.write = async (...args: Parameters<ClinikoCallFlow["write"]>) => {
            hostWritesStarted++;
            try { return await write(...args); } finally { hostWritesSettled++; }
          };
          const prepareStaff = flow.prepareStaffRequest.bind(flow), openStaff = flow.openTask.bind(flow);
          flow.prepareStaffRequest = async (...args: Parameters<ClinikoCallFlow["prepareStaffRequest"]>) => {
            staffPreparationsStarted++;
            try { return await prepareStaff(...args); } finally { staffPreparationsSettled++; }
          };
          flow.openTask = async (...args: Parameters<ClinikoCallFlow["openTask"]>) => {
            staffWritesStarted++;
            try { return await openStaff(...args); } finally { staffWritesSettled++; }
          };
          return flow; },
        intent(owner) { const resolve = intent(owner); return observe("intentResolution", async (turn, signal) => { modelTurns.push(turn.text); return resolve(turn, signal); }); },
        ...(config.intake ? { privateIntakeTranscription: (sessionId: string) => ({ async accept() { return ok([]); }, async flush(generation: number) {
          const text = privateInputs.shift(); assert.ok(text); privateTranscripts.push(text);
          return ok([{ kind: "segmentFinal" as const, sessionId, generation, utteranceId: `private-${privateTranscripts.length}`, text, quality: "clear" as const }]);
        } }) } : {}),
      },
      ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
        transcriptionFactory: sessionId => ({ async accept() { transcriptionFrames++; return ok([]); }, async flush(generation) {
          const text = inputs.shift(); assert.ok(text, "every ordinary final must have a caller-supplied text fixture"); transcripts.push(text);
          const event = { kind: "segmentFinal" as const, sessionId, generation, utteranceId: `workflow-${++utterance}`, text, quality: "clear" as const };
          return ok(options.transcriptFinal ? options.transcriptFinal(event) : [event]);
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
    socket.on("close", code => { closeCode = code; });
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: String(sequence++), streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: { abbyBinding: binding } } }));
    await voiceUntil(() => sent.some(item => item.event === "mark"), "greeting mark");
    const sendEvent = (event: Record<string, unknown>) => socket!.send(JSON.stringify({ ...event, streamSid: event.streamSid ?? streamSid, sequenceNumber: String(sequence++) }));
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
    return { callId, sent, spoken, transcripts, privateTranscripts, modelTurns, writes, writeRequests, close, mark, media, sendEvent,
      get flow() { assert.ok(flow); return flow; }, get transcriptionFrames() { return transcriptionFrames; },
      get closed() { return closed; }, get closeCode() { return closeCode; },
      state: async () => resultValue(await (disposedState ?? ledger!.read(callId, scope))),
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
      async turn(text: string, options: { expectedFailure?: "confirmationMissing" | "staleGeneration" | "automatedCallUnavailable"; interrupt?: boolean } = {}) {
        stages.length = 0;
        const marks = sent.filter(item => item.event === "mark").length, clears = sent.filter(item => item.event === "clear").length;
        let replyAfterMarks = marks;
        const pending = text === "Yes" && !options.expectedFailure
          ? Object.values(resultValue(await ledger!.read(callId, scope)).actions).find(action => action.status === "awaitingConfirmation") : undefined;
        const beforeWrites = hostWritesStarted, beforePreparations = staffPreparationsStarted, beforeStaffWrites = staffWritesStarted;
        inputs.push(text); media(true); media(true);
        if (options.interrupt) {
          await voiceUntil(() => sent.filter(item => item.event === "clear").length > clears, "interrupted speech clear");
          const fenceIndex = sent.findIndex((item, index) => item.event === "clear" && sent.slice(0, index + 1).filter(item => item.event === "clear").length > clears);
          const clearedMarks = sent.slice(0, fenceIndex).filter(item => item.event === "mark" && item.mark && !acknowledged.has(item.mark.name));
          const fenceMark = clearedMarks.at(-1)?.mark; assert.ok(fenceMark);
          // Twilio returns only outstanding completion marks and the clear
          // fence. A previously played mark must never be returned twice.
          for (const item of clearedMarks.slice(0, -1)) {
            sendEvent({ event: "mark", mark: { name: item.mark!.name } });
            acknowledged.add(item.mark!.name);
          }
          sendEvent({ event: "mark", mark: { name: fenceMark.name } });
          acknowledged.add(fenceMark.name);
          replyAfterMarks = sent.slice(0, fenceIndex).filter(item => item.event === "mark").length;
        }
        for (let frame = 0; frame < 5; frame++) media(false);
        const finalChunk = chunk;
        try {
          const hasReply = () => sent.filter(item => item.event === "mark").length > replyAfterMarks;
          // Observe invocation before starting each declared business deadline.
          // A generic speech wait is not the preparation or effect contract.
          await voiceUntil(() => hostWritesStarted > beforeWrites || staffPreparationsStarted > beforePreparations ||
            staffWritesStarted > beforeStaffWrites || stages.some(stage => stage.deadlineMs !== undefined) ||
            processedChunk >= finalChunk || hasReply() || failures.length > 0,
            "caller turn dispatch");
          // The core releases its menu signal in finally after selection,
          // evidence resolution and acceptance. Host selection alone is not
          // the end of that budget. Observe the whole operation before the
          // unchanged media-dispatch and speech waits.
          for (const stage of stages.filter(stage => stage.deadlineMs !== undefined)) {
            const remainingMs = Math.max(1, stage.deadlineMs! - Math.round(performance.now() - stage.started));
            await voiceUntil(() => (stage.signal ? stage.signal.aborted : stage.settled !== undefined) ||
              processedChunk >= finalChunk || hasReply() || failures.length > 0,
              `${stage.name} settlement`, remainingMs);
          }
          if (staffPreparationsStarted > beforePreparations) {
            await voiceUntil(() => staffPreparationsSettled > beforePreparations || failures.length > 0,
              "staff preparation settlement", clinikoStaffPreparationDeadlineMs);
            await voiceUntil(() => staffWritesStarted > beforeStaffWrites || processedChunk >= finalChunk || hasReply() || failures.length > 0,
              "prepared staff turn dispatch");
          }
          if (pending && hostWritesStarted > beforeWrites)
            await voiceUntil(() => hostWritesSettled > beforeWrites || failures.length > 0, "host write settlement", flow!.effectDeadlineMs);
          if (staffWritesStarted > beforeStaffWrites)
            await voiceUntil(() => staffWritesSettled > beforeStaffWrites || failures.length > 0, "staff write settlement", flow!.effectDeadlineMs);
          await voiceUntil(() => hasReply() || failures.length > 0, "caller turn speech");
        } catch (error) {
          const state = resultValue(await ledger!.read(callId, scope));
          throw new Error(`caller turn delivery stalled: ${JSON.stringify({ closed, workflowClosed: flow?.closed,
            workflow: flow?.workflow, lifecycle: state.lifecycle, queuedInputs: inputs.length, processedChunk, chunk,
            modelTurns: modelTurns.length, transcriptionFrames, writes: writes.length, hostWritesStarted, hostWritesSettled, staffPreparationsStarted, staffPreparationsSettled, staffWritesStarted, staffWritesSettled, failures, stageFailure: error instanceof Error ? error.message : "unknown",
            actions: Object.values(state.actions).map(action => action.status),
            presentations: Object.values(state.presentations).map(presentation => presentation.status),
            stages: stages.map(stage => ({ name: stage.name, pending: stage.settled === undefined,
              elapsedMs: Math.round((stage.settled ?? performance.now()) - stage.started) })),
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
