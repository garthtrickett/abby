import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { outboundLaunchAttemptDigest } from "../cliniko/outbound-launch-attempt.ts";
import { ClinikoTwilioOutboundReportHistory } from "../cliniko/twilio-outbound-report-history.ts";
import type { TwilioOutboundReportHistoryAuthority, TwilioOutboundReportHistoryQuery } from "../cliniko/twilio-outbound-report-history.ts";
import type { TwilioOutboundReportConfig, TwilioOutboundReportQuery } from "../cliniko/twilio-outbound-report-records.ts";
import { TwilioOutboundReportAuthentication } from "../cliniko/twilio-outbound-report.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { TwilioAbbyOutboundRuntime } from "../voice/twilio-outbound-runtime.ts";
import type { SignedTwilioWebhook } from "../voice/twilio-signed-ingress.ts";
import type { TwilioOriginalCall } from "../voice/twilio-outbound-context.ts";
import { ClinikoOutboundStopOwner } from "./cliniko-outbound-stop-owner.ts";
import type { OutboundStopOwnerConfig, OutboundStopOutcome } from "./cliniko-outbound-stop-owner.ts";
import { NativeRequestAllowance } from "./internal/native-request-allowance.ts";

type StopPorts = Parameters<typeof ClinikoOutboundStopOwner.create>[1];
export type TwilioOutboundStopRecoveryConfig = Readonly<{ stop: OutboundStopOwnerConfig; reports: TwilioOutboundReportConfig }>;
type Ports = Omit<StopPorts, "provider"> & Readonly<{ runtime: TwilioAbbyOutboundRuntime;
  authentication: TwilioOutboundReportAuthentication; reports: TwilioOutboundReportHistoryAuthority }>;
type Failure = Readonly<{ kind: "invalidConfig" | "unavailable" | "forbidden" | "unrecoverable" }>;
type ObservedRecovery = Readonly<{ outcome: OutboundStopOutcome; evidence: "missing" | "noStop" | "stop" }>;

/** Concrete cold recovery from authenticated native Twilio/Abby evidence into
 * the existing restrictive decision owner. The signed callback supplies only
 * correlation: neither its status nor its To number proves a stop or patient
 * identity. No call launch, report production, hold release or background task. */
