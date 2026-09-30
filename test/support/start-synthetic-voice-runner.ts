import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { serveClinikoVoice } from "../../scripts/serve-cliniko-voice.ts";

if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
    process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5" ||
    process.env.ABBY_TWILIO_ACCOUNT_SID !== `AC${"1".repeat(32)}` ||
    !process.env.DATABASE_URL?.includes("/abby_test_voice_")) {
  throw new Error("synthetic voice runner requires an isolated fixture");
}

class SyntheticTranscriptionSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;

  send(): void { /* keypad test has no caller audio */ }
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

const clinikoFetch: typeof fetch = async input => {
  const url = new URL(String(input));
  if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: true,
    time_zone_identifier: "Australia/Sydney" });
  if (url.pathname === "/v1/practitioners/22") return Response.json({ id: "22", active: true,
    show_in_online_bookings: true });
  if (url.pathname === "/v1/appointment_types/33") return Response.json({ id: "33", show_in_online_bookings: true });
  if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1,
    practitioners: [{ id: "22" }] });
  if (url.pathname === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
    appointment_types: [{ id: "33" }] });
  if (url.pathname.endsWith("/available_times")) {
    const date = url.searchParams.get("from");
    return Response.json({ total_entries: 1,
      available_times: [{ appointment_start: `${date}T10:00:00+10:00`, appointment_id: "synthetic-only" }] });
  }
  throw new Error("unexpected Cliniko request");
};

const openaiFetch: typeof fetch = async input => {
  if (String(input) !== "https://api.openai.com/v1/audio/speech") {
    throw new Error("unexpected OpenAI request");
  }
  return new Response(Buffer.alloc(960), { headers: { "content-type": "audio/pcm" } });
};

await serveClinikoVoice({ clinikoFetch, openaiFetch, transcriptionSocketFactory: () => {
  const socket = new SyntheticTranscriptionSocket();
  queueMicrotask(() => socket.open());
  return socket as unknown as WebSocket;
} });
