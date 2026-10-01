import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { serveClinikoVoice } from "../../scripts/serve-cliniko-voice.ts";

if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
    process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5" ||
    process.env.ABBY_TWILIO_ACCOUNT_SID !== `AC${"1".repeat(32)}` ||
    !process.env.DATABASE_URL?.includes("/abby_test_voice_") ||
    ![undefined, "openai-speech", "openai-transcription", "untrusted-transcript", "cliniko-rate-limit", "cliniko-server-error", "cliniko-timeout", "cliniko-partial-page", "cliniko-business-type-removed", "cliniko-practitioner-type-removed", "week-alternative",
      "practitioner-alternative", "practitioner-alternative-rate-limit",
      "practitioner-alternative-malformed", "practitioner-alternative-second"].includes(process.env.ABBY_SYNTHETIC_VOICE_FAULT)) {
  throw new Error("synthetic voice runner requires an isolated fixture");
}
const fault = process.env.ABBY_SYNTHETIC_VOICE_FAULT;
const alternativeFault = fault === "practitioner-alternative" ||
  fault === "practitioner-alternative-rate-limit" || fault === "practitioner-alternative-malformed" ||
  fault === "practitioner-alternative-second";

class SyntheticTranscriptionSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  private failed = false;
  private committed = 0;

  send(data: string): void {
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
    this.emit("message", Buffer.from(JSON.stringify({ type: "session.updated", session: {
      type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 },
        transcription: { model: "gpt-live-transcribe" }, turn_detection: null } },
    } })));
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
    time_zone_identifier: "Australia/Sydney" });
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
    if (fault === "cliniko-rate-limit") return new Response(null, { status: 429 });
    if (fault === "cliniko-server-error") return new Response(null, { status: 503 });
    if (fault === "cliniko-timeout") throw new DOMException("synthetic timeout", "TimeoutError");
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
  if (String(input) === "https://api.openai.com/v1/responses" && fault === "untrusted-transcript") {
    process.send?.({ kind: "intentModelRequest" });
    return new Response(null, { status: 503 });
  }
  if (String(input) !== "https://api.openai.com/v1/audio/speech") {
    throw new Error("unexpected OpenAI request");
  }
  const request = JSON.parse(String(init?.body)) as { input?: unknown };
  if (typeof request.input !== "string") throw new Error("invalid synthetic speech request");
  process.send?.({ kind: "speech", text: request.input });
  if (fault === "openai-speech") return new Response(null, { status: 503 });
  return new Response(Buffer.alloc(960), { headers: { "content-type": "audio/pcm" } });
};

await serveClinikoVoice({ clinikoFetch, openaiFetch, transcriptionSocketFactory: () => {
  const socket = new SyntheticTranscriptionSocket();
  queueMicrotask(() => socket.open());
  return socket as unknown as WebSocket;
} });
