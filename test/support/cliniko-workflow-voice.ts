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
import type { ClinicNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import type { OwnerFileServiceCatalogue } from "../../src/standalone/owner-file-service-catalogue.ts";
import { ClinikoVoiceClinicalHost } from "../../src/standalone/cliniko-voice-clinical-host.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoCallFlow, clinikoStaffPreparationDeadlineMs } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import { createStandaloneTransientVoiceCall } from "../../src/standalone/transient-voice-composition.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import type { IntentResolver } from "../../src/voice/voice-session.ts";
import type { TranscriptEvent } from "../../src/voice/turn-assembler.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { approvedSyntheticPolicy, syntheticSpeech } from "./approved-voice.ts";
import { retainedNativeAppointments } from "./retained-native-appointments.ts";
import { SyntheticPlaybackReceipts } from "./synthetic-playback-receipts.ts";
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
    /** Exercise the real reusable clinical host instead of fixture-owned wiring. */
    clinicalHost?: true;
    maximumWrites?: 2; classMove?: true;
    routingHost?: (accountSid: string) => ClinicNumberRoutingHost;
    locationServiceSources?: readonly Parameters<typeof OwnerFileServiceCatalogue.capture>[0][];
    appointmentTypeMetadata?: Readonly<Record<string, Readonly<{ durationMinutes: number }>>>;
    beforeWriteResponse?: () => Promise<void>;
    transitionTrace?: true;
    beforeBookingMenuRead?: () => void;
    transcriptFinal?: (event: Extract<TranscriptEvent, { kind: "segmentFinal" }>) => readonly TranscriptEvent[] } = {}) {
  const accountSid = `AC${"4".repeat(32)}`, callSid = `CA${randomUUID().replaceAll("-", "")}`, streamSid = `MZ${randomUUID().replaceAll("-", "")}`;
  const webhookUrl = "https://workflow.example.test/twilio/inbound", streamUrl = "wss://workflow.example.test/twilio/media/";
  let mediaElapsedMs = 0;
  const sourceClock = config.clock ?? (() => verificationNow);
  const sourceStartedAt = Date.parse(sourceClock());
  // Source ticks and quiet media represent the same elapsed interval. Use its
  // later observation so accelerated frames cannot lead trusted time, while a
  // real wait that advances both clocks is counted once.
  const now = () => new Date(Math.max(Date.parse(sourceClock()), sourceStartedAt + mediaElapsedMs)).toISOString();
  const authToken = "synthetic-workflow-voice-token", scope = config.receipt.scope;
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
    fallbackNumbers: { [config.inbound.dialedNumber]: "+6125550188" }, bindingKey: Buffer.alloc(32, 0x38), now: () => new Date(now()) });
  const policy = new Proxy(config.policies, { get(target, key) {
    if (key === "read") return async (...args: Parameters<typeof target.read>) => {
      const found = await observeSource("clinicPolicy", target.read.bind(target))(...args); return found.ok ? ok(approvedSyntheticPolicy(found.value)) : found;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const sent: { event: string; mark?: { name: string } }[] = [], spoken: string[] = [], transcripts: string[] = [], modelTurns: string[] = [];
  const inputs: string[] = [], privateInputs: string[] = [], privateTranscripts: string[] = [], writes: string[] = [];
  // Synthetic fixture memory only: inspect the actual provider mutation body,
  // separately from public speech and the SAM proposal being exercised.
  const writeRequests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const writtenActions = new Set<string>(), nativeRows = new Map<string, Record<string, unknown>>();
  const failures: string[] = [];
  const transitionTrace: Record<string, unknown>[] = [];
  const traceEnabled = options.transitionTrace === true;
  const playback = new SyntheticPlaybackReceipts(name => sendEvent({ event: "mark", mark: { name } }));
  // Fixed stage names and timings only; diagnostics never retain caller text,
  // provider paths, patient refs or verification material.
  const stages: { name: string; started: number; settled?: number; deadlineMs?: number; signal?: AbortSignal }[] = [];
  const observe = <Args extends unknown[], Value>(name: string, run: (...args: Args) => Promise<Value>, deadlineMs?: number,
    signalFor?: (...args: Args) => AbortSignal | undefined) =>
    async (...args: Args): Promise<Value> => {
      const sourceBefore = name === "bookingMenuRead" && process.env.ABBY_TEST_MENU_TIMINGS === "1"
        ? new Map([...sourceCalls].map(([key, value]) => [key, { count: value.count, totalMs: value.totalMs }])) : undefined;
      const signal = signalFor?.(...args);
      const stage: typeof stages[number] = { name, started: performance.now(), ...(deadlineMs === undefined ? {} : { deadlineMs }),
        ...(signal ? { signal } : {}) };
      if (stages.length >= 64) stages.shift();
      stages.push(stage);
      if (name === "bookingMenuRead") options.beforeBookingMenuRead?.();
      try { return await run(...args); } finally {
        stage.settled = performance.now();
        if (sourceBefore) console.log(JSON.stringify({ kind: "bookingMenuTiming", elapsedMs: Math.round(stage.settled - stage.started),
          aborted: signal?.aborted === true, sources: Object.fromEntries([...sourceCalls].map(([key, value]) => [key,
            { count: value.count - (sourceBefore.get(key)?.count ?? 0), totalMs: Math.round(value.totalMs - (sourceBefore.get(key)?.totalMs ?? 0)) }])) }));
      }
    };
  // Fixed aggregate diagnostics, never arguments, provider refs or private values.
  const sourceCalls = new Map<string, { count: number; pending: number; totalMs: number; maximumMs: number }>();
  const observeSource = <Args extends unknown[], Value>(name: string, run: (...args: Args) => Value | Promise<Value>) => async (...args: Args): Promise<Value> => {
    const record = sourceCalls.get(name) ?? { count: 0, pending: 0, totalMs: 0, maximumMs: 0 };
    sourceCalls.set(name, record); record.count++; record.pending++; const start = performance.now();
    try { return await run(...args); }
    finally { const elapsed = performance.now() - start; record.pending--; record.totalMs += elapsed; record.maximumMs = Math.max(record.maximumMs, elapsed); }
  };
  // Observe only writable synthetic ports; immutable inputs stay untouched.
  const observedPorts = {
    nativeBudget: Reflect.set(config.cliniko.rateBudget, "claim", observeSource("nativeBudget", config.cliniko.rateBudget.claim.bind(config.cliniko.rateBudget))),
    ownerMembership: Reflect.set(config.directory, "findByRef", observeSource("ownerMembership", config.directory.findByRef.bind(config.directory))),
  };
  const sourceDiagnostic = () => ({ installed: observedPorts,
    calls: Object.fromEntries([...sourceCalls].map(([name, record]) => [name, { ...record,
      totalMs: Math.round(record.totalMs), maximumMs: Math.round(record.maximumMs) }])) });
  let ledger: MemoryLedger | undefined, flow: ClinikoCallFlow | undefined, socket: WebSocket | undefined, closed = false;
  let disposedState: ReturnType<MemoryLedger["read"]> | undefined, closeCode: number | undefined;
  let after: Record<string, unknown> | undefined, sequence = 1, chunk = 0, utterance = 0, transcriptionFrames = 0;
  let processedChunk = 0, processedSequence = 0, hostWritesStarted = 0, hostWritesSettled = 0;
  function sendEvent(event: Record<string, unknown>) {
    socket!.send(JSON.stringify({ ...event, streamSid: event.streamSid ?? streamSid, sequenceNumber: String(sequence++) }));
  }
  let staffPreparationsStarted = 0, staffPreparationsSettled = 0, staffWritesStarted = 0, staffWritesSettled = 0;
  const callId = callIdFor({ accountRef: accountSid, providerCallRef: callSid });
  const diagnosticState = async () => {
    try {
      const read = await (disposedState ?? ledger?.read(callId, scope));
      return read?.ok ? read.value : undefined;
    } catch { return undefined; }
  };
  const base = "https://api.au5.cliniko.com/v1", port = config.fetchPort!;
  const provider: typeof fetch = observe("providerRequest", async (value: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    const inspectedId = /^\/v1\/individual_appointments\/([0-9]+)(?:\/conflicts)?$/.exec(url.pathname)?.[1];
    if (method === "GET" && inspectedId && nativeRows.has(inspectedId))
      return Response.json(url.pathname.endsWith("/conflicts") ? { conflicts: { exist: false } } : nativeRows.get(inspectedId));
    if (method === "GET" && url.pathname === "/v1/individual_appointments/91/conflicts") return Response.json({ conflicts: { exist: false } });
    if (method === "POST" && url.pathname === "/v1/attendees" || method === "PATCH" && /^\/v1\/attendees\/[1-9][0-9]*\/cancel$/.test(url.pathname)) {
      const state = resultValue(await ledger!.read(callId, scope));
      const action = Object.values(state.actions).find(action => action.status === "dispatched"); assert.ok(action);
      assert.equal(action.kind, options.classMove ? "reschedule" : method === "POST" ? "book" : "cancel");
      assert.equal(state.presentations[action.presentationId]?.status, "played");
      assert.ok(Object.values(state.effects).some(effect => effect.kind === "hostWrite" && effect.actionKey === action.key));
      const leg = options.classMove ? `${action.key}:${method}:${url.pathname}` : action.key;
      assert.equal(writtenActions.has(leg), false); writtenActions.add(leg);
      writes.push(`${method} ${url.pathname}`); assert.ok(writes.length <= (options.maximumWrites ?? 1));
      writeRequests.push({ method, path: url.pathname, body: JSON.parse(String(init?.body)) });
      const response = await port(value, init);
      if (options.beforeWriteResponse) await options.beforeWriteResponse();
      if (options.lostWrite) throw new Error("synthetic lost class voice write response");
      return response;
    }
    if ((method === "POST" && url.pathname === "/v1/individual_appointments") ||
        (method === "PATCH" && url.pathname.startsWith("/v1/individual_appointments/"))) {
      const state = resultValue(await ledger!.read(callId, scope));
      const action = Object.values(state.actions).find(action => action.status === "dispatched")!; assert.ok(action);
      assert.equal(state.presentations[action.presentationId]?.status, "played");
      assert.ok(Object.values(state.effects).some(effect => effect.kind === "hostWrite" && effect.actionKey === action.key));
      assert.equal(writtenActions.has(action.key), false, "a confirmed action permits only one native write"); writtenActions.add(action.key);
      writes.push(`${method} ${url.pathname}`); assert.ok(writes.length <= (options.maximumWrites ?? 1));
      const body = JSON.parse(String(init?.body));
      writeRequests.push({ method, path: url.pathname, body: structuredClone(body) });
      const appointmentId = method === "PATCH" ? url.pathname.split("/")[3]! : String(90 + writeRequests.length);
      const before = method === "PATCH" ? await (await port(`${base}/individual_appointments/${appointmentId}`, { method: "GET", redirect: "error", ...(init?.signal ? { signal: init.signal } : {}) })).json() : {};
      const starts = body.starts_at ?? before.starts_at;
      const typeId = body.appointment_type_id ?? "33", metadata = options.appointmentTypeMetadata?.[typeId];
      if (options.appointmentTypeMetadata) assert.ok(metadata && Number.isSafeInteger(metadata.durationMinutes) && metadata.durationMinutes > 0 && metadata.durationMinutes <= 480);
      after = { ...before, id: appointmentId, notes: body.notes ?? before.notes, starts_at: starts, ends_at: new Date(Date.parse(starts) + (metadata?.durationMinutes ?? 30) * 60_000).toISOString(), archived_at: null, deleted_at: null,
        cancelled_at: url.pathname.endsWith("/cancel") ? now() : null,
        patient: body.patient_id === undefined && before.patient ? before.patient : { links: { self: `${base}/patients/${body.patient_id ?? verificationCanaries[2]}` } },
        business: { links: { self: `${base}/businesses/${body.business_id ?? config.cliniko.businessId}` } }, practitioner: { links: { self: `${base}/practitioners/${body.practitioner_id ?? "22"}` } },
        appointment_type: { links: { self: `${base}/appointment_types/${typeId}` } } };
      assert.ok(after); nativeRows.set(appointmentId, after);
      if (options.beforeWriteResponse) await options.beforeWriteResponse();
      if (options.lostWrite) throw new Error("synthetic lost voice write response");
      if (url.pathname.endsWith("/cancel")) return new Response(null, { status: 204 });
      return Response.json(after, { status: method === "POST" ? 201 : 200 });
    }
    return port(value, init);
  });
  const realHost = options.clinicalHost ? new ClinikoVoiceClinicalHost({ ...config, policies: policy, scope,
    greeting: resultValue(await policy.read(scope)).greeting!, fetchPort: provider, intent,
    ...(config.financial ? { financial: { ...config.financial, native: { ...config.financial.native, clock: now }, fetchPort: provider } } : {}) }) : undefined;
  const realWorkflow = realHost?.workflow({ scope,
    route: { accountRef: accountSid, dialedNumber: config.inbound.dialedNumber, routeVersion: "workflow-voice" },
    selection: { businessId: config.cliniko.businessId, practitionerId: config.cliniko.practitionerId,
      appointmentTypeId: config.cliniko.appointmentTypeId, policyVersion: config.policyVersion }, alternatives: [],
    businessTimeZone: config.cliniko.timeZone, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey),
    catalogueObservedAt: now(), approvedAt: now(), approvedBy: "synthetic-admin", patientActionMode: "unavailable", patientRequestMode: "unavailable" });
  const server = createTwilioIngressServer({ ingress, createCall: async (stream, send, close) => {
    const composed = resultValue(await createStandaloneTransientVoiceCall({ db,
      routingHost: options.routingHost?.(accountSid) ?? new ReferenceNumberRoutingHost([{ accountRef: accountSid, dialedNumber: config.inbound.dialedNumber, ...scope, routeVersion: "workflow-voice" }]),
      ...(options.locationServiceSources ? { locationServiceSources: options.locationServiceSources } : {}),
      stream, send, closeTransport: close, readiness: async () => ok(true), now, resolveIntent: async () => ok({ kind: "model" }),
      clinicalWorkflow: { policies: policy,
        ...(config.publicKnowledge ? { publicKnowledge: config.publicKnowledge } : {}),
        create(context) { ledger = context.ledger;
          if (config.financial) assert.ok(context.financialPresentation, "actual private financial playback port required");
          // Test-only observation before actual transient disposal; nothing is
          // persisted and the production ledger still releases every call.
          if (traceEnabled) {
            const apply = ledger.apply.bind(ledger);
            ledger.apply = async (...args: Parameters<MemoryLedger["apply"]>) => {
              const action = args[3];
              const before = await ledger!.read(args[0], args[1]);
              const detail = { kind: action.kind, ...("now" in action ? { at: action.now } : {}),
                ...(before.ok ? { beforeLifecycle: before.value.lifecycle, beforeRevision: before.value.conversationRevision,
                  beforeLeaseExpires: before.value.sessionLease?.expiresAt,
                  transferStarted: Object.values(before.value.presentations).some(p => p.kind === "transfer" && ["started", "possiblySent"].includes(p.status)) } : {}),
                ...(action.kind === "callerTurn" ? { interpretation: action.interpretation.kind,
                  textPresent: !!action.turn.text, turnAt: action.turn.at,
                  callMatches: before.ok && action.turn.callId === before.value.callId,
                  sessionMatches: before.ok && action.turn.sessionId === before.value.sessionLease?.sessionId,
                  turnIdPresent: !!action.turn.turnId } : {}) };
              const result = await apply(...args);
              if (transitionTrace.length >= 64) transitionTrace.shift();
              transitionTrace.push({ ...detail, result: result.ok ? "ok" : result.error.kind,
                ...(result.ok ? { lifecycle: result.value.lifecycle, revision: result.value.conversationRevision,
                  leaseExpires: result.value.sessionLease?.expiresAt, pendingPresentation: result.value.pendingPresentationId !== undefined } : {}) });
              return result;
            };
          }
          const callLedger = ledger, dispose = callLedger.dispose.bind(callLedger);
          callLedger.dispose = () => { disposedState ??= callLedger.read(callId, scope); dispose(); };
          flow = realWorkflow ? realWorkflow.create(context) : resultValue(ClinikoCallFlow.create({ ...config, ...context,
          policyVersion: config.policyVersion, fetchPort: provider,
          ...(config.financial && context.financialPresentation ? { financial: { ...config.financial,
            native: { ...config.financial.native, clock: now }, fetchPort: provider, presentation: context.financialPresentation } } : {}),
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
        ...(config.representativeInput ? { privateRepresentativeTranscription: (sessionId: string) => ({ async accept() { return ok([]); }, async flush(generation: number) {
          const text = privateInputs.shift(); assert.ok(text); privateTranscripts.push(text);
          return ok([{ kind: "segmentFinal" as const, sessionId, generation, utteranceId: `representative-${privateTranscripts.length}`, text, quality: "clear" as const }]);
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
    await once(socket, "open"); socket.on("message", data => {
      const event = JSON.parse(data.toString()); sent.push(event); playback.receive(event);
    });
    socket.on("close", code => { closeCode = code; });
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: String(sequence++), streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: { abbyBinding: binding } } }));
    try { await voiceUntil(() => sent.some(item => item.event === "mark"), "greeting mark"); }
    catch (error) {
      const transport = { closed, closeCode, receiveFailures: failures.length,
        mediaEvents: sent.filter(item => item.event === "media").length,
        markEvents: sent.filter(item => item.event === "mark").length,
        clearEvents: sent.filter(item => item.event === "clear").length };
      throw new Error(`greeting mark timed out: ${JSON.stringify(transport)}`, { cause: error });
    }
    const media = (voiced: boolean) => {
      chunk++; mediaElapsedMs = (chunk - 1) * 20;
      sendEvent({ event: "media", media: { track: "inbound", chunk: String(chunk), timestamp: String(mediaElapsedMs),
        payload: Buffer.alloc(160, voiced ? 0x9f : 0xff).toString("base64") } });
    };
    const mark = async () => {
      await voiceUntil(() => playback.hasPendingAfter(), "fresh queued playback marker");
      const markSequence = sequence;
      assert.equal(playback.acknowledgeLatest(), true);
      await voiceUntil(() => processedSequence >= markSequence, "processed playback receipt");
    };
    const privateQuiet = async () => {
      for (let frame = 0; frame < 25; frame++) media(false);
      const resumeChunk = chunk; await voiceUntil(() => processedChunk >= resumeChunk, "fresh private-audio quiet interval");
    };
    await mark();
    return { callId, currentTime: now, retainedNative: retainedNativeAppointments(nativeRows, now, port), sent, spoken, transcripts, privateTranscripts, modelTurns, transitionTrace, writes, writeRequests, close, mark, media, sendEvent, privateQuiet,
      get workflowStarted() { return flow !== undefined; },
      get flow() { assert.ok(flow); return flow; }, get transcriptionFrames() { return transcriptionFrames; },
      get closed() { return closed; }, get closeCode() { return closeCode; },
      state: async () => resultValue(await (disposedState ?? ledger!.read(callId, scope))),
      async privateField(text: string) {
        const marks = sent.filter(item => item.event === "mark").length; privateInputs.push(text);
        for (let frame = 0; frame < 7; frame++) media(frame < 2);
        await voiceUntil(() => playback.hasReplyAfter(marks) || failures.length > 0, "next private field prompt");
        assert.deepEqual(failures, []);
      },
      async privateDigit(digit: string) {
        const marks = sent.filter(item => item.event === "mark").length;
        sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
        await voiceUntil(() => playback.hasReplyAfter(marks) || failures.length > 0, "private registration prompt");
        assert.deepEqual(failures, []);
      },
      async privateKey(digit: string) {
        const keySequence = sequence;
        sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
        await voiceUntil(() => processedSequence >= keySequence || closed, "processed private keypad event");
        assert.deepEqual(failures, []);
      },
      async turn(text: string, options: { expectedFailure?: "confirmationMissing" | "staleGeneration" | "automatedCallUnavailable"; interrupt?: boolean } = {}) {
        stages.length = 0;
        const marks = sent.filter(item => item.event === "mark").length, clears = sent.filter(item => item.event === "clear").length;
        let replyAfterMarks = marks;
        const pending = ledger && !options.expectedFailure
          ? Object.values(resultValue(await ledger!.read(callId, scope)).actions).find(action => action.status === "awaitingConfirmation") : undefined;
        const beforeWrites = hostWritesStarted, beforePreparations = staffPreparationsStarted, beforeStaffWrites = staffWritesStarted;
        inputs.push(text); media(true); media(true);
        if (options.interrupt) {
          await voiceUntil(() => sent.filter(item => item.event === "clear").length > clears, "interrupted speech clear");
          const fenceIndex = sent.findIndex((item, index) => item.event === "clear" && sent.slice(0, index + 1).filter(item => item.event === "clear").length > clears);
          // The synthetic transport returns outstanding marks on every clear,
          // including callers that did not opt into this observation hint.
          replyAfterMarks = sent.slice(0, fenceIndex).filter(item => item.event === "mark").length;
        }
        for (let frame = 0; frame < 5; frame++) media(false);
        const finalChunk = chunk;
        try {
          const hasReply = () => playback.hasReplyAfter(replyAfterMarks);
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
            const remainingMs = Math.max(1, Math.ceil(stage.deadlineMs! - (performance.now() - stage.started)));
            const settled = () => (stage.signal ? stage.signal.aborted : stage.settled !== undefined) ||
              processedChunk >= finalChunk || hasReply() || failures.length > 0;
            try { await voiceUntil(settled, `${stage.name} settlement`, remainingMs); }
            catch (error) {
              // Observe delivery of already-due runtime deadline timers before
              // declaring a stall. This does not renew the production budget.
              await new Promise<void>(resolve => setTimeout(resolve, 0));
              if (!settled()) throw error;
            }
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
          const state = await diagnosticState();
          throw new Error(`caller turn delivery stalled: ${JSON.stringify({ closed, workflowClosed: flow?.closed,
            workflow: flow?.workflow, lifecycle: state?.lifecycle, terminalReason: state?.terminal?.reason, queuedInputs: inputs.length, processedChunk, chunk,
            sourceCalls: sourceDiagnostic(), modelTurns: modelTurns.length, transcriptionFrames, writes: writes.length, hostWritesStarted, hostWritesSettled, staffPreparationsStarted, staffPreparationsSettled, staffWritesStarted, staffWritesSettled, failures, stageFailure: error instanceof Error ? error.message : "unknown",
            actions: Object.values(state?.actions ?? {}).map(action => action.status),
            presentations: Object.values(state?.presentations ?? {}).map(presentation => presentation.status),
            stages: stages.map(stage => ({ name: stage.name, pending: stage.settled === undefined,
              elapsedMs: Math.round((stage.settled ?? performance.now()) - stage.started) })),
            effects: Object.values(state?.effects ?? {}).map(effect => ({ kind: effect.kind, status: effect.status })) })}`, { cause: error });
        }
        const failureState = failures.length && !options.expectedFailure ? await diagnosticState() : undefined;
        assert.deepEqual(failures, options.expectedFailure ? [options.expectedFailure] : [], `wire failure after ${modelTurns.length} model turns and ${transcriptionFrames} transcribed frames ${failureState ? JSON.stringify({
          workflow: flow?.workflow, lifecycle: failureState.lifecycle, terminalReason: failureState.terminal?.reason, now: now(),
          sourceCalls: sourceDiagnostic(), ...(traceEnabled ? { transitionTrace } : {}), processedChunk, finalChunk, pendingPresentation: failureState.pendingPresentationId !== undefined,
          actions: Object.values(failureState.actions).map(action => ({ kind: action.kind, status: action.status })),
          presentations: Object.values(failureState.presentations).map(p => ({ kind: p.kind, status: p.status })),
          effects: Object.values(failureState.effects).map(e => ({ kind: e.kind, status: e.status })),
          stages: stages.map(stage => ({ name: stage.name, pending: stage.settled === undefined, elapsedMs: Math.round((stage.settled ?? performance.now()) - stage.started) })),
        }) : ""}`);
        await voiceUntil(() => processedChunk >= finalChunk, "completed caller media turn"); },
      async verify(code: string) { for (const digit of `${code}#`) sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
        await voiceUntil(() => !flow!.verificationRequired, "private code verification");
        await privateQuiet(); },
    };
  } catch (error) { await close(); throw error; }
}
