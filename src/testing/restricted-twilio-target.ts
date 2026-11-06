import { randomUUID } from "node:crypto";
import { ok, err } from "../core/model.ts";
import { createTwilioIngressServer } from "../voice/twilio-ingress-server.ts";
import type { ActiveCallClaims } from "../voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../voice/twilio-signed-ingress.ts";
import type { TwilioSignedIngressConfig, SignedTwilioWebhook } from "../voice/twilio-signed-ingress.ts";
import { TwilioMediaStream } from "../voice/twilio-media-stream.ts";
import { MediaTurnController } from "../voice/media-turn-controller.ts";
import type { MediaFailure, MediaTurnTarget, TranscriptionPort } from "../voice/media-turn-controller.ts";
import { StreamedPlaybackPort } from "../voice/streamed-playback-port.ts";
import type { SpeechSynthesisPort } from "../voice/streamed-playback-port.ts";
import { TurnAssembler } from "../voice/turn-assembler.ts";
import type { TranscriptFailure } from "../voice/turn-assembler.ts";

type FailureStage = "none" | "decode" | "media" | "synthesis" | "clear" | "duration";
type TargetFailure = TranscriptFailure | Readonly<{ kind: "sessionClosed" | "outputUnavailable" }>;
export type RehearsalCallStatistics = Readonly<{
  session: number; callSid: string; started: boolean; turns: number; repliesQueued: number;
  played: number; interruptions: number; clearAcknowledged: number; dtmfFallback: boolean;
  stopped: boolean; failed: boolean; failureStage: FailureStage;
  mediaFailureKind?: MediaFailure["kind"] | TargetFailure["kind"];
  active: number; total: number; expiresAt: string;
}>;
export type RestrictedTargetConfig = Readonly<{
  testMode: true; ingress: TwilioSignedIngressConfig; number: string; caller: string;
  endAt: number; activeCallClaims: ActiveCallClaims; fallbackCallback?: string; now?: () => number;
}>;
export type RehearsalSpeech = Readonly<{
  transcription(sessionId: string): TranscriptionPort;
  synthesis: SpeechSynthesisPort;
}>;

const greeting = "Hello, this is Abby, an AI voice, in a phone audio test. No clinic services are active. " +
  "Please use test phrases only. Say hello, say blue or green, or ask me to count and interrupt me. " +
  "Press nine to test the fallback phone. Hang up to end the call.";
const phone = /^\+[1-9]\d{7,14}$/;

function responseFor(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z ]/g, " ").trim().split(/ +/);
  if (words.length > 12) return "This is an audio test only. Please say hello, blue, green, or count.";
  if (words.some(word => word === "count" || word === "counting")) return "I will count slowly. " +
    "Interrupt me by saying hello. One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. " +
    "Eleven. Twelve. Thirteen. Fourteen. Fifteen. Sixteen. Seventeen. Eighteen. Nineteen. Twenty.";
  if (words.includes("hello") || words.includes("hi")) return "Hello. I heard your test greeting. " +
    "You can say blue or green, ask me to count, or press nine to test fallback ringing.";
  if (words.includes("blue")) return "I heard the test word blue. You can now say green, ask me to count, or hang up.";
  if (words.includes("green")) return "I heard the test word green. You can now say blue, ask me to count, or hang up.";
  if (words.includes("bye") || words.includes("goodbye")) return "Thanks for testing. Please hang up now. " +
    "To test fallback ringing instead, press nine.";
  return "This is an audio test only. Please say hello, blue, green, or count. Press nine for the fallback phone.";
}

/** Test-only decoration of authenticated TwiML; changed upstream format refuses. */
class RehearsalIngress extends TwilioSignedIngress {
  private readonly number: string;
  private readonly fallback: string;
  private readonly callback: string | undefined;

