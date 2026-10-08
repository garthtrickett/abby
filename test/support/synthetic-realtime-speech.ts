import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { OpenAIRealtimeSpeechSynthesisConfig } from "../../src/voice/openai-realtime-speech-synthesis.ts";

class SpeechSocket extends EventEmitter {
  readyState: 0 | 1 | 2 | 3 = 0;
  bufferedAmount = 0;
  closeCount = 0;
  session: any;
  private readonly requested: (socket: SpeechSocket, event: any) => void;
  constructor(requested: (socket: SpeechSocket, event: any) => void) { super(); this.requested = requested; }
  send(raw: string) {
    const event = JSON.parse(raw);
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      if (event.type === "session.update") { this.session = event.session; this.event({ type: "session.updated", session: event.session }); }
      else this.requested(this, event);
    });
  }
  event(value: object) { this.emit("message", Buffer.from(JSON.stringify(value))); }
  open() { this.readyState = 1; this.emit("open"); }
  terminate() { if (this.readyState === 3) return; this.closeCount++; this.readyState = 3; this.emit("close"); }
}

/** Patient-free provider protocol fixture. Response completion can be withheld from the actual caller transport. */
export function syntheticRealtimeSpeech(apiKey = "synthetic-profile-key", onRequest?: (request: { input: string; voice: string; model: string }) => void) {
  assert.ok(apiKey.startsWith("synthetic-"));
  const sockets: SpeechSocket[] = [];
  const requests: Array<{ input: string; voice: string; model: string }> = [];
  const completions: Array<(transcript?: string) => void> = [];
  let automatic = true, mismatch = false;
  const socketFactory: NonNullable<OpenAIRealtimeSpeechSynthesisConfig["socketFactory"]> = (url, headers) => {
    assert.equal(url, "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini");
    assert.deepEqual(headers, { Authorization: `Bearer ${apiKey}` });
    const socket = new SpeechSocket((current, event) => {
      assert.equal(event.type, "response.create");
      const response = event.response;
      assert.equal(response.conversation, "none");
      assert.deepEqual(response.tools, []); assert.equal(response.tool_choice, "none");
      const input = JSON.parse(response.input[0].content[0].text);
      assert.equal(typeof input, "string");
      assert.equal(current.session.model, "gpt-realtime-2.1-mini");
      const output = current.session.audio.output;
      assert.deepEqual(output.format, { type: "audio/pcm", rate: 24_000 });
      requests.push({ input, voice: output.voice, model: "gpt-realtime-2.1-mini" });
      onRequest?.(requests.at(-1)!);
      const fields = { response_id: "response-one", item_id: "item-one", output_index: 0, content_index: 0 };
      const transcript = mismatch ? "Different unapproved speech" : input;
      const item = { id: "item-one", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_audio", transcript }] };
      const completed = { id: "response-one", status: "completed", conversation_id: null,
        output_modalities: ["audio"], audio: { output }, output: [item] };
      const pcm = Buffer.alloc(1_922);
      for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(1_000, offset);
      for (const value of [
        { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
        { type: "response.output_item.added", ...fields, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", ...fields, part: { type: "audio", transcript: "" } },
        { type: "response.output_audio_transcript.delta", ...fields, delta: transcript },
        { type: "response.output_audio.delta", ...fields, delta: pcm.toString("base64") },
        { type: "response.output_audio.done", ...fields },
        { type: "response.output_audio_transcript.done", ...fields, transcript },
        { type: "response.content_part.done", ...fields, part: { type: "audio", transcript } },
        { type: "response.output_item.done", ...fields, item },
      ]) current.event(value);
      const complete = (finalTranscript?: string) => current.event({ type: "response.done", response: finalTranscript
        ? { ...completed, output: [{ ...item, content: [{ type: "output_audio", transcript: finalTranscript }] }] } : completed });
      completions.push(complete);
      if (automatic) complete();
    });
    sockets.push(socket); queueMicrotask(() => socket.open()); return socket;
  };
  return { socketFactory, requests, sockets, completions,
    hold: () => { automatic = false; }, automatic: () => { automatic = true; }, mismatch: () => { mismatch = true; } };
}
