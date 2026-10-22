import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { OutboundRuntimeCallIdentity } from "../voice/outbound-runtime.ts";
import { outboundNativeInstant } from "../cliniko/internal/outbound-record-context.ts";
import type { NativeOutboundFailure } from "../cliniko/internal/outbound-native-record.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { ClinikoTwilioOutboundTerminalHistory } from "../cliniko/twilio-outbound-terminal-history.ts";
import type { TwilioTerminalHistoryAuthority, TwilioTerminalEvidence } from "../cliniko/twilio-outbound-terminal-history.ts";
import { TwilioOutboundTerminalObservationAuthentication, twilioOutboundTerminalObservationDigest } from "../cliniko/twilio-outbound-terminal-observation.ts";
import { ClinikoOutboundStaffReviewRecords } from "../cliniko/outbound-staff-review-records.ts";
import type { OutboundStaffReviewConfig, OutboundStaffReviewWriteAuthority } from "../cliniko/outbound-staff-review-records.ts";
import { ClinikoOutboundStaffReviewHistory } from "../cliniko/outbound-staff-review-history.ts";
import type { OutboundStaffReviewHistoryAuthority } from "../cliniko/outbound-staff-review-history.ts";
import { outboundStaffReviewActionRef, outboundStaffReviewMatchesAttempt } from "../cliniko/outbound-staff-review-request.ts";
import type { OutboundStaffReviewRequest } from "../cliniko/outbound-staff-review-request.ts";
import { NativeRequestAllowance } from "./internal/native-request-allowance.ts";

type Sources = Parameters<typeof ClinikoTwilioOutboundTerminalHistory.create>[0];
export type TwilioOutboundStaffReviewConfig = Sources & Readonly<{ reviews: OutboundStaffReviewConfig; maximumNativeRequests: number; deadlineMs?: number }>;
export type TwilioOutboundStaffReviewPorts = Readonly<{
  authentication: TwilioOutboundTerminalObservationAuthentication; sources: TwilioTerminalHistoryAuthority;
  records: OutboundStaffReviewWriteAuthority; history: OutboundStaffReviewHistoryAuthority; effects: OutboundEffectBarrier; native?: typeof fetch;
}>;
type Outcome = Readonly<{ kind: "reviewRetained"; evidence: "nativeAck" | "nativeHistory" }> | Readonly<{ kind: "reviewUncertain" | "unresolved" }>;
type SourceQuery = Parameters<TwilioTerminalHistoryAuthority["current"]>[0];
type HistoryQuery = Parameters<OutboundStaffReviewHistoryAuthority["current"]>[0];
type WriteQuery = Parameters<OutboundStaffReviewWriteAuthority["current"]>[0];

function matchesNotification(request: OutboundStaffReviewRequest, evidence: TwilioTerminalEvidence): boolean {
  const native = evidence.observation, notification = native.record;
  return outboundStaffReviewMatchesAttempt(request, evidence.original) && request.notification.recallRef === native.recallRef &&
    request.notification.actionRef === notification.actionRef && request.notification.digest === twilioOutboundTerminalObservationDigest(notification) &&
    request.recordedAt >= notification.recordedAt;
}

/** Retain unresolved clinic work from authenticated native provenance. This
 * owns no contact release, DNC mutation, dial or clinical port. Native history
 * recovers the original purpose after process/ACK loss without a private queue. */