  constructor(config: RestrictedTargetConfig) {
    super(config.ingress);
    this.number = config.number;
    this.fallback = config.ingress.fallbackNumbers[config.number]!;
    this.callback = config.fallbackCallback;
    if (this.callback) {
      const url = new URL(this.callback);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
          !/^\/fallback-ringing\/[a-f0-9]{32}$/.test(url.pathname)) throw new RangeError("invalid rehearsal callback");
    }
  }

  override authenticateWebhook(request: SignedTwilioWebhook) {
    const result = super.authenticateWebhook(request);
    if (!result.ok || !this.callback || result.value.event.dialedNumber !== this.number) return result;
    const prior = `<Dial>${this.fallback}</Dial>`;
    if (result.value.twiml.split(prior).length !== 2) return err({ kind: "invalidTwilioRequest" as const });
    const observed = `<Dial><Number statusCallback="${this.callback}" statusCallbackMethod="POST" ` +
      `statusCallbackEvent="initiated ringing answered completed">${this.fallback}</Number></Dial>`;
    return ok({ ...result.value, twiml: result.value.twiml.replace(prior, observed) });
  }
}

/** Fixed public dialogue over the real signed transport. No clinic host or tools. */
export function createRestrictedTwilioTarget(config: RestrictedTargetConfig, providers: RehearsalSpeech,
  report: (statistics: RehearsalCallStatistics) => void = () => {}) {
  const now = config.now ?? Date.now;
  const fallbacks = Object.entries(config.ingress.fallbackNumbers);
  if (config.testMode !== true || !phone.test(config.number) || !phone.test(config.caller) ||
      config.number === config.caller || fallbacks.length !== 1 || fallbacks[0]?.[0] !== config.number ||
      fallbacks[0]?.[1] === config.caller || !Number.isFinite(config.endAt) || config.endAt <= now() ||
      config.endAt > now() + 7_200_000 || typeof config.activeCallClaims?.claim !== "function") {
    throw new RangeError("invalid restricted rehearsal configuration");
  }
  let active = 0, total = 0, closed = false;
  let cleanupFailed = false, stopping: Promise<void> | undefined;
  const settling = new Set<Promise<void>>();
  function track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(() => {}, () => { cleanupFailed = true; })
      .finally(() => settling.delete(settled));
    settling.add(settled);
    return operation;
  }
  const activeCallClaims: ActiveCallClaims = {
    async claim(account, call) {
      if (closed) return undefined;
      return track(Promise.resolve().then(() => config.activeCallClaims.claim(account, call)).then(lease => {
        if (!lease) return undefined;
        let released: Promise<void> | undefined;
        let finish!: () => void;
        // Keep ownership visible even while an in-flight claim finishes after
        // the HTTP listener closes. The transport still owns when to release it.
        track(new Promise<void>(resolve => { finish = resolve; }));
        return { lost: lease.lost, release: () => released ??= track(
          Promise.resolve().then(() => lease.release()).finally(finish)) };
      }));
    },
  };
  const seen = new Set<string>();
  const within = () => !closed && now() < config.endAt;
  const state = () => ({ active, total, windowOpen: within(), expiresAt: new Date(config.endAt).toISOString() });
  const server = createTwilioIngressServer({
    ingress: new RehearsalIngress(config), activeCallClaims, health: async () => true,
    admitWebhook: async event => Boolean(event && within() && total < 6 && active === 0 &&
      event.dialedNumber === config.number && event.presentedCallerNumber === config.caller &&
      !seen.has(event.key.providerCallRef)),
    async createCall(auth, send, close) {
      if (!within() || active !== 0 || total >= 6 || seen.has(auth.event.key.providerCallRef)) {
        throw new Error("rehearsal admission closed");
      }
      seen.add(auth.event.key.providerCallRef); total++;
      const stats = { session: total, callSid: auth.event.key.providerCallRef, started: false, turns: 0,
        repliesQueued: 0, played: 0, interruptions: 0, clearAcknowledged: 0,
        dtmfFallback: false, stopped: false, failed: false, failureStage: "none" as FailureStage,
        mediaFailureKind: undefined as MediaFailure["kind"] | TargetFailure["kind"] | undefined };
      const emit = () => {
        // A reporting failure cannot change audio/playback truth. The caller
        // must independently require fresh complete evidence before claiming a pass.
        try { report({ ...stats, active, total, expiresAt: state().expiresAt }); } catch { /* observer unavailable */ }
      };
      const sessionId = randomUUID();
      let transcription: TranscriptionPort;
      try { transcription = providers.transcription(sessionId); }
      catch { stats.failed = true; stats.failureStage = "media";
        stats.mediaFailureKind = "transcriptionUnavailable"; emit(); throw new Error("rehearsal speech unavailable"); }
      active++;
      const stream = new TwilioMediaStream({ accountSid: auth.event.key.accountRef,
        callSid: auth.event.key.providerCallRef, sessionId, startedAt: auth.streamStartedAt, send });
      const playback = new StreamedPlaybackPort(providers.synthesis, stream, { firstChunkDeadlineMs: 5_000 });
      const assembler = new TurnAssembler(auth.event.key.providerCallRef, sessionId, "carrier-diagnostic");
      let done = false, epoch = 0, replyNumber = 0;
      let current: string | undefined;
      let duration: ReturnType<typeof setTimeout> | undefined;
      const pending = new Set<Promise<unknown>>();
      function background(promise: Promise<unknown>) {
        pending.add(promise);
        void promise.finally(() => pending.delete(promise)).catch(() => {});
      }
      let cleanupPromise: Promise<void> | undefined;
      function cleanup(): Promise<void> {
        return cleanupPromise ??= track((async () => {
          done = true; epoch++; clearTimeout(duration); stream.close();
          try { await media.stop(); await Promise.allSettled([...pending]); }
          finally { active--; emit(); }
        })());
      }
      function fail(stage: FailureStage) {
        if (done) return;
        stats.failureStage = stage; stats.failed = true; emit(); close("failure"); void cleanup();
      }
      function say(text: string) {
        const expected = epoch, id = `rehearsal-${++replyNumber}`; current = id;
        background(playback.enqueue(id, text, () => !done && epoch === expected && current === id).then(result => {
          if (done || epoch !== expected) return;
          if (result !== "queued") { fail("synthesis"); return; }
          stats.repliesQueued++; emit();
        }).catch(() => fail("synthesis")));
      }
      const target: MediaTurnTarget<void, TargetFailure> = {
        async speechStarted() {
          epoch++; const prior = current; current = undefined;
          if (prior) {
            stats.interruptions++;
            if (!await playback.clear(prior)) { fail("clear"); return err({ kind: "outputUnavailable" }); }
            stats.clearAcknowledged++; emit();
          }
          return done ? err({ kind: "sessionClosed" }) : ok(assembler.beginSpeech());
        },
        acceptTranscript: event => assembler.accept(event),
        async finishTurn(at) {
          const result = assembler.finish(at);
          if (!result.ok) return result;
          stats.turns++; emit(); say(responseFor(result.value.text)); return ok(undefined);
        },
      };
      const media = new MediaTurnController(sessionId, target, transcription);
      duration = setTimeout(() => fail("duration"), Math.min(180_000, config.endAt - now()));
      emit();
      return {
        async receive(raw: string) {
          if (done) return err({ kind: "sessionClosed" });
          const result = stream.receive(raw);
          if (!result.ok) { fail("decode"); return result; }
          const event = result.value;
          if (event.kind === "started") { stats.started = true; emit(); say(greeting); }
          else if (event.kind === "media") {
            media.observePendingCorrection(event.frame);
            if (!media.consumePendingSilence(event.frame)) {
              const progressed = await media.acceptMedia(event.frame);
              if (!progressed.ok) { stats.mediaFailureKind = progressed.error.kind; fail("media"); return progressed; }
            }
          } else if (event.kind === "played") {
            const completed = await playback.acceptCompletion(event.completion, async () => true);
            if (completed.ok) {
              stats.played++; if (current === event.completion.playbackId) current = undefined; emit();
            }
          } else if (event.kind === "dtmf" && event.digit === "9") {
            stats.dtmfFallback = true; emit(); close("failure"); void cleanup();
          } else if (event.kind === "stopped") { stats.stopped = true; emit(); void cleanup(); }
          return ok(undefined);
        },
        disconnect: cleanup,
      };
    },
  });
  return { server, state, stop: (): Promise<void> => {
    closed = true;
    return stopping ??= (async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      // Claim completion can register its eventual release while shutdown is
      // waiting, so drain successive sets rather than taking one early snapshot.
      while (settling.size) await Promise.all([...settling]);
      if (cleanupFailed) throw new Error("rehearsal cleanup unavailable");
    })();
  } };
}
