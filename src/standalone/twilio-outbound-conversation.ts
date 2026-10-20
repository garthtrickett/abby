import type { OutboundOriginalSend } from "../voice/outbound-original-send.ts";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { MemoryLedger } from "../core/ledger.ts";
import { err } from "../core/model.ts";
import type { AdmissionReceipt } from "../core/model.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import type { ModelKnowledgeContextHost } from "../core/host.ts";
import { prepareOutboundVoiceEntry } from "../voice/outbound-voice-entry.ts";
import type { OutboundConversationPolicySource } from "../voice/outbound-voice-entry.ts";
import type { SpeechAdapterFactory } from "../voice/call-speech-binding.ts";
import type { TwilioWireCall } from "../voice/twilio-media-sockets.ts";
import type { TwilioOutboundStream } from "../voice/twilio-outbound-ingress.ts";
import { TwilioAbbyOutboundRuntime } from "../voice/twilio-outbound-runtime.ts";
import { TwilioConnectedCall } from "../voice/twilio-connected-call.ts";
import type { TwilioConnectedCallConfig } from "../voice/twilio-connected-call.ts";
import type { PlaybackPort, VoiceSession } from "../voice/voice-session.ts";
import { TwilioOutboundStopSpeech } from "./twilio-outbound-stop-speech.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { callIdFor } from "../voice/admission.ts";
import type { OutboundConversationCall } from "../voice/outbound-voice-entry.ts";
import type { PreparedVoiceSession } from "../voice/reception-voice-call.ts";
import type { PrivateKeypadInput } from "../voice/private-keypad-input.ts";

type OutboundSessionFactory = (ledger: MemoryLedger, receipt: AdmissionReceipt, sessionId: string, playback: PlaybackPort,
  signal: AbortSignal, original: OutboundOriginalSend) => VoiceSession;
export type OutboundVoicePreparation = Readonly<{
  ledger: MemoryLedger; call: OutboundConversationCall; sessionId: string;
  /** Private routing evidence only, never patient proof. */
  original: OutboundOriginalSend; signal: AbortSignal;
}>;

export type TwilioAbbyOutboundConversationConfig = Readonly<{
  runtime: TwilioAbbyOutboundRuntime;
  source: OutboundConversationPolicySource;
  /** Physical model/runtime configuration selected by this trusted host. */
  runtimeConfigurationHash: string;
  speech: SpeechAdapterFactory;
  stopSpeech?: TwilioOutboundStopSpeech;
  readiness: AutomationReadiness;
  knowledge?: ModelKnowledgeContextHost;
  now?: () => string;
  monotonicNow?: () => number;
  mediaOptions?: TwilioConnectedCallConfig["mediaOptions"];
  playbackOptions?: TwilioConnectedCallConfig["playbackOptions"];
}> & (Readonly<{ session: OutboundSessionFactory; prepareSession?: never }> | Readonly<{
  session?: never;
  /** Existing ingress startup cancellation bounds preparation. A late result is
   * retired; this does not extend the wire deadline or grant clinical authority. */
  prepareSession: (context: OutboundVoicePreparation) => Promise<PreparedVoiceSession>;
}>);
/** Explicit optional ingress factory. The signed ingress owns authentication and
 * the permanent session exclusion; this owns one transient Abby conversation.
 * It provides no complete final report or contact/capacity release authority. */
