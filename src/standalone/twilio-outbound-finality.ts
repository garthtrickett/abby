import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoTwilioOutboundRuntimeHistory } from "../cliniko/twilio-outbound-runtime-history.ts";
import type { TwilioRuntimeHistoryAuthority, TwilioRuntimeEvidence } from "../cliniko/twilio-outbound-runtime-history.ts";
import { TwilioOutboundReportAuthentication, twilioOutboundReportDigest } from "../cliniko/twilio-outbound-report.ts";
import { TwilioAbbyOutboundRuntime } from "../voice/twilio-outbound-runtime.ts";
import type { OutboundRuntimeCallIdentity, OutboundRuntimeTerminalResult, OutboundVoiceRuntimeAdapter } from "../voice/outbound-runtime.ts";
import type { TwilioCallClosureAuthority, TwilioCallClosureQuery } from "../voice/twilio-outbound-call-closure.ts";
import type { OutboundCompleteContactReport, OutboundContactSettlementProvider } from "./cliniko-outbound-contact-settlement.ts";

type Config = Parameters<typeof ClinikoTwilioOutboundRuntimeHistory.create>[0];
type Ports = Readonly<{ runtime: TwilioAbbyOutboundRuntime; authentication: TwilioOutboundReportAuthentication;
  history: TwilioRuntimeHistoryAuthority; closure: TwilioCallClosureAuthority; native?: typeof fetch }>;
type Failure = Readonly<{ kind: "invalidConfig" }>;
type HistoryQuery = Parameters<TwilioRuntimeHistoryAuthority["current"]>[0];
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Optional concrete adapter at the existing replaceable runtime seam. A native
 * authenticated positive survives unknown speech tails: after independently
 * complete single-root provider closure, the final contact result is STOP.
 * No-stop is intentionally UNKNOWN; silence/uncertain ASR cannot prove coverage.
 * The early immutable report is not rewritten. Native settlement, DNC, call
 * capacity, patient verification and clinical actions retain separate owners. */
