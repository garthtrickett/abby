import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { clinicDateAt, serveClinikoVoice } from "../../scripts/serve-cliniko-voice.ts";
import { err, ok } from "../../src/core/model.ts";
import type { TranscriptionPort } from "../../src/voice/media-turn-controller.ts";
import { syntheticRealtimeSpeech } from "./synthetic-realtime-speech.ts";

if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
    !["synthetic-key-au5", "synthetic-rotated-key-au5"].includes(process.env.ABBY_CLINIKO_API_KEY ?? "") ||
    process.env.ABBY_TWILIO_ACCOUNT_SID !== `AC${"1".repeat(32)}` ||
    !process.env.DATABASE_URL?.includes("/abby_test_voice_") ||
    ![undefined, "openai-speech", "speech-realtime", "speech-realtime-mismatch", "speech-realtime-stall", "speech-primary-stall", "openai-transcription", "untrusted-transcript", "clear-availability", "clear-unsupported", "clear-model-failure", "cliniko-rate-limit", "cliniko-server-error", "cliniko-timeout", "cliniko-slow-read", "cliniko-zone-changed", "cliniko-partial-page", "cliniko-empty", "cliniko-business-type-removed", "cliniko-practitioner-type-removed", "week-alternative",
      "practitioner-alternative", "practitioner-alternative-rate-limit",
      "practitioner-alternative-malformed", "practitioner-alternative-second",
    "primary-selection-change", "clear-correction", "clear-playback-correction"].includes(process.env.ABBY_SYNTHETIC_VOICE_FAULT)) {
  throw new Error("synthetic voice runner requires an isolated fixture");
}
const fault = process.env.ABBY_SYNTHETIC_VOICE_FAULT;
const clearTurn = fault === "clear-availability" || fault === "clear-unsupported" ||
  fault === "clear-model-failure" || fault === "clear-correction" || fault === "clear-playback-correction";
const alternativeFault = fault === "practitioner-alternative" ||
  fault === "practitioner-alternative-rate-limit" || fault === "practitioner-alternative-malformed" ||
  fault === "practitioner-alternative-second" || fault === "primary-selection-change" ||
  fault === "cliniko-empty";

class SyntheticTranscriptionSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  private failed = false;
  private committed = 0;

  send(data: string): void {
    const request = JSON.parse(data) as { type: string; session?: unknown };
    if (request.type === "session.update") queueMicrotask(() => this.emit("message",
      Buffer.from(JSON.stringify({ type: "session.updated", session: request.session }))));
    if (fault === "openai-transcription" && !this.failed && data.includes('"input_audio_buffer.append"')) {
      this.failed = true;
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ type: "error" }))));
    }
    if (fault === "untrusted-transcript" && data.includes('"input_audio_buffer.commit"')) {
      const itemId = `synthetic-intent-item-${++this.committed}`;
      queueMicrotask(() => {
        this.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.committed",
          item_id: itemId })));
        this.emit("message", Buffer.from(JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed", item_id: itemId,
          transcript: "Do you have availability tomorrow?",
        })));
      });
    }
  }
  terminate(): void { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  close(): void { this.terminate(); }
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }
}

const clinikoFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  process.send?.({ kind: "clinikoMethod", method: init?.method, path: url.pathname, query: url.search });
  if (init?.method !== "GET") throw new Error("synthetic Cliniko write refused");
  if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", business_name: "Synthetic clinic",
    show_in_online_bookings: true, appointment_type_ids: fault === "practitioner-alternative-second"
      ? ["33", "55", "77"] : alternativeFault ? ["33", "55"] :
      [fault === "cliniko-business-type-removed" ? "44" : "33"],
    time_zone_identifier: fault === "cliniko-zone-changed" ? "Etc/UTC" : "Australia/Sydney" });
  if (url.pathname === "/v1/practitioners/22") return Response.json({ id: "22", display_name: "Synthetic practitioner", active: true,
    show_in_online_bookings: true });
  if (alternativeFault && url.pathname === "/v1/practitioners/44") return Response.json({ id: "44",
    display_name: fault === "practitioner-alternative-malformed" ? "Dr\nAlternative" : "Dr Alternative",
    active: true, show_in_online_bookings: true });
  if (fault === "practitioner-alternative-second" && url.pathname === "/v1/practitioners/66") return Response.json({
    id: "66", display_name: "Dr Third", active: true, show_in_online_bookings: true });
  if (url.pathname === "/v1/appointment_types/33") return Response.json({ id: "33", name: "Consult",
    show_in_online_bookings: true });
  if (alternativeFault && url.pathname === "/v1/appointment_types/55") return Response.json({ id: "55",
    name: "Follow up", show_in_online_bookings: true });
  if (fault === "practitioner-alternative-second" && url.pathname === "/v1/appointment_types/77") return Response.json({
    id: "77", name: "Review", show_in_online_bookings: true });
  if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({
    total_entries: fault === "practitioner-alternative-second" ? 3 : alternativeFault ? 2 : 1,
    practitioners: fault === "practitioner-alternative-second"
      ? [{ id: "22" }, { id: "44" }, { id: "66" }]
      : alternativeFault ? [{ id: "22" }, { id: "44" }] : [{ id: "22" }] });
  if (url.pathname === "/v1/practitioners/22/appointment_types") return Response.json({
    total_entries: fault === "cliniko-practitioner-type-removed" ? 0 : 1,
    appointment_types: fault === "cliniko-practitioner-type-removed" ? [] : [{ id: "33" }] });
  if (alternativeFault && url.pathname === "/v1/practitioners/44/appointment_types") return Response.json({
    total_entries: 1, appointment_types: [{ id: "55" }] });
  if (fault === "practitioner-alternative-second" && url.pathname === "/v1/practitioners/66/appointment_types") {
    return Response.json({ total_entries: 1, appointment_types: [{ id: "77" }] });
  }
  if (url.pathname.endsWith("/available_times")) {
    if (fault === "cliniko-empty") return Response.json({ total_entries: 0, available_times: [] });
    if (fault === "cliniko-rate-limit") return new Response(null, { status: 429 });
    if (fault === "cliniko-server-error") return new Response(null, { status: 503 });
    if (fault === "cliniko-timeout") throw new DOMException("synthetic timeout", "TimeoutError");
    if (fault === "cliniko-slow-read") {
      const signal = init?.signal;
      if (!signal) throw new Error("availability deadline missing");
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) return reject(new DOMException("synthetic deadline", "AbortError"));
        signal.addEventListener("abort", () => {
          process.send?.({ kind: "clinikoReadAborted",
            reason: signal.reason instanceof Error ? signal.reason.name : "unknown" });
          reject(new DOMException("synthetic deadline", "AbortError"));
        },
          { once: true });
      });
    }
    const date = url.searchParams.get("from");
    if (alternativeFault) {
      if (url.pathname.includes("/practitioners/22/")) return Response.json({ total_entries: 0, available_times: [] });
      if (fault === "practitioner-alternative-second" && url.pathname.includes("/practitioners/44/")) {
        return Response.json({ total_entries: 0, available_times: [] });
      }
      if (fault === "practitioner-alternative-rate-limit") return new Response(null, { status: 429 });
      return Response.json({ total_entries: 1, available_times: [
        { appointment_start: `${date}T11:00:00+10:00`, appointment_id: "synthetic-only" },
      ] });
    }
    if (fault === "week-alternative") {
      const end = url.searchParams.get("to");
      const startMs = Date.parse(`${date}T00:00:00.000Z`);
      const endMs = Date.parse(`${end}T00:00:00.000Z`);
      if (endMs - startMs !== 6 * 86_400_000) return Response.json({ total_entries: 0, available_times: [] });
      const later = new Date(startMs + 2 * 86_400_000).toISOString().slice(0, 10);
      return Response.json({ total_entries: 1, available_times: [
        { appointment_start: `${later}T10:00:00+10:00`, appointment_id: "synthetic-only" },
      ] });
    }
    if (fault === "cliniko-partial-page") return Response.json({ total_entries: 2,
      available_times: [{ appointment_start: `${date}T${url.searchParams.get("page") === "1" ? "10" : "11"}:00:00+10:00`,
        appointment_id: "synthetic-only" }] });
    return Response.json({ total_entries: 1,
      available_times: [{ appointment_start: `${date}T10:00:00+10:00`, appointment_id: "synthetic-only" }] });
  }
  throw new Error("unexpected Cliniko request");
};

