import type { RehearsalCallStatistics } from "./restricted-twilio-target.ts";
import type { TwilioVoiceRehearsal, RehearsalScenario } from "./twilio-voice-rehearsal.ts";
import type { TwilioRehearsalFallback } from "./twilio-rehearsal-fallback.ts";

export type RehearsalTargetSnapshot = Readonly<{
  runId: string; at: number; expiresAt: number; active: number; total: number;
  latest: RehearsalCallStatistics | null;
}>;
export type RehearsalObservedCall = Readonly<{
  sid: string; accountSid: string; from: string; to: string; direction: string;
  status: string; parentCallSid: string | null; startTime: Date | null;
}>;
const sid = /^CA[0-9a-f]{32}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;

/** Reconstruct an allowlisted snapshot. Unknown input fields never enter a
 * receipt, and a listening report never supplies clinical/speech acceptance. */
export function rehearsalTargetSnapshot(value: unknown, now: number): RehearsalTargetSnapshot {
  if (!record(value) || value.phase !== "listening" || typeof value.runId !== "string" ||
      !/^[a-f0-9]{32}$/.test(value.runId) || typeof value.at !== "string" ||
      typeof value.expiresAt !== "string" || value.windowOpen !== true ||
      value.clinicalAutomationEnabled !== false || value.audioOrTranscriptPersisted !== false ||
      value.speechQualificationPassed !== false || !count(value.active, 1) || !count(value.total, 6))
    throw Error("Restricted target observation unavailable");
  const at = Date.parse(value.at), expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(at) || !Number.isFinite(expiresAt) ||
      at > now || at >= expiresAt || expiresAt <= now || expiresAt > now + 7_200_000)
    throw Error("Restricted target observation unavailable");
  let latest: RehearsalCallStatistics | null = null;
  if (value.latest !== null) {
    const x = value.latest;
    if (!record(x) || !count(x.session, 6) || x.session < 1 || x.session !== value.total ||
        typeof x.callSid !== "string" || !sid.test(x.callSid) ||
        ![x.started, x.dtmfFallback, x.stopped, x.failed].every(v => typeof v === "boolean") ||
        x.failureStage !== "none" || x.expiresAt !== value.expiresAt ||
        x.active !== value.active || x.total !== value.total || !count(x.turns, 100) ||
        !count(x.repliesQueued, 100) || !count(x.played, 100) || !count(x.interruptions, 100) ||
        !count(x.clearAcknowledged, 100)) throw Error("Restricted target observation unavailable");
    latest = { session: x.session, callSid: x.callSid, started: x.started as boolean,
      turns: x.turns, repliesQueued: x.repliesQueued, played: x.played, interruptions: x.interruptions,
      clearAcknowledged: x.clearAcknowledged, dtmfFallback: x.dtmfFallback as boolean,
      stopped: x.stopped as boolean, failed: x.failed as boolean, failureStage: "none",
      active: value.active, total: value.total, expiresAt: value.expiresAt };
  } else if (value.total !== 0 || value.active !== 0) throw Error("Restricted target observation unavailable");
  return { runId: value.runId, at, expiresAt, active: value.active, total: value.total, latest };
}

/** Combine caller, target and complete exact-parent provider observations.
 * Incomplete reads, extra legs and cross-run reports cannot become a pass. */
export function qualifyRehearsalObservation(config: Readonly<{
  accountSid: string; caller: string; number: string; fallback: string; scenario: RehearsalScenario;
}>, evidence: Readonly<{
  callerSid: string; launchedAt: number; now: number;
  caller: ReturnType<TwilioVoiceRehearsal["summary"]>;
  before: RehearsalTargetSnapshot; after: RehearsalTargetSnapshot;
  target: RehearsalObservedCall;
  children: Readonly<{ complete: boolean; calls: readonly RehearsalObservedCall[] }>;
  fallbackEvents?: TwilioRehearsalFallback;
}>) {
  const { before, after, target, caller, children } = evidence, stats = after.latest;
  const expectedScenario = config.scenario === "dialogue" ? "restricted-audio-dialogue-v1" :
    config.scenario === "interruption" ? "restricted-interruption-v1" : "restricted-fallback-v1";
  const shared = sid.test(evidence.callerSid) && Number.isFinite(evidence.launchedAt) &&
    Number.isFinite(evidence.now) && evidence.launchedAt <= evidence.now &&
    evidence.now - evidence.launchedAt <= 240_000 && evidence.now - after.at <= 60_000 &&
    before.at <= evidence.launchedAt && after.at >= evidence.launchedAt && after.at <= evidence.now &&
    before.expiresAt > evidence.launchedAt && after.expiresAt > evidence.now &&
    before.expiresAt === after.expiresAt && before.runId === after.runId &&
    before.active === 0 && before.total < 6 && after.active === 0 && after.total === before.total + 1 &&
    stats?.session === after.total && stats.started && !stats.failed && stats.failureStage === "none" &&
    stats.callSid !== evidence.callerSid && target.sid === stats.callSid && sid.test(target.sid) &&
    target.accountSid === config.accountSid && target.from === config.caller && target.to === config.number &&
    target.direction === "inbound" && target.status === "completed" &&
    target.startTime instanceof Date && target.startTime.getTime() >= evidence.launchedAt - 1_000 &&
    target.startTime.getTime() <= after.at && caller.scenario === expectedScenario &&
    !caller.failed && caller.providerTerminal === "completed" && children.complete;
  let passed = false;
  if (shared && stats) {
    if (config.scenario === "fallback") {
      const child = children.calls.length === 1 ? children.calls[0] : undefined;
      passed = stats.dtmfFallback && stats.turns === 0 && stats.played === 1 &&
        stats.interruptions === 0 && stats.clearAcknowledged === 0 && child !== undefined &&
        sid.test(child.sid) && child.sid !== target.sid && child.sid !== evidence.callerSid &&
        child.accountSid === config.accountSid && child.parentCallSid === target.sid &&
        child.to === config.fallback && child.direction === "outbound-dial" &&
        ["completed", "busy", "failed", "no-answer", "canceled"].includes(child.status) &&
        evidence.fallbackEvents?.ringing(child.sid) === true;
    } else {
      passed = caller.scriptMatched && stats.stopped && !stats.dtmfFallback && children.calls.length === 0 &&
        (config.scenario === "dialogue" ? caller.carrierDialoguePassed && stats.turns === 3 && stats.played === 4 &&
          stats.interruptions === 0 && stats.clearAcknowledged === 0 :
          stats.turns === 2 && stats.played === 2 && stats.interruptions === 1 && stats.clearAcknowledged === 1);
    }
  }
  return { scenario: expectedScenario, carrierScenarioPassed: passed,
    interruption: config.scenario === "interruption" ? passed ? "passed" : "unverified" : "notRun",
    fallbackRinging: config.scenario === "fallback" ? passed ? "passed" : "unverified" : "notRun",
    normalHangupNoFallback: config.scenario !== "fallback" && passed ? "passed" : "unverified",
    clinicalAcceptance: false, speechQualificationPassed: false, audioOrTranscriptPersisted: false } as const;
}