export class ClinikoTwilioOutboundStopRecovery {
  readonly #config: TwilioOutboundStopRecoveryConfig;
  readonly #ports: Ports;
  readonly #authenticate: TwilioAbbyOutboundRuntime["authenticateStatus"];
  readonly #binding: TwilioAbbyOutboundRuntime["binding"];
  readonly #account: TwilioAbbyOutboundRuntime["acceptsAccount"];
  readonly #selected: ReturnType<TwilioAbbyOutboundRuntime["binding"]>;
  readonly #policyMethod: OutboundStopOwnerConfig["policy"]["currentFor"];
  private constructor(config: TwilioOutboundStopRecoveryConfig, ports: Ports) {
    this.#config = config; this.#ports = ports;
    this.#authenticate = ports.runtime.authenticateStatus.bind(ports.runtime);
    this.#binding = ports.runtime.binding.bind(ports.runtime);
    this.#account = ports.runtime.acceptsAccount.bind(ports.runtime);
    this.#selected = Object.freeze({ ...this.#binding() });
    this.#policyMethod = config.stop.policy.currentFor;
  }
  static create(config: TwilioOutboundStopRecoveryConfig, ports: Ports): Result<ClinikoTwilioOutboundStopRecovery, Failure> {
    try {
      const c = config.stop, r = config.reports;
      if (!(ports.runtime instanceof TwilioAbbyOutboundRuntime) || !(ports.authentication instanceof TwilioOutboundReportAuthentication) ||
          !isDeepStrictEqual(ports.authentication.binding(), { ref: ports.runtime.binding().ref, bindingDigest: ports.runtime.binding().bindingDigest }) ||
          !isDeepStrictEqual(r.scope, c.requests.scope) || r.apiKey !== c.requests.apiKey || r.businessId !== c.requests.businessId ||
          r.rateBudget !== c.requests.rateBudget || [c.requests.outboundRecallTypeId, c.attempts.outboundAttemptRecallTypeId,
            c.dnc.source.contactReviewRecallTypeId].includes(r.outboundProviderReportRecallTypeId)) return err({ kind: "invalidConfig" });
      const provider = { binding: ports.authentication.binding.bind(ports.authentication), inspectStop: async () => ({ kind: "unknown" as const }) };
      if (!ClinikoOutboundStopOwner.create(c, { ...ports, provider }).ok ||
          !ClinikoTwilioOutboundReportHistory.create(r, ports.authentication, ports.reports, ports.native).ok) return err({ kind: "invalidConfig" });
      const b = c.requests.rateBudget, physical = Object.freeze({ claim: b.claim.bind(b), observe429: b.observe429.bind(b),
        ...(b.checkHeadroom ? { checkHeadroom: b.checkHeadroom.bind(b) } : {}) });
      const capture = <T extends TwilioOutboundReportConfig | OutboundStopOwnerConfig["requests"] | OutboundStopOwnerConfig["attempts"] | OutboundStopOwnerConfig["dnc"]["source"]>(v: T): Readonly<T> =>
        Object.freeze<T>({ ...v, scope: Object.freeze({ ...v.scope }), rateBudget: physical, ...(v.clock ? { clock: v.clock.bind(v) } : {}) });
      const captured = Object.freeze({ stop: Object.freeze({ ...c, attempts: capture(c.attempts), requests: capture(c.requests),
        dnc: Object.freeze({ ...c.dnc, source: Object.freeze({ ...capture(c.dnc.source), contactRevision: Object.freeze({
          matches: c.dnc.source.contactRevision.matches.bind(c.dnc.source.contactRevision), read: c.dnc.source.contactRevision.read.bind(c.dnc.source.contactRevision) }) }) }) }),
        reports: capture(r) });
      const bound = Object.freeze({ ...ports,
        attempt: Object.freeze({ allows: ports.attempt.allows.bind(ports.attempt), current: ports.attempt.current.bind(ports.attempt) }),
        request: Object.freeze({ allows: ports.request.allows.bind(ports.request), current: ports.request.current.bind(ports.request) }),
        contact: Object.freeze({ allows: ports.contact.allows.bind(ports.contact), current: ports.contact.current.bind(ports.contact) }),
        definition: Object.freeze({ currentFor: ports.definition.currentFor.bind(ports.definition) }),
        effects: Object.freeze({ matches: ports.effects.matches.bind(ports.effects), claimOnce: ports.effects.claimOnce.bind(ports.effects) }),
        record: Object.freeze({ allows: ports.record.allows.bind(ports.record), current: ports.record.current.bind(ports.record), producerAdmitted: ports.record.producerAdmitted.bind(ports.record) }),
        authority: Object.freeze({ allows: ports.authority.allows.bind(ports.authority), current: ports.authority.current.bind(ports.authority) }),
        reports: Object.freeze({ allowsHistoryRead: ports.reports.allowsHistoryRead.bind(ports.reports), allowsRecordRead: ports.reports.allowsRecordRead.bind(ports.reports),
          current: ports.reports.current.bind(ports.reports) }) });
      return ok(new ClinikoTwilioOutboundStopRecovery(captured, bound));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  matchesRuntime(runtime: TwilioAbbyOutboundRuntime): boolean {
    try { return runtime instanceof TwilioAbbyOutboundRuntime && isDeepStrictEqual(runtime.binding(), this.#selected) &&
      isDeepStrictEqual(this.#binding(), this.#selected); } catch { return false; }
  }
  async recoverStatus(request: SignedTwilioWebhook, external: AbortSignal): Promise<Result<OutboundStopOutcome, Failure>> {
    const result = await this.recoverStatusEvidence(request, external);
    return result.ok ? ok(result.value.outcome) : result;
  }
  /** Delivery acknowledgement can distinguish absent producer data from an
   * authentic no-stop observation without treating either as hold clearance. */
  async recoverStatusEvidence(request: SignedTwilioWebhook, external: AbortSignal, allowance?: NativeRequestAllowance): Promise<Result<ObservedRecovery, Failure>> {
    try {
      const authenticated = this.#authenticate(structuredClone(request));
      if (!authenticated.ok) return err({ kind: "forbidden" });
      const call = authenticated.value.call;
      return this.recoverRetainedReport(call.context, call.accountSid, call.callSid, external, allowance);
    } catch { return err({ kind: "unavailable" }); }
  }
  /** Internal producer recovery does not require inventing a signed callback.
   * Input correlation is no positive authority: the SAME exact native MAC
   * report/history, immutable origin and independent current grants remain
   * mandatory before any restrictive write. No clinical/contact release grant. */
  async recoverRetainedReport(input: TwilioOriginalCall, accountSid: string, callSid: string,
    external: AbortSignal, allowance?: NativeRequestAllowance): Promise<Result<ObservedRecovery, Failure>> {
    try {
      if (!(external instanceof AbortSignal) || external.aborted || allowance !== undefined && !(allowance instanceof NativeRequestAllowance) || !isDeepStrictEqual(this.#binding(), this.#selected) ||
          this.#config.stop.policy.currentFor !== this.#policyMethod) return err({ kind: "unavailable" });
      if (!this.#account(accountSid) || !/^CA[0-9a-f]{32}$/.test(callSid)) return err({ kind: "forbidden" });
      const original = structuredClone(input), call = Object.freeze({ accountSid, callSid, recipientNumber: original.number });
      const a = original.original.attempt, p = this.#ports, c = this.#config;
      const grants = new Map<string, TwilioOutboundReportHistoryQuery | TwilioOutboundReportQuery>();
      let reportSeen = false, claims = 0;
      let evidence: ObservedRecovery["evidence"] = "missing";
      const current = (signal: AbortSignal) => !signal.aborted && c.stop.policy.currentFor === this.#policyMethod && isDeepStrictEqual(this.#binding(), this.#selected) &&
        [...grants.values()].every(g => p.reports.current(g, signal) === true);
      const physical = c.stop.requests.rateBudget;
      // One operation allowance across report scans/rereads, the original
      // request/contact reads and the restrictive POST, using the SAME physical
      // API-user budget. A fresh owner never resets that underlying budget.
      const budget: ClinikoRequestBudget = Object.freeze({ claim: () => ++claims <= c.stop.maximumNativeRequests && (!allowance || allowance.take()) ? physical.claim() : { kind: "unavailable" as const },
        observe429: physical.observe429.bind(physical), ...(physical.checkHeadroom ? { checkHeadroom: (n: number) => allowance && !allowance.hasHeadroom(n)
          ? { kind: "unavailable" as const } : physical.checkHeadroom!(n) } : {}) });
      const matches = (g: Parameters<StopPorts["attempt"]["current"]>[0]) =>
        g.recallRef === original.original.recallRef && g.actionRef === a.actionRef && g.patientId === a.patientId &&
        (!g.attempt || outboundLaunchAttemptDigest(g.attempt) === original.attemptDigest);
      const source = ClinikoTwilioOutboundReportHistory.create({ ...c.reports, rateBudget: budget }, p.authentication, {
        allowsHistoryRead: p.reports.allowsHistoryRead, allowsRecordRead: p.reports.allowsRecordRead,
        current: (g, s) => {
          const key = JSON.stringify([g.operation, "recallRef" in g ? g.recallRef : null, "report" in g && !!g.report]);
          grants.set(key, g); return current(s);
        }
      }, p.native);
      if (!source.ok) return err({ kind: "unavailable" });
      const owner = ClinikoOutboundStopOwner.create({ ...c.stop, requests: { ...c.stop.requests, rateBudget: budget },
        attempts: { ...c.stop.attempts, rateBudget: budget }, dnc: { ...c.stop.dnc, source: { ...c.stop.dnc.source, rateBudget: budget } } }, {
        ...p, attempt: { allows: (g, s) => Promise.resolve(matches(g) && current(s)).then(yes => yes && p.attempt.allows(g, s)),
          current: (g, s) => matches(g) && current(s) && p.attempt.current(g, s) },
        authority: { allows: (g, s) => Promise.resolve(current(s) && outboundLaunchAttemptDigest(g.attempt.attempt) === original.attemptDigest &&
          (g.operation === "readProviderStop" || reportSeen)).then(yes => yes && p.authority.allows(g, s)),
          current: (g, s) => current(s) && outboundLaunchAttemptDigest(g.attempt.attempt) === original.attemptDigest && p.authority.current(g, s) },
        provider: { binding: p.authentication.binding.bind(p.authentication), inspectStop: async (_identity, signal) => {
          const found = await source.value.findForOriginal(original, call.accountSid, signal);
          if (!found.ok || !current(signal)) throw Error("Unavailable native stop evidence");
          const report = found.value.record?.record;
          if (!report) return { kind: "unknown" };
          if (report.callSid !== call.callSid || report.number !== call.recipientNumber) throw Error("Foreign native call evidence");
          if (report.contact.kind !== "stopRequested") { evidence = "noStop"; return { kind: "none" }; }
          evidence = "stop";
          reportSeen = true;
          return { kind: "stop", effectRef: a.effectRef, capacityAllocationRef: a.capacityAllocationRef!, provider: p.authentication.binding(),
            number: report.number, participant: "anyAtDialledNumber", stoppedAt: report.contact.stoppedAt, observedAt: report.reportedAt };
        } }
      });
      if (!owner.ok) return err({ kind: "unavailable" });
      const result = await owner.value.retainStopOnce({ recallRef: original.original.recallRef, actionRef: a.actionRef, patientId: a.patientId }, external);
      return result.ok ? ok(Object.freeze({ outcome: result.value, evidence })) : result;
    } catch { return err({ kind: "unavailable" }); }
  }
}