export class TwilioAbbyOutboundFinality implements OutboundVoiceRuntimeAdapter {
  readonly #config: Config;
  readonly #ports: Ports;
  readonly #selected: ReturnType<TwilioAbbyOutboundRuntime["binding"]>;
  readonly #binding: TwilioAbbyOutboundRuntime["binding"];
  readonly #launch: TwilioAbbyOutboundRuntime["launchOnce"];
  readonly #reader: ReturnType<TwilioAbbyOutboundRuntime["createCallClosureReader"]>;
  private constructor(c: Config, p: Ports) {
    const budget = c.reports.rateBudget;
    const rateBudget = Object.freeze({ claim: budget.claim.bind(budget), observe429: budget.observe429.bind(budget),
      ...(budget.checkHeadroom ? { checkHeadroom: budget.checkHeadroom.bind(budget) } : {}) });
    this.#config = Object.freeze({ reports: Object.freeze({ ...c.reports, rateBudget, scope: Object.freeze({ ...c.reports.scope }), ...(c.reports.clock ? { clock: c.reports.clock.bind(c.reports) } : {}) }),
      attempts: Object.freeze({ ...c.attempts, rateBudget, scope: Object.freeze({ ...c.attempts.scope }), ...(c.attempts.clock ? { clock: c.attempts.clock.bind(c.attempts) } : {}) }) });
    this.#ports = Object.freeze({ ...p, history: Object.freeze({ allowsHistoryRead: p.history.allowsHistoryRead.bind(p.history), allowsReportRead: p.history.allowsReportRead.bind(p.history),
      allowsAttemptRead: p.history.allowsAttemptRead.bind(p.history), current: p.history.current.bind(p.history) }),
      closure: Object.freeze({ allows: p.closure.allows.bind(p.closure), current: p.closure.current.bind(p.closure) }) });
    this.#selected = Object.freeze({ ...p.runtime.binding() }); this.#binding = p.runtime.binding.bind(p.runtime); this.#launch = p.runtime.launchOnce.bind(p.runtime);
    this.#reader = p.runtime.createCallClosureReader();
  }
  static create(c: Config, p: Ports): Result<TwilioAbbyOutboundFinality, Failure> {
    try {
      if (!(p.runtime instanceof TwilioAbbyOutboundRuntime) || !(p.authentication instanceof TwilioOutboundReportAuthentication) ||
          !isDeepStrictEqual(p.authentication.binding(), { ref: p.runtime.binding().ref, bindingDigest: p.runtime.binding().bindingDigest }) ||
          [p.closure?.allows, p.closure?.current].some(f => typeof f !== "function") ||
          !ClinikoTwilioOutboundRuntimeHistory.create(c, p.authentication, p.history, p.native).ok) return err({ kind: "invalidConfig" });
      return ok(new TwilioAbbyOutboundFinality(c, p));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  binding(): ReturnType<TwilioAbbyOutboundRuntime["binding"]> { return this.#selected; }
  launchOnce(...args: Parameters<TwilioAbbyOutboundRuntime["launchOnce"]>): ReturnType<TwilioAbbyOutboundRuntime["launchOnce"]> {
    return isDeepStrictEqual(this.#binding(), this.#selected) ? this.#launch(...args) : Promise.resolve({ kind: "definitiveUnsent" });
  }
  contactProvider(): OutboundContactSettlementProvider {
    const provider = Object.freeze({ ref: this.#selected.ref, bindingDigest: this.#selected.bindingDigest });
    return Object.freeze({ binding: () => provider, inspectTerminal: this.inspectTerminal.bind(this), inspectContact: this.inspectContact.bind(this) });
  }
  async inspectTerminal(identity: OutboundRuntimeCallIdentity, signal: AbortSignal): Promise<OutboundRuntimeTerminalResult> {
    const result = await this.#inspect(identity, signal); return result?.terminal ?? { kind: "unknown" };
  }
  async inspectContact(identity: OutboundRuntimeCallIdentity, signal: AbortSignal): Promise<OutboundCompleteContactReport | Readonly<{ kind: "unknown" }>> {
    const result = await this.#inspect(identity, signal); return result?.contact ?? { kind: "unknown" };
  }
  async #inspect(input: OutboundRuntimeCallIdentity, external: AbortSignal): Promise<Readonly<{
    terminal: Extract<OutboundRuntimeTerminalResult, { kind: "terminal" }>; contact: OutboundCompleteContactReport;
  }> | undefined> {
    if (!(external instanceof AbortSignal) || external.aborted) return;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000), signal = AbortSignal.any([external, controller.signal]);
    const p = this.#ports, c = this.#config;
    const nativeGrants = new Map<string, HistoryQuery>(), providerGrants = new Map<string, TwilioCallClosureQuery>();
    const current = () => !signal.aborted && isDeepStrictEqual(this.#binding(), this.#selected) && [...nativeGrants.values()].every(q => p.history.current(q, signal) === true) &&
      [...providerGrants.values()].every(q => p.closure.current(q, signal) === true);
    const wait = async <T>(task: Promise<T>) => { const v = await awaitUntilAbort(task, signal); if (v === undefined || !current()) throw Error("Unavailable finality evidence"); return v; };
    try {
      const identity = Object.freeze(structuredClone(input));
      const history = ClinikoTwilioOutboundRuntimeHistory.create(c, p.authentication, { ...p.history, current: (q, s) => {
        const key = q.operation + ":" + ("recallRef" in q ? q.recallRef : "account") + ":" + ("report" in q && !!q.report || "attempt" in q && !!q.attempt);
        nativeGrants.set(key, q); return current() && p.history.current(q, s) === true;
      } }, p.native);
      if (!history.ok || !current()) return;
      // The runtime owns the actual account; MAC data alone cannot select it.
      // Its reader checks the same captured account again against provider GETs.
      const accountSid = this.#reader.accountSid(); if (!p.runtime.acceptsAccount(accountSid)) return;
      const first = await wait(history.value.findForRuntime(identity, accountSid, signal)); if (!first.ok || !first.value.evidence) return;
      const evidence: TwilioRuntimeEvidence = first.value.evidence, report = evidence.report.record;
      if (report.contact.kind !== "stopRequested") return;
      const closure = await wait(this.#reader.inspect({ callSid: report.callSid, number: report.number, attemptedAt: evidence.original.attempt.attemptedAt,
        stoppedAt: report.contact.stoppedAt, evidenceDigest: hash([report.original.digest, twilioOutboundReportDigest(report)]) }, {
        allows: p.closure.allows, current: (q, s) => { providerGrants.set(q.operation, q); return current() && p.closure.current(q, s) === true; }
      }, signal));
      if (closure.kind !== "singleRootClosed") return;
      const again = await wait(history.value.findForRuntime(identity, accountSid, signal));
      if (!again.ok || !isDeepStrictEqual(again.value.evidence, evidence) || !current()) return;
      const provider = Object.freeze({ ref: this.#selected.ref, bindingDigest: this.#selected.bindingDigest });
      const terminal = Object.freeze({ kind: "terminal" as const, complete: true as const, ...identity, provider, endedAt: closure.endedAt, observedAt: closure.observedAt });
      const reportedAt = report.reportedAt > closure.endedAt ? report.reportedAt : closure.endedAt;
      const contact: OutboundCompleteContactReport = Object.freeze({ kind: "complete", complete: true, ...identity, provider, attemptDigest: report.original.digest,
        reportDigest: hash(["abby.twilio.final-positive-contact.v1", twilioOutboundReportDigest(report), closure.digest]), reportedAt, contact: "stopRequested",
        stop: Object.freeze({ kind: "stop", ...identity, provider, number: report.number, participant: "anyAtDialledNumber", stoppedAt: report.contact.stoppedAt, observedAt: report.reportedAt }) });
      return Object.freeze({ terminal, contact });
    } catch { return; } finally { clearTimeout(timer); controller.abort(); }
  }
}
