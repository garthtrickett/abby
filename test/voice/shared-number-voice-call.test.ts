import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import type { EffectCallLeaseStore } from "../../src/core/effect-call-lease.ts";
import { err, ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { ClinikoPhoneLookup } from "../../src/standalone/cliniko-phone-lookup.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { ConnectedVoiceCall } from "../../src/voice/connected-voice-call.ts";
import type { CallerCandidateLookup } from "../../src/voice/caller-candidates.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";
import { SharedNumberVoiceCall } from "../../src/voice/shared-number-voice-call.ts";
import type { FullVoiceSessionFactory } from "../../src/voice/shared-number-voice-call.ts";
import { MediaTurnController } from "../../src/voice/media-turn-controller.ts";
import { OpenAISpeechSynthesis } from "../../src/voice/openai-speech-synthesis.ts";
import type { MediaFrame, TranscriptionPort } from "../../src/voice/media-turn-controller.ts";
import { TransportMediaNormalizer } from "../../src/voice/transport-media-normalizer.ts";
import type { TransportMediaEncoding } from "../../src/voice/transport-media-normalizer.ts";
import { StreamedPlaybackPort } from "../../src/voice/streamed-playback-port.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import type { PlaybackPort } from "../../src/voice/voice-session.ts";

const now = "2026-09-28T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1_000).toISOString();
const kinds = process.env.ABBY_LEDGER === "postgres" ? ["memory", "postgres"] as const : ["memory"] as const;
const db = process.env.DATABASE_URL ? connectPostgres(process.env.DATABASE_URL) : undefined;
after(async () => { await db?.destroy(); });

function value<T>(result: Result<T, { kind: string }>): T {
  assert.ok(result.ok, result.ok ? "" : result.error.kind);
  return result.value;
}

let sequence = 0;
function fixture(kind: "memory" | "postgres", outputPort?: PlaybackPort) {
  const id = `${kind}-voice-handoff-${++sequence}`;
  const main = { tenantId: `tenant-${id}`, clinicId: `clinic-${id}`, locationId: "main" };
  const north = { ...main, locationId: "north" };
  const accountRef = `account-${id}`;
  let current = now;
  const sharedNumber = "+6125550101";
  const singleNumber = "+6125550102";
  const host = new ReferenceNumberRoutingHost([
    { accountRef, dialedNumber: sharedNumber, ...main, spokenName: "Main Street", routeVersion: "v1" },
    { accountRef, dialedNumber: sharedNumber, ...north, spokenName: "Northside", routeVersion: "v1" },
    { accountRef, dialedNumber: singleNumber, ...main, routeVersion: "v1" },
  ]);
  const ledger: LedgerStore & EffectCallLeaseStore = kind === "postgres" ? new PostgresLedger(db!, suggested => suggested, undefined, "unsafeReference") : new MemoryLedger();
  const policy = kind === "postgres"
    ? new PostgresPolicyStore(db!, referenceDefaultPolicy, "execute", async () => ok(true), true, "unsafeReference")
    : new MemoryPolicyStore("execute", () => current, async () => ok(true));
  let policyReads = 0;
  let policyGate: Readonly<{ entered: () => void; release: Promise<void> }> | undefined;
  const router = new ClinicPolicyRouter(host, { async read(scope) {
    policyReads += 1;
    const gate = policyGate;
    policyGate = undefined;
    if (gate) { gate.entered(); await gate.release; }
    return policy.read(scope);
  } });
  const admission = new CallAdmissionService(ledger, router.resolve, () => current, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, () => current);
  const patient = { scope: north, patientRef: "patient", verificationRef: "verified", expiresAt: at(3_600) };
  const offer = { scope: north, offerRef: "offer", serviceRef: "physio", startsAt: at(172_800), expiresAt: at(3_600) };
  const clinic = new ReferenceClinicHost([patient], [offer]);
  const reception = new TextReception(ledger, policy, clinic);
  const queued: Array<{ id: string; text: string }> = [];
  const playback: PlaybackPort = outputPort ?? {
    async enqueue(id, text) { queued.push({ id, text }); return "queued"; },
    async clear() { return true; },
  };
  const event = (dialedNumber: string, ref: string) =>
    ({ key: { accountRef, providerCallRef: `${id}-${ref}` }, dialedNumber, receivedAt: now });
  let wrongFactoryScope = false;
  const resolvedTurns: string[] = [];
  const fullFactory: FullVoiceSessionFactory = (receipt, sessionId, port) => new VoiceSession(receipt.callId, sessionId,
      wrongFactoryScope ? main : receipt.scope, ledger, reception, port, async turn => {
        resolvedTurns.push(turn.text);
        return ok(turn.text.startsWith("Book") ? { kind: "book" as const, verificationRef: "verified", offerRef: "offer" }
          : turn.text.startsWith("Staff") ? { kind: "handoff" as const, reason: "callerRequested" as const }
          : { kind: "affirm" as const });
      });
  const call = (inbound: ReturnType<typeof event>) => new SharedNumberVoiceCall(inbound, "session", ledger, intake, playback,
    fullFactory);
  return { main, north, ledger, policy, clinic, queued, call, event, intake, fullFactory, sharedNumber, singleNumber, resolvedTurns,
    policyReads: () => policyReads, setWrongFactoryScope(value: boolean) { wrongFactoryScope = value; },
    setTime(value: string) { current = value; },
    holdNextPolicyRead() {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const releasePromise = new Promise<void>(resolve => { release = resolve; });
      policyGate = { entered, release: releasePromise };
      return { entered: enteredPromise, release };
    } };
}

for (const kind of kinds) {
  test(`E2E-141 ${kind}: shared-number location choice renews before binding`, async () => {
    const app = fixture(kind);
    const inbound = app.event(app.sharedNumber, "renew-choice");
    const call = app.call(inbound);
    const started = value(await call.begin(now));
    assert.equal(started.kind, "locationChoice");
    app.setTime(at(20));
    const renewed = value(await call.renew(at(20)));
    assert.equal("status" in renewed && renewed.status, "pending");
    assert.equal(renewed.sessionLease?.version, 2);
    assert.equal(renewed.sessionLease?.expiresAt, at(50));
    value(await call.end(at(21)));
  });

  test(`${kind}: caller phone reaches candidate lookup only after admission and stays out of the ledger`, async () => {
    const app = fixture(kind);
    value(await app.policy.changeAutomationEnabled(app.main, "0", true, "admin"));
    const presentedCallerNumber = "+61400111222";
    const inbound = { ...app.event(app.singleNumber, "phone-candidates"), presentedCallerNumber };
    const lookedUp: Array<{ clinicId: string; phone: string }> = [];
    let candidateLookup: CallerCandidateLookup = { async candidates(scope, phone) {
      lookedUp.push({ clinicId: scope.clinicId, phone });
      return ok({ kind: "one", candidateIds: ["123"] });
    } };
    if (kind === "postgres") {
      const created = ClinikoPatientCandidateReader.create({ scope: app.main, apiKey: "synthetic-au5",
        contactEmail: "test@example.com" }, async input => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/patients") return Response.json({ total_entries: 1, patients: [
          { id: "123", first_name: "private-canary", archived_at: null,
            patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }] },
        ] });
        if (path === "/v1/patients/123") {
          lookedUp.push({ clinicId: app.main.clinicId, phone: presentedCallerNumber });
          return Response.json({ id: "123", first_name: "private-canary", archived_at: null,
            patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }] });
        }
        throw new Error("unexpected Cliniko request");
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      const lookup = new ClinikoPhoneLookup(created.value, new PostgresPatientPhoneIndex(db!), "61", 60_000);
      assert.equal((await lookup.refresh(app.main)).ok, true);
      candidateLookup = lookup;
    }
    const call = new ConnectedVoiceCall({ event: inbound, sessionId: "session", ledger: app.ledger,
      intake: app.intake, fullFactory: app.fullFactory,
      callerCandidateLookup: candidateLookup,
      transcription: { async accept() { return ok([]); }, async flush() { return ok([]); } },
      synthesis: { async *stream() { yield new Uint8Array(640); } },
      output: { async queueChunk() { return "queued"; }, async finishQueue() { return "queued"; },
        async clear() { return true; } },
    });
    assert.equal((await call.findPatientCandidates()).ok, false);
    const started = value(await call.begin(now));
    if (started.kind !== "admitted") throw new Error("admission expected");
    assert.deepEqual(value(await call.findPatientCandidates()), { kind: "one", candidateIds: ["123"] });
    assert.deepEqual(lookedUp, [{ clinicId: app.main.clinicId, phone: presentedCallerNumber }]);
    const stored = value(await app.ledger.read(started.receipt.callId, app.main));
    assert.equal(JSON.stringify(stored).includes(presentedCallerNumber), false);
    if (kind === "postgres") {
      const row = await db!.selectFrom("calls").select("state").where("call_id", "=", started.receipt.callId as never)
        .executeTakeFirstOrThrow();
      assert.equal(JSON.stringify(row.state).includes(presentedCallerNumber), false);
      const events = await db!.selectFrom("call_events").select("payload")
        .where("call_id", "=", started.receipt.callId as never).execute();
      assert.equal(JSON.stringify(events).includes(presentedCallerNumber), false);
    }
    value(await call.disconnect(at(1)));
    const afterEnd = await call.findPatientCandidates();
    assert.equal(afterEnd.ok, false);
    if (!afterEnd.ok) assert.equal(afterEnd.error.kind, "disconnected");
  });

  test(`${kind}: shared clinic number cannot use caller phone before location binding`, async () => {
    const app = fixture(kind);
    const presentedCallerNumber = "+61400999888";
    const inbound = { ...app.event(app.sharedNumber, "phone-before-location"), presentedCallerNumber };
    let lookups = 0;
    const call = new ConnectedVoiceCall({ event: inbound, sessionId: "session", ledger: app.ledger,
      intake: app.intake, fullFactory: app.fullFactory,
      callerCandidateLookup: { async candidates() {
        lookups += 1;
        return ok({ kind: "one", candidateIds: ["123"] });
      } },
      transcription: { async accept() { return ok([]); }, async flush() { return ok([]); } },
      synthesis: { async *stream() { yield new Uint8Array(640); } },
      output: { async queueChunk() { return "queued"; }, async finishQueue() { return "queued"; },
        async clear() { return true; } },
    });
    const started = value(await call.begin(now));
    assert.equal(started.kind, "locationChoice");
    const unresolved = await call.findPatientCandidates();
    assert.equal(unresolved.ok, false);
    if (!unresolved.ok) assert.equal(unresolved.error.kind, "locationUnbound");
    assert.equal(lookups, 0);
    const pending = value(await app.ledger.findPendingLocation(callIdFor(inbound.key)));
    assert.equal(JSON.stringify(pending).includes(presentedCallerNumber), false);
    value(await call.disconnect(at(1)));
  });

  test(`${kind}: PCMU and PCM16 ingress produce the same canonical frames and staff decision`, async () => {
    async function journey(encoding: TransportMediaEncoding) {
      const app = fixture(kind);
      value(await app.policy.changeAutomationEnabled(app.main, "0", true, "admin"));
      const inbound = app.event(app.singleNumber, `codec-${encoding}`);
      const call = new ConnectedVoiceCall({ event: inbound, sessionId: "session", ledger: app.ledger,
        intake: app.intake, fullFactory: app.fullFactory,
        transcription: {
          async accept(_frame, generation) { return ok([{ kind: "partial" as const, sessionId: "session", generation,
            utteranceId: "request", text: "Staff please" }]); },
          async flush(generation) { return ok([{ kind: "segmentFinal", sessionId: "session", generation,
            utteranceId: "request", text: "Staff please", quality: "clear" }]); },
        },
        synthesis: { async *stream() { yield new Uint8Array(640); } },
        output: { async queueChunk() { return "queued"; }, async finishQueue() { return "queued"; },
          async clear() { return true; } }, mediaOptions: { silenceMs: 100 } });
      const started = value(await call.begin(now));
      if (started.kind !== "admitted" || started.delivery.kind !== "queued" || !started.delivery.playbackId) {
        throw new Error("greeting expected");
      }
      value(await call.acceptPlaybackCompletion({ playbackId: started.delivery.playbackId, lastSequence: 0,
        status: "played" }, now));
      const normalizer = new TransportMediaNormalizer(encoding);
      const canonical: number[][] = [];
      for (let sequence = 0; sequence < 7; sequence += 1) {
        const voiced = sequence < 2;
        const payload = encoding === "pcmu/8000"
          ? new Uint8Array(160).fill(voiced ? 0x9f : 0xff) : new Uint8Array(640);
        if (encoding === "pcm16le/16000") {
          const view = new DataView(payload.buffer);
          for (let offset = 0; offset < payload.length; offset += 2) view.setInt16(offset, voiced ? 8_316 : 0, true);
        }
        const frame = value(normalizer.normalize({ sessionId: "session", sequence,
          capturedAt: new Date(Date.parse(now) + sequence * 20).toISOString(), payload }));
        canonical.push([...frame.bytes]);
        const result = value(await call.acceptMedia(frame));
        if (sequence === 6) assert.equal(result.kind, "turnCompleted");
      }
      const state = value(await app.ledger.read(started.receipt.callId, app.main));
      const outcome = { canonical, turns: app.resolvedTurns, revision: state.conversationRevision,
        reasons: Object.values(state.staffItems).map(item => item.reason), bookings: app.clinic.bookings(app.main).length };
      value(await call.disconnect(at(1)));
      return outcome;
    }
    const pcmu = await journey("pcmu/8000");
    const pcm = await journey("pcm16le/16000");
    assert.deepEqual(pcmu, pcm);
    assert.deepEqual(pcmu.turns, ["Staff please"]);
    assert.deepEqual(pcmu.reasons, ["callerRequested"]);
    assert.ok(pcmu.revision > 0);
    assert.equal(pcmu.bookings, 0);
  });

  test(`${kind}: connected single-location call sends only the committed greeting and records playback`, async () => {
    const app = fixture(kind);
    value(await app.policy.changeAutomationEnabled(app.main, "0", true, "admin"));
    const queued: string[] = [];
    const synthesized: string[] = [];
    const call = new ConnectedVoiceCall({ event: app.event(app.singleNumber, "connected-single"),
      sessionId: "session", ledger: app.ledger, intake: app.intake, fullFactory: app.fullFactory,
      transcription: { async accept() { return ok([]); }, async flush() { return ok([]); } },
      synthesis: { async *stream(text) { synthesized.push(text); yield new Uint8Array(640); } },
      output: {
        async queueChunk(id) { queued.push(id); return "queued"; },
        async finishQueue() { return "queued"; },
        async clear() { return true; },
      } });
    const started = value(await call.begin(now));
    if (started.kind !== "admitted") throw new Error("admission expected");
    assert.deepEqual(started.receipt.scope, app.main);
    assert.equal(started.delivery.kind, "queued");
    if (started.delivery.kind !== "queued" || !started.delivery.playbackId) throw new Error("greeting was not queued");
    assert.deepEqual(synthesized, ["Hello. How can I help you?"]);
    assert.deepEqual(queued, [started.delivery.playbackId]);
    const stored = value(await app.ledger.read(started.receipt.callId, app.main));
    const greetingId = started.delivery.playbackId.replace(/:playback$/, "");
    assert.equal(stored.presentations[greetingId]?.status, "started");
    const invented = await call.acceptPlaybackCompletion({ playbackId: "uncommitted-greeting",
      lastSequence: 0, status: "played" }, at(1));
    assert.ok(!invented.ok);
    assert.equal(invented.error.kind, "playbackUnknown");
    const played = value(await call.acceptPlaybackCompletion({ playbackId: started.delivery.playbackId,
      lastSequence: 0, status: "played" }, at(1)));
    if (!("presentations" in played)) throw new Error("scoped call expected");
    assert.equal(played.presentations[greetingId]?.status, "played");
    assert.equal(played.pendingPresentationId, undefined);
    const ended = value(await call.disconnect(at(2)));
    if (!("lifecycle" in ended)) throw new Error("scoped terminal expected");
    assert.equal(ended.lifecycle, "ended");
  });

  test(`E2E-128 synthetic voice ${kind}: streamed speech settles a connected call only after output evidence`, async () => {
    const app = fixture(kind);
    value(await app.policy.changeAutomationEnabled(app.main, "0", true, "admin"));
    const source = new Uint8Array(960);
    const inputView = new DataView(source.buffer);
    for (let index = 0; index < 480; index += 1) inputView.setInt16(index * 2, 1_000, true);
    const requests: string[] = [];
    const synthesis = new OpenAISpeechSynthesis({ apiKey: "synthetic-key", fetchPort: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      requests.push(body.input);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(source.slice(0, 1));
        controller.enqueue(source.slice(1));
        controller.close();
      } }), { status: 200, headers: { "Content-Type": "audio/pcm" } });
    } });
    const chunks: Uint8Array[] = [];
    let finished = -1;
    const call = new ConnectedVoiceCall({ event: app.event(app.singleNumber, "openai-speech"),
      sessionId: "session", ledger: app.ledger, intake: app.intake, fullFactory: app.fullFactory,
      transcription: { async accept() { return ok([]); }, async flush() { return ok([]); } },
      synthesis, output: {
        async queueChunk(_id, sequence, bytes) {
          assert.equal(sequence, chunks.length);
          chunks.push(new Uint8Array(bytes));
          return "queued";
        },
        async finishQueue(_id, sequence) { finished = sequence; return "queued"; },
        async clear() { return true; },
      } });
    const started = value(await call.begin(now));
    if (started.kind !== "admitted" || started.delivery.kind !== "queued" || !started.delivery.playbackId) {
      throw new Error("greeting was not queued");
    }
    assert.deepEqual(requests, ["Hello. How can I help you?"]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.byteLength, 640);
    assert.equal(new DataView(chunks[0]!.buffer).getInt16(0, true), 1_000);
    assert.equal(finished, 0);
    const presentationId = started.delivery.playbackId.replace(/:playback$/, "");
    assert.equal(value(await app.ledger.read(started.receipt.callId, app.main))
      .presentations[presentationId]?.status, "started");
    const played = value(await call.acceptPlaybackCompletion({ playbackId: started.delivery.playbackId,
      lastSequence: 0, status: "played" }, at(1)));
    if (!("presentations" in played)) throw new Error("scoped call expected");
    assert.equal(played.presentations[presentationId]?.status, "played");
    assert.equal(value(await app.ledger.read(started.receipt.callId, app.main))
      .presentations[presentationId]?.status, "played");
    value(await call.disconnect(at(2)));
  });

  test(`${kind}: disconnect racing connected admission fences later output`, async () => {
    const app = fixture(kind);
    value(await app.policy.changeAutomationEnabled(app.main, "0", true, "admin"));
    const sent: string[] = [];
    const call = new ConnectedVoiceCall({ event: app.event(app.singleNumber, "connected-start-race"),
      sessionId: "session", ledger: app.ledger, intake: app.intake, fullFactory: app.fullFactory,
      transcription: { async accept() { return ok([]); }, async flush() { return ok([]); } },
      synthesis: { async *stream() { yield new Uint8Array(640); } },
      output: {
        async queueChunk(id) { sent.push(id); return "queued"; },
        async finishQueue() { return "queued"; },
        async clear() { return true; },
      } });
    const gate = app.holdNextPolicyRead();
    const beginning = call.begin(now);
    await gate.entered;
    const closing = call.disconnect(at(1));
    gate.release();
    const startResult = await beginning;
    assert.ok(!startResult.ok);
    assert.equal(startResult.error.kind, "disconnected");
    const ended = value(await closing);
    if (!("lifecycle" in ended)) throw new Error("scoped terminal expected");
    assert.equal(ended.lifecycle, "ended");
    assert.deepEqual(sent, []);
  });

  test(`${kind}: disconnect during a streamed location prompt fences its next chunk`, async () => {
    const app = fixture(kind);
    const inbound = app.event(app.sharedNumber, "connected-output-race");
    let firstSent!: () => void;
    const firstChunk = new Promise<void>(resolve => { firstSent = resolve; });
    let release!: () => void;
    const nextChunk = new Promise<void>(resolve => { release = resolve; });
    const sent: number[] = [];
    const cleared: string[] = [];
    const call = new ConnectedVoiceCall({ event: inbound, sessionId: "session", ledger: app.ledger,
      intake: app.intake, fullFactory: app.fullFactory,
      transcription: { async accept() { return ok([]); }, async flush() { return ok([]); } },
      synthesis: { async *stream() { yield new Uint8Array(640); await nextChunk; yield new Uint8Array(640); } },
      output: {
        async queueChunk(_id, sequence) { sent.push(sequence); firstSent(); return "queued"; },
        async finishQueue() { throw new Error("disconnected prompt must not finish"); },
        async clear(id) { cleared.push(id); return true; },
      } });
    const beginning = call.begin(now);
    await firstChunk;
    const closing = call.disconnect(at(1));
    release();
    const began = await beginning;
    assert.ok(!began.ok);
    assert.equal(began.error.kind, "disconnected");
    const ended = value(await closing);
    if (!("status" in ended)) throw new Error("pending terminal expected");
    assert.equal(ended.status, "expired");
    assert.deepEqual(sent, [0]);
    assert.ok(cleared.length >= 1);
  });

  test(`${kind}: connected synthetic call owns media, output evidence, host effect, and disconnect`, async () => {
    const app = fixture(kind);
    const inbound = app.event(app.sharedNumber, "connected-loop");
    const utterances = ["Northside", "Book physio", "Yes"];
    let utterance = 0;
    const transcription: TranscriptionPort = {
      async accept(_frame, generation) { return ok([{ kind: "partial", sessionId: "session", generation,
        utteranceId: "provider-utterance", text: utterances[utterance]! }]); },
      async flush(generation) { return ok([{ kind: "segmentFinal", sessionId: "session", generation,
        utteranceId: "provider-utterance", text: utterances[utterance++]!, quality: "clear" }]); },
    };
    const queued: Array<{ id: string; sequence: number }> = [];
    const call = new ConnectedVoiceCall({ event: inbound, sessionId: "session", ledger: app.ledger,
      intake: app.intake, fullFactory: app.fullFactory, transcription,
      synthesis: { async *stream() { yield new Uint8Array(640); yield new Uint8Array(640); } },
      output: {
        async queueChunk(id, sequence) { queued.push({ id, sequence }); return "queued"; },
        async finishQueue() { return "queued"; },
        async clear() { return true; },
      }, mediaOptions: { silenceMs: 100 } });
    const started = value(await call.begin(now));
    if (started.kind !== "locationChoice") throw new Error("choice expected");
    assert.deepEqual(queued.filter(item => item.id === started.prompt.playbackId).map(item => item.sequence), [0, 1]);
    value(await call.acceptPlaybackCompletion({ playbackId: started.prompt.playbackId, lastSequence: 1,
      status: "played" }, now));
    value(await app.policy.changeAutomationEnabled(app.north, "0", true, "admin"));
    value(await app.policy.changeBookingEnabled(app.north, "0", true, "admin"));
    let sequence = 0;
    let timeOffsetMs = 0;
    async function send(amplitude: number) {
      const bytes = new Uint8Array(640);
      const view = new DataView(bytes.buffer);
      for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, amplitude, true);
      const frame: MediaFrame = { sessionId: "session", sequence,
        capturedAt: new Date(Date.parse(now) + timeOffsetMs + sequence * 20).toISOString(), bytes };
      sequence += 1;
      app.setTime(frame.capturedAt);
      return value(await call.acceptMedia(frame));
    }
    async function speak() {
      await send(2_000);
      await send(2_000);
      for (let i = 0; i < 4; i += 1) await send(0);
      const completed = await send(0);
      if (completed.kind !== "turnCompleted") throw new Error("final turn expected");
      return completed;
    }
    const bound = await speak();
    if (bound.turn.kind !== "locationBound") throw new Error("location not bound");
    assert.deepEqual(bound.turn.receipt.scope, app.north);
    const planned = await speak();
    assert.equal(planned.turn.kind, "callerTurn");
    assert.equal(planned.delivery.kind, "queued");
    if (planned.delivery.kind !== "queued" || !planned.delivery.playbackId) throw new Error("details not queued");
    assert.equal(app.clinic.bookings(app.north).length, 0);
    const tooEarly = await call.acceptPlaybackCompletion({ playbackId: planned.delivery.playbackId,
      lastSequence: 0, status: "played" }, at(1));
    assert.ok(!tooEarly.ok);
    assert.equal(tooEarly.error.kind, "invalidPlaybackEvidence");
    value(await call.acceptPlaybackCompletion({ playbackId: planned.delivery.playbackId,
      lastSequence: 1, status: "played" }, at(1)));
    timeOffsetMs = 2_000;
    const affirmed = await speak();
    assert.equal(affirmed.turn.kind, "callerTurn");
    assert.equal(app.clinic.bookings(app.north).length, 1);
    assert.deepEqual(app.clinic.bookings(app.main), []);
    const ended = value(await call.disconnect(at(4)));
    if (!("lifecycle" in ended)) throw new Error("scoped terminal expected");
    assert.equal(ended.lifecycle, "ended");
    assert.deepEqual(value(await call.disconnect(at(5))), ended);
    const late = await call.acceptMedia({ sessionId: "session", sequence, capturedAt: at(5), bytes: new Uint8Array(640) });
    assert.ok(!late.ok);
    assert.equal(late.error.kind, "disconnected");
  });

  test(`${kind}: connected call closes its pending location on transcription failure`, async () => {
    const app = fixture(kind);
    const inbound = app.event(app.sharedNumber, "connected-stt-failure");
    const call = new ConnectedVoiceCall({ event: inbound, sessionId: "session", ledger: app.ledger,
      intake: app.intake, fullFactory: app.fullFactory,
      transcription: {
        async accept() { return err({ kind: "transcriptionUnavailable" as const }); },
        async flush() { return ok([]); },
      },
      synthesis: { async *stream() { yield new Uint8Array(640); } },
      output: {
        async queueChunk() { return "queued"; },
        async finishQueue() { return "queued"; },
        async clear() { return true; },
      }, mediaOptions: { speechStartMs: 20 } });
    value(await call.begin(now));
    const bytes = new Uint8Array(640);
    const view = new DataView(bytes.buffer);
    for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, 2_000, true);
    const rejected = await call.acceptMedia({ sessionId: "session", sequence: 0, capturedAt: at(1), bytes });
    assert.ok(!rejected.ok);
    assert.equal(rejected.error.kind, "transcriptionUnavailable");
    const pending = value(await app.ledger.findPendingLocation(callIdFor(inbound.key)));
    assert.equal(pending?.status, "expired");
    assert.equal(pending?.closeEvidence?.reason, "sessionClosed");
    assert.equal(value(await app.ledger.findAdmission(callIdFor(inbound.key))), null);
  });

  test(`${kind}: connected startup failure closes its attached pending session`, async () => {
    const app = fixture(kind);
    const inbound = app.event(app.sharedNumber, "connected-start-failure");
    const failingLedger: LedgerStore = new Proxy(app.ledger, { get(target, property) {
      if (property === "startPendingLocationPrompt") return async () => err({ kind: "storageFailure" as const });
      const member = Reflect.get(target, property) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    } });
    const call = new ConnectedVoiceCall({ event: inbound, sessionId: "session", ledger: failingLedger,
      intake: app.intake, fullFactory: app.fullFactory,
      transcription: { async accept() { return ok([]); }, async flush() { return ok([]); } },
      synthesis: { async *stream() { yield new Uint8Array(640); } },
      output: {
        async queueChunk() { throw new Error("prompt cannot reach output"); },
        async finishQueue() { throw new Error("prompt cannot finish"); },
        async clear() { return true; },
      } });
    const failed = await call.begin(now);
    assert.ok(!failed.ok);
    assert.equal(failed.error.kind, "storageFailure");
    const pending = value(await app.ledger.findPendingLocation(callIdFor(inbound.key)));
    assert.equal(pending?.status, "expired");
    const retry = await call.begin(at(1));
    assert.ok(!retry.ok);
    assert.equal(retry.error.kind, "disconnected");
  });

  test(`${kind}: synthesized chunk playback needs exact completion before a booking affirmation`, async () => {
    const sent: Array<{ id: string; sequence: number }> = [];
    const finished: Array<{ id: string; sequence: number }> = [];
    const playback = new StreamedPlaybackPort({ async *stream() {
      yield new Uint8Array(640);
      yield new Uint8Array(640);
    } }, {
      async queueChunk(id, sequence) { sent.push({ id, sequence }); return "queued"; },
      async finishQueue(id, sequence) { finished.push({ id, sequence }); return "queued"; },
      async clear() { return true; },
    });
    const app = fixture(kind, playback);
    const call = app.call(app.event(app.sharedNumber, "streamed-playback"));
    const started = value(await call.begin(now));
    if (started.kind !== "locationChoice") throw new Error("choice expected");
    assert.deepEqual(sent.filter(item => item.id === started.prompt.playbackId).map(item => item.sequence), [0, 1]);
    const provePlayed = async (id: string, time: string) => value(await playback.acceptCompletion(
      { playbackId: id, lastSequence: 1, status: "played" },
      async event => (await call.acceptPlaybackResult(event.playbackId, event.status, time)).ok));
    await provePlayed(started.prompt.playbackId, at(1));
    value(await app.policy.changeAutomationEnabled(app.north, "0", true, "admin"));
    value(await app.policy.changeBookingEnabled(app.north, "0", true, "admin"));
    const choiceGeneration = value(await call.speechStarted(at(2)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation: choiceGeneration,
      utteranceId: "choice", text: "Northside", quality: "clear" }));
    app.setTime(at(3));
    const bound = value(await call.finishTurn(at(3)));
    if (bound.kind !== "locationBound") throw new Error("location not bound");
    const bookingGeneration = value(await call.speechStarted(at(4)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation: bookingGeneration,
      utteranceId: "booking", text: "Book physio", quality: "clear" }));
    const planned = value(await call.finishTurn(at(5)));
    if (planned.kind !== "callerTurn") throw new Error("booking turn expected");
    const action = Object.values(planned.state.actions)[0];
    assert.ok(action);
    const details = value(await call.dispatchPending(at(6)));
    assert.equal(details.kind, "queued");
    assert.ok(details.playbackId);
    assert.deepEqual(finished.find(item => item.id === details.playbackId),
      { id: details.playbackId, sequence: 1 });
    assert.equal(app.clinic.bookings(app.north).length, 0);
    const premature = await playback.acceptCompletion(
      { playbackId: details.playbackId, lastSequence: 0, status: "played" }, async () => true);
    assert.ok(!premature.ok);
    assert.equal(premature.error.kind, "invalidPlaybackEvidence");
    const completion = { playbackId: details.playbackId, lastSequence: 1, status: "played" as const };
    const lostAcknowledgment = await playback.acceptCompletion(completion, async event => {
      value(await call.acceptPlaybackResult(event.playbackId, event.status, at(7)));
      return false;
    });
    assert.ok(!lostAcknowledgment.ok);
    assert.equal(lostAcknowledgment.error.kind, "settlementUnavailable");
    value(await playback.acceptCompletion(completion, async () => {
      const stored = value(await app.ledger.read(bound.receipt.callId, app.north));
      return stored.presentations[action.presentationId]?.status === "played";
    }));
    const affirmGeneration = value(await call.speechStarted(at(8)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation: affirmGeneration,
      utteranceId: "affirm", text: "Yes", quality: "clear" }));
    const ready = value(await call.finishTurn(at(9)));
    if (ready.kind !== "callerTurn") throw new Error("affirmation turn expected");
    assert.equal(ready.state.actions[action.key]?.status, "ready");
    value(await call.drainEffects(at(10)));
    assert.equal(app.clinic.bookings(app.north).length, 1);
    assert.deepEqual(app.clinic.bookings(app.main), []);
  });

  test(`${kind}: shared-number voice call binds a location before booking and keeps one session`, async () => {
    const app = fixture(kind);
    const call = app.call(app.event(app.sharedNumber, "booking"));
    const started = value(await call.begin(now));
    assert.equal(started.kind, "locationChoice");
    assert.equal(app.queued[0]?.text, "Which location would you like? Please say Main Street or Northside.");
    assert.equal(app.policyReads(), 0);
    assert.equal(app.clinic.bookingEvidenceReads(), 0);
    assert.equal((await call.dispatchPending(now)).ok, true);
    assert.equal(app.queued.length, 1);
    if (started.kind !== "locationChoice") throw new Error("choice expected");
    value(await call.acceptPlaybackResult(started.prompt.playbackId, "played", now));
    const choiceGeneration = value(await call.speechStarted(at(1)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation: choiceGeneration,
      utteranceId: "location", text: "Northside", quality: "clear" }));
    value(await app.policy.changeAutomationEnabled(app.north, "0", true, "admin"));
    value(await app.policy.changeBookingEnabled(app.north, "0", true, "admin"));
    app.setTime(at(2));
    const bound = value(await call.finishTurn(at(2)));
    assert.equal(bound.kind, "locationBound");
    if (bound.kind !== "locationBound") throw new Error("bound expected");
    assert.deepEqual(bound.receipt.scope, app.north);
    assert.equal(bound.state.lifecycle, "active");
    assert.equal((await new CallRuntime(app.ledger, app.main).read(bound.receipt.callId)).ok, false);
    const bookingGeneration = value(await call.speechStarted(at(3)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation: bookingGeneration,
      utteranceId: "booking", text: "Book physio", quality: "clear" }));
    const planned = value(await call.finishTurn(at(4)));
    assert.equal(planned.kind, "callerTurn");
    if (planned.kind !== "callerTurn") throw new Error("turn expected");
    const action = Object.values(planned.state.actions)[0];
    assert.ok(action);
    assert.equal(action.mutation.scope.locationId, app.north.locationId);
    assert.equal(action.status, "awaitingConfirmation");
    const details = value(await call.dispatchPending(at(5)));
    assert.equal(details.kind, "queued");
    value(await call.acceptPlaybackResult(details.playbackId!, "played", at(6)));
    const affirmGeneration = value(await call.speechStarted(at(7)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation: affirmGeneration,
      utteranceId: "affirm", text: "Yes", quality: "clear" }));
    const ready = value(await call.finishTurn(at(8)));
    assert.equal(ready.kind, "callerTurn");
    if (ready.kind !== "callerTurn") throw new Error("turn expected");
    assert.equal(ready.state.actions[action.key]?.status, "ready");
    assert.deepEqual(app.clinic.bookings(app.main), []);
    const committed = value(await call.drainEffects(at(9)));
    assert.equal(committed.actions[action.key]?.status, "committed");
    assert.equal(app.clinic.bookings(app.north).length, 1);
    assert.deepEqual(app.clinic.bookings(app.main), []);
  });

  test(`${kind}: single-location calls attach the ordinary voice session without a choice prompt`, async () => {
    const app = fixture(kind);
    value(await app.policy.changeAutomationEnabled(app.main, "0", true, "admin"));
    const started = value(await app.call(app.event(app.singleNumber, "single")).begin(now));
    assert.equal(started.kind, "admitted");
    if (started.kind !== "admitted") throw new Error("admission expected");
    assert.deepEqual(started.receipt.scope, app.main);
    assert.equal(started.state.lifecycle, "active");
    assert.deepEqual(app.queued, []);
  });

  test(`${kind}: wrong-scope full factory cannot attach and a correct retry keeps the bound choice`, async () => {
    const app = fixture(kind);
    const call = app.call(app.event(app.sharedNumber, "wrong-factory"));
    const started = value(await call.begin(now));
    assert.equal(started.kind, "locationChoice");
    value(await app.policy.changeAutomationEnabled(app.north, "0", true, "admin"));
    app.setWrongFactoryScope(true);
    const generation = value(await call.speechStarted(at(1)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation,
      utteranceId: "location", text: "Northside", quality: "clear" }));
    app.setTime(at(2));
    const rejected = await call.finishTurn(at(2));
    assert.ok(!rejected.ok);
    assert.equal(rejected.error.kind, "sessionUnavailable");
    assert.equal(app.policyReads(), 1);
    app.setWrongFactoryScope(false);
    const active = value(await call.resumeBound(at(3)));
    assert.equal(active.lifecycle, "active");
    assert.deepEqual(active.policy.scope, app.north);
  });

  test(`${kind}: disconnect during location choice closes the reservation and fences media`, async () => {
    const app = fixture(kind);
    const inbound = app.event(app.sharedNumber, "disconnect");
    const call = app.call(inbound);
    value(await call.begin(now));
    const ended = value(await call.end(at(1), "callerDisconnected"));
    if (!("status" in ended)) throw new Error("pending choice expected");
    assert.equal(ended.status, "expired");
    assert.equal(ended.closeEvidence?.reason, "callerDisconnected");
    assert.deepEqual(value(await call.end(at(2), "callerDisconnected")), ended);
    const later = await call.speechStarted(at(2));
    assert.ok(!later.ok);
    assert.equal(later.error.kind, "disconnected");
    assert.equal(value(await app.ledger.findAdmission(ended.callId)), null);
  });

  test(`${kind}: disconnect waits for a choice already binding and then ends the scoped call`, async () => {
    const app = fixture(kind);
    const call = app.call(app.event(app.sharedNumber, "choice-race"));
    value(await call.begin(now));
    value(await app.policy.changeAutomationEnabled(app.north, "0", true, "admin"));
    const generation = value(await call.speechStarted(at(1)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation,
      utteranceId: "location", text: "Northside", quality: "clear" }));
    app.setTime(at(2));
    const gate = app.holdNextPolicyRead();
    const finishing = call.finishTurn(at(2));
    await gate.entered;
    let ended = false;
    const ending = call.end(at(3), "callerDisconnected").then(result => { ended = true; return result; });
    await Promise.resolve();
    assert.equal(ended, false);
    gate.release();
    const bound = value(await finishing);
    assert.equal(bound.kind, "locationBound");
    const terminal = value(await ending);
    if (!("lifecycle" in terminal)) throw new Error("scoped call expected");
    assert.equal(terminal.lifecycle, "ended");
    assert.equal(terminal.terminal?.reason, "callerDisconnected");
    assert.deepEqual(terminal.policy.scope, app.north);
  });

  test(`${kind}: synthetic PCM frames close location, booking, and affirmation turns without direct turn calls`, async () => {
    const app = fixture(kind);
    const inbound = app.event(app.sharedNumber, "media-journey");
    const call = app.call(inbound);
    const started = value(await call.begin(now));
    if (started.kind !== "locationChoice") throw new Error("choice prompt expected");
    value(await call.acceptPlaybackResult(started.prompt.playbackId, "played", now));
    value(await app.policy.changeAutomationEnabled(app.north, "0", true, "admin"));
    value(await app.policy.changeBookingEnabled(app.north, "0", true, "admin"));
    const utterances = ["Northside", "Book physio", "Yes"];
    let finalCount = 0;
    const transcription: TranscriptionPort = {
      async accept(_frame, generation) {
        return ok([{ kind: "partial", sessionId: "session", generation,
          utteranceId: "provider-utterance", text: utterances[finalCount]! }]);
      },
      async flush(generation) {
        return ok([{ kind: "segmentFinal", sessionId: "session", generation,
          utteranceId: "provider-utterance", text: utterances[finalCount++]!, quality: "clear" }]);
      },
    };
    const media = new MediaTurnController("session", call, transcription, { silenceMs: 100 });
    let sequence = 0;
    let offsetMs = 0;
    async function send(amplitude: number) {
      const bytes = new Uint8Array(640);
      const view = new DataView(bytes.buffer);
      for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, amplitude, true);
      const frame: MediaFrame = { sessionId: "session", sequence,
        capturedAt: new Date(Date.parse(now) + offsetMs + sequence * 20).toISOString(), bytes };
      sequence += 1;
      app.setTime(frame.capturedAt);
      return value(await media.acceptMedia(frame));
    }
    async function speak() {
      await send(2_000);
      await send(2_000);
      for (let i = 0; i < 4; i += 1) await send(0);
      const completed = await send(0);
      assert.equal(completed.kind, "turnCompleted");
      if (completed.kind !== "turnCompleted") throw new Error("final turn expected");
      return completed.value;
    }
    const bound = await speak();
    assert.equal(bound.kind, "locationBound");
    if (bound.kind !== "locationBound") throw new Error("bound call expected");
    assert.deepEqual(bound.receipt.scope, app.north);
    const choice = value(await app.ledger.findPendingLocation(bound.receipt.callId));
    const booked = await speak();
    assert.equal(booked.kind, "callerTurn");
    if (booked.kind !== "callerTurn") throw new Error("booking turn expected");
    assert.notEqual(choice?.choiceEvidence?.turnId, booked.state.processedTurnIds[0]);
    const action = Object.values(booked.state.actions)[0];
    assert.ok(action);
    assert.equal(action.status, "awaitingConfirmation");
    const details = value(await call.dispatchPending(at(2)));
    assert.equal(details.kind, "queued");
    value(await call.acceptPlaybackResult(details.playbackId!, "played", at(2)));
    offsetMs = 2_000;
    const affirmed = await speak();
    assert.equal(affirmed.kind, "callerTurn");
    if (affirmed.kind !== "callerTurn") throw new Error("affirmation turn expected");
    assert.equal(affirmed.state.actions[action.key]?.status, "ready");
    value(await call.drainEffects(at(3)));
    assert.equal(app.clinic.bookings(app.north).length, 1);
    assert.deepEqual(app.clinic.bookings(app.main), []);
    await media.stop();
    const ended = value(await call.end(at(4), "callerDisconnected"));
    assert.equal("lifecycle" in ended ? ended.lifecycle : "pending", "ended");
  });
}