export function twilioAbbyOutboundConversation(config: TwilioAbbyOutboundConversationConfig):
  (stream: TwilioOutboundStream, send: (json: string) => "queued" | "notSent" | "uncertain",
    close: (kind?: "normal" | "failure") => void, signal: AbortSignal) => Promise<TwilioWireCall> {
  if (!(config.runtime instanceof TwilioAbbyOutboundRuntime) || !/^[a-f0-9]{64}$/.test(config.runtimeConfigurationHash) ||
      typeof config.source?.read !== "function" || typeof config.source.current !== "function" ||
      typeof config.speech?.create !== "function" ||
      !(typeof config.session === "function" && !Object.hasOwn(config, "prepareSession") ||
        typeof config.prepareSession === "function" && !Object.hasOwn(config, "session")) ||
      config.stopSpeech !== undefined && (!(config.stopSpeech instanceof TwilioOutboundStopSpeech) || !config.stopSpeech.matchesRuntime(config.runtime)))
    throw Error("Invalid outbound conversation configuration");
  const provider = Object.freeze({ ...config.runtime.binding() }), now = config.now ?? (() => new Date().toISOString());
  const runtimeConfigurationHash = config.runtimeConfigurationHash, readiness = config.readiness;
  const readApproval = config.source.read.bind(config.source), currentApproval = config.source.current.bind(config.source);
  const createSpeech = config.speech.create.bind(config.speech), createSession = config.session?.bind(config);
  const prepareSession = config.prepareSession?.bind(config);
  const stopBinding = config.stopSpeech?.profileBinding(), stopCurrent = config.stopSpeech?.matchesRuntime.bind(config.stopSpeech);
  const bindStop = config.stopSpeech?.bindPolicy.bind(config.stopSpeech), selectedRuntime = config.runtime;
  const settings = structuredClone({ ...(config.mediaOptions ? { mediaOptions: config.mediaOptions } : {}),
    ...(config.playbackOptions ? { playbackOptions: config.playbackOptions } : {}) });
  const source: OutboundConversationPolicySource = {
    read: async (call, signal) => {
      const loaded = await readApproval(call, signal);
      return loaded.ok && (loaded.value.runtimeConfigurationHash !== runtimeConfigurationHash || loaded.value.stopSpeechBinding !== stopBinding ||
        stopCurrent?.(selectedRuntime) === false ||
        !isDeepStrictEqual({ mediaOptions: loaded.value.mediaOptions ?? {}, playbackOptions: loaded.value.playbackOptions ?? {} },
          { mediaOptions: settings.mediaOptions ?? {}, playbackOptions: settings.playbackOptions ?? {} }))
        ? err({ kind: "unavailable" }) : loaded;
    },
    current: (call, approval) => approval.runtimeConfigurationHash === runtimeConfigurationHash && approval.stopSpeechBinding === stopBinding &&
      stopCurrent?.(selectedRuntime) !== false && currentApproval(call, approval),
  };
  return async (stream, send, close, ingressSignal) => {
    const lifetime = new AbortController(), signal = AbortSignal.any([ingressSignal, lifetime.signal]);
    const ledger = new MemoryLedger(readiness);
    let candidate: PreparedVoiceSession | undefined, privateInput: PrivateKeypadInput | undefined;
    let abandoned = false, inputTransferred = false, inputStopped = false;
    const discardInput = () => {
      if (!privateInput || inputStopped) return;
      inputStopped = true;
      try { privateInput.stop(); } catch { /* Failure must still retire the call. */ }
    };
    try {
      const original = stream.call.context.original.attempt;
      if (original.provider.ref !== provider.ref || original.provider.bindingDigest !== provider.bindingDigest || signal.aborted)
        throw Error("Outbound conversation unavailable");
      const prepared = await prepareOutboundVoiceEntry({ call: { key: { accountRef: stream.call.accountSid, providerCallRef: stream.call.callSid },
        scope: original.scope, clinicNumber: stream.call.clinicNumber, profileRef: provider.profileRef }, ledger, source,
        readiness, now, signal, ...(config.knowledge ? { knowledge: config.knowledge } : {}) });
      if (!prepared.ok) throw Error("Outbound conversation unavailable");
      const entry = prepared.value, current = () => !signal.aborted && entry.current?.() === true;
      const sessionId = randomUUID();
      if (prepareSession) {
        const context: OutboundVoicePreparation = Object.freeze({ ledger, sessionId, signal,
          call: Object.freeze({ key: Object.freeze({ ...entry.key }), scope: Object.freeze({ ...original.scope }),
            clinicNumber: stream.call.clinicNumber, profileRef: provider.profileRef }), original: stream.call.context.original });
        const pending = Promise.resolve().then(() => current() ? prepareSession(context) : undefined).then(value => {
          privateInput = value?.privateKeypadInput;
          if (!value || typeof value.create !== "function" ||
              Object.keys(value).some(key => key !== "create" && key !== "privateKeypadInput")) { discardInput(); return undefined; }
          candidate = Object.freeze({ create: value.create.bind(value), ...(privateInput ? { privateKeypadInput: privateInput } : {}) });
          if (abandoned || signal.aborted) discardInput();
          return candidate;
        });
        const result = await awaitUntilAbort(pending, signal);
        if (!result || !current()) { abandoned = true; discardInput(); throw Error("Outbound conversation unavailable"); }
        candidate = result;
      } else {
        candidate = { create: (receipt, id, playback) => createSession!(ledger, receipt, id, playback, signal, stream.call.context.original) };
      }
      const sessionFactory = candidate.create;
      const speech: SpeechAdapterFactory = { create(profile, sessionId, runtime) {
        if (!current()) return err({ kind: "readinessFailed", missing: ["voiceProfile"] });
        const created = createSpeech(profile, sessionId, runtime);
        if (!created.ok) return created;
        const ports = created.value;
        return { ok: true, value: { profile: ports.profile,
          synthesis: { async *stream(text, abort) {
            if (!current()) throw Error("Outbound conversation unavailable");
            for await (const chunk of ports.synthesis.stream(text, abort)) {
              if (!current()) throw Error("Outbound conversation unavailable");
              yield chunk;
            }
          } },
          transcription: {
            accept: async (frame, generation, abort) => {
              if (!current() || abort.aborted) return err({ kind: "transcriptionUnavailable" });
              const result = await ports.transcription.accept(frame, generation, abort);
              return current() && !abort.aborted ? result : err({ kind: "transcriptionUnavailable" });
            },
            flush: async (generation, abort) => {
              if (!current() || abort.aborted) return err({ kind: "transcriptionUnavailable" });
              const result = await ports.transcription.flush(generation, abort);
              return current() && !abort.aborted ? result : err({ kind: "transcriptionUnavailable" });
            },
            cancel: async generation => { await ports.transcription.cancel?.(generation); },
            close: async () => { await ports.transcription.close?.(); },
          },
        } };
      } };
      const call = new TwilioConnectedCall({ entry, sessionId, ledger, speech,
        ...(candidate.privateKeypadInput ? { privateKeypadInput: candidate.privateKeypadInput } : {}),
        fullFactory: (receipt, sessionId, playback) => {
          if (!current() || receipt.callId !== callIdFor(entry.key)) throw Error("Outbound conversation unavailable");
          const session = sessionFactory(receipt, sessionId, playback);
          if (bindStop) session.protectOutboundContact(bindStop(stream, receipt, sessionId, () => close("normal")));
          return session;
        },
        streamStartedAt: stream.streamStartedAt, now, ...settings,
        ...(config.monotonicNow ? { monotonicNow: config.monotonicNow } : {}),
        send: json => current() ? send(json) : "notSent", closeTransport: close, onCallStop: () => lifetime.abort() });
      inputTransferred = true;
      let cleanup: Promise<unknown> | undefined;
      const disconnect = () => {
        ingressSignal.removeEventListener("abort", onAbort);
        cleanup ??= call.disconnect().finally(() => { lifetime.abort(); ledger.dispose(); });
        return cleanup;
      };
      const onAbort = () => { void disconnect().catch(() => undefined); };
      ingressSignal.addEventListener("abort", onAbort, { once: true });
      if (ingressSignal.aborted) { await disconnect(); throw Error("Outbound conversation unavailable"); }
      return { receive: raw => call.receive(raw), disconnect };
    } catch {
      abandoned = true; lifetime.abort();
      if (!inputTransferred) discardInput();
      ledger.dispose(); throw Error("Outbound conversation unavailable");
    }
  };
}