const openaiFetch: typeof fetch = async (input, init) => {
  if (String(input) === "https://api.openai.com/v1/responses" && clearTurn) {
    const request = JSON.parse(String(init?.body)) as { store?: unknown; input?: { role: string; content: string }[] };
    const callerText = request.input?.[1]?.content;
    const firstText = "Do you have availability tomorrow?";
    const correctedText = "Actually, please have the clinic contact me.";
    const expectedText = fault === "clear-unsupported" ? "Please book my appointment tomorrow." : firstText;
    if (request.store !== false || (fault === "clear-correction" || fault === "clear-playback-correction"
      ? callerText !== JSON.stringify({ callerText: firstText }) &&
        callerText !== JSON.stringify({ callerText: correctedText })
      : callerText !== JSON.stringify({ callerText: expectedText }))) {
      throw new Error("unexpected synthetic intent request");
    }
    process.send?.({ kind: "intentModelRequest" });
    if (fault === "clear-model-failure") return new Response(null, { status: 503 });
    if (fault === "clear-correction" && callerText === JSON.stringify({ callerText: firstText })) {
      await new Promise<void>(resolve => {
        const aborted = () => {
          process.send?.({ kind: "intentModelAborted" });
          setTimeout(resolve, 150);
        };
        if (init?.signal?.aborted) aborted();
        else init?.signal?.addEventListener("abort", aborted, { once: true });
      });
    }
    const today = clinicDateAt("Australia/Sydney", new Date());
    const tomorrow = new Date(Date.parse(`${today}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    const decision = fault === "clear-availability" || ((fault === "clear-correction" || fault === "clear-playback-correction") &&
      callerText === JSON.stringify({ callerText: firstText }))
      ? { kind: "availability", from: tomorrow, to: tomorrow } :
      { kind: "unsupported", from: null, to: null };
    return Response.json({ status: "completed", output: [{ type: "message", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
  }
  if (String(input) === "https://api.openai.com/v1/responses" && fault === "untrusted-transcript") {
    process.send?.({ kind: "intentModelRequest" });
    return new Response(null, { status: 503 });
  }
  if (String(input) !== "https://api.openai.com/v1/audio/speech") {
    throw new Error("unexpected OpenAI request");
  }
  const request = JSON.parse(String(init?.body)) as { input?: unknown; model?: unknown };
  if (typeof request.input !== "string" || typeof request.model !== "string") {
    throw new Error("invalid synthetic speech request");
  }
  process.send?.({ kind: "speech", text: request.input, model: request.model });
  if (fault === "speech-primary-stall" && request.model === "gpt-4o-mini-tts") {
    await new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("synthetic speech abort signal missing"));
      if (signal.aborted) return reject(new DOMException("synthetic speech canceled", "AbortError"));
      signal.addEventListener("abort", () => reject(new DOMException("synthetic speech canceled", "AbortError")),
        { once: true });
    });
  }
  if (fault === "openai-speech") return new Response(null, { status: 503 });
  // Distinct PCM tones let signed tests distinguish the corrected response
  // from both greeting and provisional audio independently of IPC timing.
  const sample = request.input.startsWith("This is an Abby test call.") ? 1_000 :
    fault === "clear-playback-correction" &&
      request.input === "I couldn't understand that safely. Could you repeat your request, or contact the clinic directly?"
      ? 3_000 : 2_000;
  const audio = Buffer.alloc(960);
  for (let offset = 0; offset < audio.length; offset += 2) audio.writeInt16LE(sample, offset);
  return new Response(audio, { headers: { "content-type": "audio/pcm" } });
};

function syntheticClearTranscription(sessionId: string): TranscriptionPort {
  let turn = 0;
  return {
    async accept() { return ok([]); },
    async flush(generation) {
      turn += 1;
      return ok([{ kind: "segmentFinal", sessionId, generation, utteranceId: `fixture-${turn}`,
        text: fault === "clear-unsupported" ? "Please book my appointment tomorrow." :
          (fault === "clear-correction" || fault === "clear-playback-correction") && turn > 1 ?
            "Actually, please have the clinic contact me." :
            "Do you have availability tomorrow?", quality: "clear" }]);
    },
  };
}

const realtime = fault?.startsWith("speech-realtime") ? syntheticRealtimeSpeech(process.env.ABBY_OPENAI_API_KEY!,
  request => process.send?.({ kind: "speech", text: request.input, model: request.model, voice: request.voice })) : undefined;
if (fault === "speech-realtime-mismatch") realtime!.mismatch();
if (fault === "speech-realtime-stall") realtime!.hold();

await serveClinikoVoice({ clinikoFetch, openaiFetch,
  speechQuality: (scope, configurationHash) => scope.tenantId === process.env.ABBY_TENANT_ID &&
    scope.clinicId === process.env.ABBY_CLINIC_ID ? ok({ configurationHash, qualityVersion: "synthetic-runner.v1" })
      : err({ kind: "readinessFailed", missing: ["voiceProfile"] }),
  ...(fault === "speech-primary-stall" ? { speechModels: { primary: "gpt-4o-mini-tts",
    fallback: "tts-1", primaryFirstChunkMs: 100 } } : {}),
  ...(realtime ? { speechModels: { primary: "gpt-realtime-2.1-mini" }, speechSocketFactory: realtime.socketFactory } : {}),
  ...(clearTurn ? { transcriptionFactory: syntheticClearTranscription } : { transcriptionSocketFactory: () => {
    const socket = new SyntheticTranscriptionSocket();
    queueMicrotask(() => socket.open());
    return socket as unknown as WebSocket;
  } }) });
