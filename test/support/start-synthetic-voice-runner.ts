import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { serveClinikoVoice } from "../../scripts/serve-cliniko-voice.ts";

if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
    process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5" ||
    process.env.ABBY_TWILIO_ACCOUNT_SID !== `AC${"1".repeat(32)}` ||
    !process.env.DATABASE_URL?.includes("/abby_test_voice_") ||
    ![undefined, "openai-speech", "openai-transcription", "cliniko-rate-limit", "cliniko-timeout", "cliniko-partial-page", "cliniko-business-type-removed"].includes(process.env.ABBY_SYNTHETIC_VOICE_FAULT)) {
  throw new Error("synthetic voice runner requires an isolated fixture");
}
const fault = process.env.ABBY_SYNTHETIC_VOICE_FAULT;

class SyntheticTranscriptionSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  private failed = false;

  send(data: string): void {
    if (fault === "openai-transcription" && !this.failed && data.includes('"input_audio_buffer.append"')) {
      this.failed = true;
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ type: "error" }))));
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
  process.send?.({ kind: "clinikoMethod", method: init?.method, path: url.pathname });
  if (init?.method !== "GET") throw new Error("synthetic Cliniko write refused");
  if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", business_name: "Synthetic clinic",
    show_in_online_bookings: true, appointment_type_ids: [fault === "cliniko-business-type-removed" ? "44" : "33"],
    time_zone_identifier: "Australia/Sydney" });
  if (url.pathname === "/v1/practitioners/22") return Response.json({ id: "22", display_name: "Synthetic practitioner", active: true,
    show_in_online_bookings: true });
  if (url.pathname === "/v1/appointment_types/33") return Response.json({ id: "33", name: "Consult",
    show_in_online_bookings: true });
  if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1,
    practitioners: [{ id: "22" }] });
  if (url.pathname === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
    appointment_types: [{ id: "33" }] });
  if (url.pathname.endsWith("/available_times")) {
    if (fault === "cliniko-rate-limit") return new Response(null, { status: 429 });
    if (fault === "cliniko-timeout") throw new DOMException("synthetic timeout", "TimeoutError");
    const date = url.searchParams.get("from");
    if (fault === "cliniko-partial-page") return Response.json({ total_entries: 2,
      available_times: [{ appointment_start: `${date}T${url.searchParams.get("page") === "1" ? "10" : "11"}:00:00+10:00`,
        appointment_id: "synthetic-only" }] });
    return Response.json({ total_entries: 1,
      available_times: [{ appointment_start: `${date}T10:00:00+10:00`, appointment_id: "synthetic-only" }] });
  }
  throw new Error("unexpected Cliniko request");
};

const openaiFetch: typeof fetch = async (input, init) => {
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
