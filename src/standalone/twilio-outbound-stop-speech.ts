import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, FinalCallerTurn, Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { checkClinikoHeadroom, clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { outboundConfigShard } from "../cliniko/internal/outbound-record-context.ts";
import { outboundDncRecordBinding } from "../cliniko/outbound-dnc-records.ts";
import { outboundLaunchAttemptDigest } from "../cliniko/outbound-launch-attempt.ts";
import { validRecallMarker } from "../cliniko/recall-note.ts";
import { ClinikoTwilioOutboundReportRecords, twilioOutboundReportRecordBinding } from "../cliniko/twilio-outbound-report-records.ts";
import type { TwilioOutboundReportConfig, TwilioOutboundReportWriteAuthority } from "../cliniko/twilio-outbound-report-records.ts";
import { TwilioOutboundReportAuthentication } from "../cliniko/twilio-outbound-report.ts";
import type { TwilioOutboundReport } from "../cliniko/twilio-outbound-report.ts";
import type { OutboundContactStopPolicy } from "../voice/outbound-contact-stop.ts";
import { callIdFor } from "../voice/admission.ts";
import { TwilioAbbyOutboundRuntime } from "../voice/twilio-outbound-runtime.ts";
import type { TwilioOutboundStream } from "../voice/twilio-outbound-ingress.ts";
import { ClinikoTwilioOutboundStopRecovery } from "./cliniko-twilio-outbound-stop-recovery.ts";
import type { TwilioOutboundStopRecoveryConfig } from "./cliniko-twilio-outbound-stop-recovery.ts";

const phrases = Object.freeze(["stop calling", "stop calling me", "stop calling us", "stop calling this number",
  "please stop calling", "please stop calling me", "please stop calling us", "please stop calling this number",
  "do not call me again", "don't call me again", "please do not call me again", "please don't call me again",
  "do not call this number again", "don't call this number again", "please do not call this number again",
  "remove my number from your calling list", "please remove my number from your calling list",
  "take me off your calling list", "please take me off your calling list", "i don't want any more calls", "i do not want any more calls"]);
const grammarDigest = createHash("sha256").update(JSON.stringify(["abby.clear-stop-phrases.english.v1", phrases])).digest("hex");
/** A positive whole-turn rule only. False means no positive match, never proof
 * of no-stop/all-call coverage. Quoted, negated, unclear and unsupported language
 * must not be promoted into complete no-stop evidence. */
export function clearOutboundStopPhrase(text: string): boolean {
  if (typeof text !== "string" || text.length > 512) return false;
  const normalized = text.normalize("NFKC").toLowerCase().replaceAll("’", "'").replaceAll(",", " ").replace(/[.!?]+$/u, "").trim().replace(/\s+/gu, " ");
  return phrases.includes(normalized);
}
/** Computed BEFORE runtime construction. Including runtime/authenticationBinding
 * here would create a profile->runtime->profile cycle. This descriptor contains
 * no patient/call/number and never exposes the raw MAC key. */
export function twilioStopSpeechProfileBinding(reports: TwilioOutboundReportConfig, reportKey: Uint8Array): string | undefined {
  try {
    if (!(reportKey instanceof Uint8Array) || reportKey.byteLength !== 32 || !outboundConfigShard({ ...reports,
      outboundRecallTypeId: reports.outboundProviderReportRecallTypeId, recordPolicyDigest: reports.providerReportPolicyDigest }, fetch)) return;
    return createHash("sha256").update(JSON.stringify(["abby.twilio-stop-speech.v1", reports.scope.tenantId, reports.scope.clinicId, reports.scope.locationId,
      reports.businessId, clinikoCredentialFingerprint(reports.apiKey), reports.outboundProviderReportRecallTypeId, reports.providerReportPolicyDigest,
      createHash("sha256").update(reportKey).digest("hex"), grammarDigest])).digest("hex");
  } catch { return; }
}
export type TwilioStopSpeechConfig = TwilioOutboundStopRecoveryConfig & Readonly<{ runtime: TwilioAbbyOutboundRuntime; reportKey: Uint8Array }>;
type RecoveryPorts = Parameters<typeof ClinikoTwilioOutboundStopRecovery.create>[1];
type Ports = Omit<RecoveryPorts, "runtime" | "authentication" | "effects"> & Readonly<{
  report: TwilioOutboundReportWriteAuthority;
  effects(scope: TwilioOutboundReportConfig["scope"], owner: string): OutboundEffectBarrier;
}>;
type Failure = Readonly<{ kind: "invalidConfig" }>;
const instant = (v: string) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

/** Actual positive speech producer. Durable report and DNC have separate current
 * permissions and permanent exclusions. Conversation closure is no durable
 * decision receipt; unknown writes retain all existing workflow holds. */
export class TwilioOutboundStopSpeech {
  readonly #runtime: TwilioAbbyOutboundRuntime;
  readonly #account: TwilioAbbyOutboundRuntime["acceptsAccount"];
  readonly #profile: string;
  readonly #reports: ClinikoTwilioOutboundReportRecords;
  readonly #recovery: ClinikoTwilioOutboundStopRecovery;
  readonly #auth: TwilioOutboundReportAuthentication;
  readonly #selection: Readonly<{ scope: TwilioOutboundReportConfig["scope"]; businessId: string; credentialFingerprint: string }>;
  readonly #now: () => string;
  readonly #headroom: () => ReturnType<typeof checkClinikoHeadroom>;
  readonly #deadline: number;
  private constructor(c: TwilioStopSpeechConfig, profile: string, auth: TwilioOutboundReportAuthentication,
    reports: ClinikoTwilioOutboundReportRecords, recovery: ClinikoTwilioOutboundStopRecovery) {
    this.#runtime = c.runtime; this.#account = c.runtime.acceptsAccount.bind(c.runtime);
    this.#profile = profile; this.#auth = auth; this.#reports = reports; this.#recovery = recovery;
    this.#selection = Object.freeze({ scope: Object.freeze({ ...c.reports.scope }), businessId: c.reports.businessId,
      credentialFingerprint: clinikoCredentialFingerprint(c.reports.apiKey) });
    this.#now = c.reports.clock?.bind(c.reports) ?? (() => new Date().toISOString());
    const b = c.reports.rateBudget, budget = Object.freeze({ claim: b.claim.bind(b), observe429: b.observe429.bind(b),
      ...(b.checkHeadroom ? { checkHeadroom: b.checkHeadroom.bind(b) } : {}) }), cost = c.stop.maximumNativeRequests + 1;
    this.#headroom = () => checkClinikoHeadroom(budget, cost);
    this.#deadline = Math.min(120000, (c.reports.deadlineMs ?? 15000) + (c.stop.deadlineMs ?? 60000));
  }
  static create(c: TwilioStopSpeechConfig, ports: Ports): Result<TwilioOutboundStopSpeech, Failure> {
    try {
      if (new Set([c.reports.rateBudget, c.stop.requests.rateBudget, c.stop.attempts.rateBudget, c.stop.dnc.source.rateBudget]).size !== 1)
        return err({ kind: "invalidConfig" });
      const key = Buffer.from(c.reportKey), b = c.reports.rateBudget;
      const physical = Object.freeze({ claim: b.claim.bind(b), observe429: b.observe429.bind(b),
        ...(b.checkHeadroom ? { checkHeadroom: b.checkHeadroom.bind(b) } : {}) });
      const capture = <T extends TwilioOutboundReportConfig | TwilioStopSpeechConfig["stop"]["requests"] | TwilioStopSpeechConfig["stop"]["attempts"] | TwilioStopSpeechConfig["stop"]["dnc"]["source"]>(v: T): Readonly<T> =>
        Object.freeze<T>({ ...v, scope: Object.freeze({ ...v.scope }), rateBudget: physical, ...(v.clock ? { clock: v.clock.bind(v) } : {}) });
      c = Object.freeze({ ...c, reportKey: key, reports: capture(c.reports), stop: Object.freeze({ ...c.stop,
        requests: capture(c.stop.requests), attempts: capture(c.stop.attempts), dnc: Object.freeze({ ...c.stop.dnc,
          source: Object.freeze({ ...capture(c.stop.dnc.source), contactRevision: Object.freeze({
            matches: c.stop.dnc.source.contactRevision.matches.bind(c.stop.dnc.source.contactRevision), read: c.stop.dnc.source.contactRevision.read.bind(c.stop.dnc.source.contactRevision) }) }) }) }) });
      const profile = twilioStopSpeechProfileBinding(c.reports, c.reportKey);
      if (!(c.runtime instanceof TwilioAbbyOutboundRuntime) || !profile || c.stop.maximumNativeRequests > 179 || typeof ports.effects !== "function")
        return err({ kind: "invalidConfig" });
      const provider = c.runtime.binding(), auth = new TwilioOutboundReportAuthentication(c.reportKey, { ref: provider.ref, bindingDigest: provider.bindingDigest });
      const reportBinding = twilioOutboundReportRecordBinding(c.reports, auth), dncBinding = outboundDncRecordBinding(c.stop.dnc);
      if (!reportBinding || !dncBinding) return err({ kind: "invalidConfig" });
      const { report, effects, ...reads } = ports;
      const reports = ClinikoTwilioOutboundReportRecords.create(c.reports, auth, report, effects(c.reports.scope, reportBinding), ports.native);
      const recovery = ClinikoTwilioOutboundStopRecovery.create(c, { ...reads, runtime: c.runtime, authentication: auth, effects: effects(c.reports.scope, dncBinding) });
      if (!reports.ok || !recovery.ok) return err({ kind: "invalidConfig" });
      return ok(new TwilioOutboundStopSpeech(c, profile, auth, reports.value, recovery.value));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  profileBinding(): string { return this.#profile; }
  matchesRuntime(runtime: TwilioAbbyOutboundRuntime): boolean { return this.#recovery.matchesRuntime(runtime); }
  bindPolicy(input: TwilioOutboundStream, receipt: AdmissionReceipt, sessionId: string, close: () => void): OutboundContactStopPolicy {
    const call = structuredClone(input.call), original = call.context, a = original.original.attempt;
    const key = { accountRef: call.accountSid, providerCallRef: call.callSid }, selection = this.#selection;
    if (!this.matchesRuntime(this.#runtime) || !this.#account(call.accountSid) || !/^CA[0-9a-f]{32}$/.test(call.callSid) ||
        call.kind !== "authenticatedOutboundCall" || receipt.admission.direction !== "outbound" || receipt.lifecycle === "ended" ||
        receipt.callId !== callIdFor(key) || !isDeepStrictEqual(receipt.admission.key, key) || receipt.admission.clinicNumber !== call.clinicNumber ||
        !isDeepStrictEqual(a.scope, selection.scope) || !isDeepStrictEqual(receipt.scope, a.scope) || a.businessId !== selection.businessId ||
        a.credentialFingerprint !== selection.credentialFingerprint || !isDeepStrictEqual(a.provider, this.#auth.binding()) ||
        !a.capacityAllocationRef || !a.dncReferences || !a.contactReferences || original.number !== call.recipientNumber ||
        !validRecallMarker(original.reportActionRef) || !validRecallMarker(original.sessionActionRef) || original.reportActionRef === original.sessionActionRef ||
        !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(original.original.recallRef) ||
        !/^[a-f0-9]{64}$/.test(original.attemptDigest) || outboundLaunchAttemptDigest(a) !== original.attemptDigest ||
        !sessionId || sessionId.length > 256 || typeof close !== "function") throw Error("Unavailable outbound stop producer binding");
    let positive: FinalCallerTurn | undefined, retained = false, last = "";
    const same = (turn: FinalCallerTurn) => turn.callId === receipt.callId && turn.sessionId === sessionId && typeof turn.turnId === "string" && !!turn.turnId;
    return Object.freeze({ retentionDeadlineMs: this.#deadline,
      inspect: (turn: FinalCallerTurn) => {
        if (!this.matchesRuntime(this.#runtime) || !same(turn)) throw Error("Unavailable outbound stop producer");
        if (positive) { if (!isDeepStrictEqual(positive, turn)) throw Error("Changed positive stop turn"); return "stop" as const; }
        if (turn.quality !== "clear" || !clearOutboundStopPhrase(turn.text)) return "continue" as const;
        positive = Object.freeze({ ...turn }); return "stop" as const;
      },
      retainStop: async (turn: FinalCallerTurn, signal: AbortSignal) => {
        if (!positive || !isDeepStrictEqual(positive, turn) || retained) throw Error("Unavailable positive stop");
        retained = true; try { close(); } catch { /* Native purpose remains independently current. */ }
        const now = () => { const at = this.#now(); if (signal.aborted || !instant(at) || at < last || at < turn.at || !instant(turn.at) ||
          turn.at < a.attemptedAt || !this.matchesRuntime(this.#runtime)) throw Error("Unavailable stop observation"); last = at; return at; };
        now(); if (await awaitUntilAbort(this.#headroom(), signal) !== null) throw Error("Unavailable native stop budget");
        const at = now(), unsigned: Omit<TwilioOutboundReport, "authentication"> = { actionRef: original.reportActionRef, scope: a.scope,
          businessId: a.businessId, credentialFingerprint: a.credentialFingerprint, patientId: a.patientId,
          original: { recallRef: original.original.recallRef, actionRef: a.actionRef, digest: original.attemptDigest }, accountSid: call.accountSid,
          callSid: call.callSid, number: original.number, terminal: null, contact: { kind: "stopRequested", stoppedAt: turn.at }, reportedAt: at, recordedAt: at };
        const report = this.#auth.sign(unsigned); if (!report.ok) throw Error("Unavailable stop evidence");
        await this.#reports.retainReportOnce(report.value, original, call.accountSid, at.slice(0, 10), signal);
        now();
        const recovered = await this.#recovery.recoverRetainedReport(original, call.accountSid, call.callSid, signal);
        if (!recovered.ok || recovered.value.evidence !== "stop" || recovered.value.outcome.kind === "uncertain" || recovered.value.outcome.kind === "unresolved")
          throw Error("Unresolved native stop decision");
      }
    });
  }
}