export class ClinikoTwilioOutboundStaffReview {
  readonly #config: TwilioOutboundStaffReviewConfig;
  readonly #ports: TwilioOutboundStaffReviewPorts;
  private constructor(c: TwilioOutboundStaffReviewConfig, p: TwilioOutboundStaffReviewPorts) {
    const b = c.reviews.rateBudget, budget = Object.freeze({ claim: b.claim.bind(b), observe429: b.observe429.bind(b),
      ...(b.checkHeadroom ? { checkHeadroom: b.checkHeadroom.bind(b) } : {}) });
    const capture = <T extends Sources["observations"] | Sources["attempts"] | OutboundStaffReviewConfig>(v: T): Readonly<T> =>
      Object.freeze<T>({ ...v, scope: Object.freeze({ ...v.scope }), rateBudget: budget, ...(v.clock ? { clock: v.clock.bind(v) } : {}) });
    this.#config = Object.freeze({ ...c, attempts: capture(c.attempts), observations: capture(c.observations), reviews: capture(c.reviews) });
    this.#ports = Object.freeze({ authentication: p.authentication, native: p.native ?? fetch,
      sources: Object.freeze({ allowsHistoryRead: p.sources.allowsHistoryRead.bind(p.sources), allowsObservationRead: p.sources.allowsObservationRead.bind(p.sources),
        allowsAttemptRead: p.sources.allowsAttemptRead.bind(p.sources), current: p.sources.current.bind(p.sources) }),
      history: Object.freeze({ allowsHistoryRead: p.history.allowsHistoryRead.bind(p.history), allowsRecordRead: p.history.allowsRecordRead.bind(p.history), current: p.history.current.bind(p.history) }),
      records: Object.freeze({ allows: p.records.allows.bind(p.records), producerAdmitted: p.records.producerAdmitted.bind(p.records), current: p.records.current.bind(p.records) }),
      effects: Object.freeze({ matches: p.effects.matches.bind(p.effects), claimOnce: p.effects.claimOnce.bind(p.effects) }) });
  }
  static create(c: TwilioOutboundStaffReviewConfig, p: TwilioOutboundStaffReviewPorts): Result<ClinikoTwilioOutboundStaffReview, NativeOutboundFailure> {
    try {
      const r = c.reviews, types = [r.outboundStaffReviewRecallTypeId, c.attempts.outboundAttemptRecallTypeId, c.observations.outboundTerminalObservationRecallTypeId];
      if (!Number.isSafeInteger(c.maximumNativeRequests) || c.maximumNativeRequests < 1 || c.maximumNativeRequests > 180 ||
          c.deadlineMs !== undefined && (!Number.isSafeInteger(c.deadlineMs) || c.deadlineMs < 1 || c.deadlineMs > 15000) || new Set(types).size !== types.length ||
          [c.attempts, c.observations].some(v => v.rateBudget !== r.rateBudget || v.apiKey !== r.apiKey || v.businessId !== r.businessId || !isDeepStrictEqual(v.scope, r.scope)) ||
          !ClinikoTwilioOutboundTerminalHistory.create(c, p.authentication, p.sources, p.native).ok ||
          !ClinikoOutboundStaffReviewRecords.create(r, p.records, p.effects, p.native).ok || !ClinikoOutboundStaffReviewHistory.create(r, p.history, p.native).ok) return err({ kind: "invalidConfig" });
      return ok(new ClinikoTwilioOutboundStaffReview(c, p));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async retainForRuntime(identity: OutboundRuntimeCallIdentity, accountSid: string, external: AbortSignal,
    allowance?: NativeRequestAllowance): Promise<Result<Outcome, NativeOutboundFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted || allowance !== undefined && !(allowance instanceof NativeRequestAllowance)) return err({ kind: "invalidQuery" });
    const c = this.#config, p = this.#ports, controller = new AbortController(), ms = c.deadlineMs ?? 15000;
    const timer = setTimeout(() => controller.abort(), ms), signal = AbortSignal.any([external, controller.signal]), began = performance.now();
    const sourceGrants = new Set<SourceQuery>(), historyGrants = new Set<HistoryQuery>(), writeGrants = new Set<WriteQuery>();
    let last = "", claims = 0;
    const now = () => { const at = c.reviews.clock?.() ?? new Date().toISOString(); if (outboundNativeInstant(at) !== at || at < last) throw Error("Unavailable clock"); last = at; return at; };
    const current = () => {
      now(); return !signal.aborted && performance.now() - began <= ms && [...sourceGrants].every(q => p.sources.current(q, signal) === true) &&
        [...historyGrants].every(q => p.history.current(q, signal) === true) && [...writeGrants].every(q => p.records.current(q, signal) === true);
    };
    const wait = async <T>(task: Promise<T>): Promise<T> => { const v = await awaitUntilAbort(task, signal); if (v === undefined || !current()) throw Error("Unavailable review"); return v; };
    const physical = c.reviews.rateBudget, budget: ClinikoRequestBudget = Object.freeze({
      claim: () => !current() || ++claims > c.maximumNativeRequests || allowance && !allowance.take() ? { kind: "unavailable" as const } : physical.claim(),
      observe429: physical.observe429.bind(physical), ...(physical.checkHeadroom ? { checkHeadroom: (n: number) => !current() || claims + n > c.maximumNativeRequests ||
        allowance && !allowance.hasHeadroom(n) ? { kind: "unavailable" as const } : physical.checkHeadroom!(n) } : {})
    });
    try {
      now(); const sources = ClinikoTwilioOutboundTerminalHistory.create({ observations: { ...c.observations, rateBudget: budget }, attempts: { ...c.attempts, rateBudget: budget } },
        p.authentication, { ...p.sources, current: (q, s) => { sourceGrants.add(q); return current() && p.sources.current(q, s) === true; } }, p.native);
      const history = ClinikoOutboundStaffReviewHistory.create({ ...c.reviews, rateBudget: budget }, {
        ...p.history, current: (q, s) => { historyGrants.add(q); return current() && p.history.current(q, s) === true; }
      }, p.native);
      if (!sources.ok || !history.ok) return err({ kind: "invalidConfig" });
      const found = await wait(sources.value.findForRuntime(identity, accountSid, signal)); if (!found.ok) return found;
      const evidence = found.value.evidence; if (!evidence || !evidence.original.attempt.contactReferences) return ok({ kind: "unresolved" });
      const existing = await wait(history.value.findForAttempt(evidence.original, signal)); if (!existing.ok) return existing;
      if (existing.value.record && (!matchesNotification(existing.value.record.record, evidence) || existing.value.record.record.recordedAt > now())) return err({ kind: "mismatched" });
      const fresh = await wait(sources.value.findForRuntime(identity, accountSid, signal)); if (!fresh.ok) return fresh;
      if (!isDeepStrictEqual(fresh.value.evidence, evidence)) return err({ kind: "mismatched" });
      if (existing.value.record) return ok({ kind: "reviewRetained", evidence: "nativeHistory" });
      const original = evidence.original, a = original.attempt, notification = evidence.observation;
      const actionRef = outboundStaffReviewActionRef(a.actionRef); if (!actionRef) return err({ kind: "invalidQuery" });
      const request: OutboundStaffReviewRequest = { actionRef, scope: a.scope, businessId: a.businessId, credentialFingerprint: a.credentialFingerprint, patientId: a.patientId,
        attempt: notification.record.original, notification: { recallRef: notification.recallRef, actionRef: notification.record.actionRef, digest: twilioOutboundTerminalObservationDigest(notification.record)! },
        state: "needsClinicReview", reason: "contactCoverageUnresolved", recordedAt: now() };
      const records = ClinikoOutboundStaffReviewRecords.create({ ...c.reviews, rateBudget: budget }, { ...p.records,
        current: (q, s) => { writeGrants.add(q); return current() && p.records.current(q, s) === true; },
        producerAdmitted: async (q, s) => current() && !!q.request && matchesNotification(q.request, evidence) &&
          await p.records.producerAdmitted(q, s) === true && current()
      }, p.effects, p.native);
      if (!records.ok || !current()) return err({ kind: "unavailable" });
      // Once exact native ACK is established, later reporting/grant failure
      // cannot erase it. No subsequent operation can release contact or dial.
      const retained = await awaitUntilAbort(records.value.retainRequestOnce(request, original.recallAt, signal), signal);
      if (!retained) return ok({ kind: "reviewUncertain" });
      return retained.ok ? ok(retained.value.kind === "accepted" ? { kind: "reviewRetained", evidence: "nativeAck" } : { kind: "reviewUncertain" }) : retained;
    } catch { return err({ kind: "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
