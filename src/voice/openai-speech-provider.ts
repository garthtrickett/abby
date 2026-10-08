import { OpenAISpeechSynthesis } from "./openai-speech-synthesis.ts";
import { OpenAIRealtimeSpeechSynthesis } from "./openai-realtime-speech-synthesis.ts";
import type { OpenAIRealtimeSpeechSynthesisConfig } from "./openai-realtime-speech-synthesis.ts";
import type { SpeechSynthesisPort } from "./streamed-playback-port.ts";

export const realtimeSpeechModel = "gpt-realtime-2.1-mini";
const allVoices = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];
const olderVoices = ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"];
const realtimeVoices = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];

export type OpenAISpeechProviderConfig = Readonly<{
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  speechSocketFactory?: OpenAIRealtimeSpeechSynthesisConfig["socketFactory"];
}>;

/** Selects the physical adapter for both catalogue declarations and actual calls. No network on construction. */
export class OpenAISpeechProvider {
  private readonly config: OpenAISpeechProviderConfig;
  readonly voices: readonly string[];
  constructor(config: OpenAISpeechProviderConfig) {
    this.config = { ...config };
    this.voices = Object.freeze([...(config.model === realtimeSpeechModel ? realtimeVoices
      : ["gpt-4o-mini-tts", "gpt-4o-mini-tts-2025-12-15"].includes(config.model) ? allVoices
      : ["tts-1", "tts-1-hd"].includes(config.model) ? olderVoices : [])]);
    this.create(); // Validate the selected provider before a listener or catalogue becomes available.
  }
  create(voice?: string): SpeechSynthesisPort {
    return this.config.model === realtimeSpeechModel
      ? new OpenAIRealtimeSpeechSynthesis({ apiKey: this.config.apiKey, ...(voice ? { voice } : {}),
        ...(this.config.speechSocketFactory ? { socketFactory: this.config.speechSocketFactory } : {}) })
      : new OpenAISpeechSynthesis({ apiKey: this.config.apiKey, model: this.config.model, ...(voice ? { voice } : {}),
        ...(this.config.fetch ? { fetchPort: this.config.fetch } : {}) });
  }
  /** Versioned contract of the selected adapter; changes to this contract need new quality evidence. */
  descriptor() {
    return this.config.model === realtimeSpeechModel
      ? { model: this.config.model, transport: "realtime-websocket", adapterVersion: "realtime-literal.v1",
        providerFormat: { type: "audio/pcm", rate: 24_000 }, playbackRate: 16_000,
        validation: "completed-provider-transcript-literal.v1", release: "whole-utterance",
        conversation: "none", tools: "none", deadlineMs: 20_000, maxAudioBytes: 960_000 }
      : { model: this.config.model, transport: "audio-speech-http", adapterVersion: "openai-speech.v1",
        responseFormat: "pcm", streamFormat: "audio", providerRate: 24_000, playbackRate: 16_000 };
  }
}
