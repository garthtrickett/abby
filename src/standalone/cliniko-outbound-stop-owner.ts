import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { checkClinikoHeadroom } from "../cliniko/read-budget.ts";
import { ClinikoOutboundLaunchRecords } from "../cliniko/outbound-launch-records.ts";
import type { OutboundLaunchRecord, OutboundLaunchReadAuthority, OutboundLaunchRecordConfig, OutboundLaunchRecordQuery } from "../cliniko/outbound-launch-records.ts";
import { ClinikoOutboundRecipientRecords } from "../cliniko/outbound-recipient-records.ts";
import type { OutboundRecordConfig, OutboundRecordReadAuthority, OutboundRecordQuery, OutboundRecipientRecord } from "../cliniko/outbound-recipient-records.ts";
import { outboundRecipientRequestDigest } from "../cliniko/outbound-recipient-request.ts";
import { ClinikoOutboundContactSource } from "../cliniko/outbound-contact-source.ts";
import type { OutboundContactAuthority, OutboundContactDefinition, OutboundContactHistoryEvidence, OutboundContactQuery } from "../cliniko/outbound-contact-source.ts";
import { contactSourceBinding, contactSourceSelection } from "../cliniko/internal/outbound-contact-source-context.ts";
import { ClinikoOutboundDncRecords } from "../cliniko/outbound-dnc-records.ts";
import type { OutboundDncRecordConfig, OutboundDncWriteAuthority } from "../cliniko/outbound-dnc-records.ts";
import type { NativeOutboundReadBinding, NativeOutboundRetention } from "../cliniko/internal/outbound-native-record.ts";
import type { OutboundContactReview } from "../cliniko/outbound-contact-review.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { OwnerFileOutboundDncPolicy } from "./owner-file-outbound-dnc-policy.ts";
import type { OutboundDncPolicyApproval } from "./owner-file-outbound-dnc-policy.ts";

type ProviderBinding = Readonly<{ ref: string; bindingDigest: string }>;
export type OutboundStopObservation = Readonly<{ kind: "stop"; effectRef: string; capacityAllocationRef: string;
  provider: ProviderBinding; number: string; participant: "anyAtDialledNumber"; stoppedAt: string; observedAt: string }>;
/** The concrete selected provider owns authentication, native call correlation
 * and durable stop truth. A model summary or unverified callback cannot supply
 * this interface. Neither none nor unknown grants permission for a future call. */
export type OutboundStopProvider = Readonly<{ binding(): ProviderBinding;
  inspectStop(identity: Readonly<{ effectRef: string; capacityAllocationRef: string }>, signal: AbortSignal):
    Promise<OutboundStopObservation | Readonly<{ kind: "none" | "unknown" }>> }>;
export type OutboundStopQuery = Readonly<{ operation: "readProviderStop" | "approveAutomaticDecision" | "retainDecision";
  attempt: OutboundLaunchRecord; provider: ProviderBinding; report?: OutboundStopObservation;
  request?: OutboundRecipientRecord; contact?: OutboundContactHistoryEvidence; policy?: OutboundDncPolicyApproval; review?: OutboundContactReview }>;
export type OutboundStopAuthority = Readonly<{ allows(query: OutboundStopQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundStopQuery, signal: AbortSignal): boolean }>;
export type OutboundStopOwnerConfig = Readonly<{ attempts: OutboundLaunchRecordConfig; requests: OutboundRecordConfig;
  dnc: OutboundDncRecordConfig; policy: OwnerFileOutboundDncPolicy; maximumNativeRequests: number; deadlineMs?: number }>;
type Ports = Readonly<{ attempt: OutboundLaunchReadAuthority; request: OutboundRecordReadAuthority;
  contact: OutboundContactAuthority; definition: OutboundContactDefinition; record: OutboundDncWriteAuthority;
  effects: OutboundEffectBarrier; provider: OutboundStopProvider; authority: OutboundStopAuthority; native?: typeof fetch }>;
type Failure = Readonly<{ kind: "invalidConfig" | "unavailable" | "forbidden" | "unrecoverable" }>;
export type OutboundStopOutcome = NativeOutboundRetention | Readonly<{ kind: "existingDecision"; recallRef: string }> | Readonly<{ kind: "unresolved" }>;
const instant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const exact = (v: unknown, keys: string[]) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === keys.sort().join(",");
const validProvider = (v: ProviderBinding) => exact(v, ["ref", "bindingDigest"]) && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v.ref) && /^[a-f0-9]{64}$/.test(v.bindingDigest);

/** Conditional native restrictive decision only. No launch, capacity release,
 * positive contact/head/reconsent grant or number-wide suppression is supplied.
 * Missing/changed original context stays unresolved for clinic reconciliation;
 * the provider/clinic's durable stop must continue blocking future contact. */
export class ClinikoOutboundStopOwner {
  readonly #config: OutboundStopOwnerConfig;
  readonly #ports: Ports;
  readonly #policyCurrent: OwnerFileOutboundDncPolicy["currentFor"];
  private constructor(config: OutboundStopOwnerConfig, ports: Ports) {
    this.#config = config; this.#ports = ports; this.#policyCurrent = config.policy.currentFor.bind(config.policy);
  }
  static create(config: OutboundStopOwnerConfig, ports: Ports): Result<ClinikoOutboundStopOwner, Failure> {
    try {
      if (!(config.policy instanceof OwnerFileOutboundDncPolicy) || !Number.isSafeInteger(config.maximumNativeRequests) || config.maximumNativeRequests < 1 || config.maximumNativeRequests > 180 ||
          !Number.isSafeInteger(config.deadlineMs ?? 60000) || (config.deadlineMs ?? 60000) < 1 || (config.deadlineMs ?? 60000) > 120000 ||
          [ports.provider.binding, ports.provider.inspectStop, ports.authority.allows, ports.authority.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      const request = ClinikoOutboundRecipientRecords.createReadOnly(config.requests, ports.request, ports.native);
      const attempt = ClinikoOutboundLaunchRecords.createReadOnly(config.attempts, ports.attempt, ports.native);
      const contact = ClinikoOutboundContactSource.create(config.dnc.source, ports.definition, ports.contact, ports.native);
      const record = ClinikoOutboundDncRecords.create(config.dnc, ports.definition, ports.record, ports.effects, ports.native);
      if (!request.ok || !attempt.ok || !contact.ok || !record.ok) return err({ kind: "invalidConfig" });
      for (const c of [config.attempts, config.dnc.source]) if (!isDeepStrictEqual(c.scope, config.requests.scope) || c.apiKey !== config.requests.apiKey ||
        c.businessId !== config.requests.businessId || c.rateBudget !== config.requests.rateBudget) return err({ kind: "invalidConfig" });
      const budget = config.requests.rateBudget, physical = Object.freeze({ claim: budget.claim.bind(budget), observe429: budget.observe429.bind(budget),
        ...(budget.checkHeadroom ? { checkHeadroom: budget.checkHeadroom.bind(budget) } : {}) });
      const freezeConfig = <T extends OutboundRecordConfig | OutboundDncRecordConfig["source"]>(c: T): T => Object.freeze({ ...c,
        scope: Object.freeze({ ...c.scope }), rateBudget: physical, ...(c.clock ? { clock: c.clock.bind(c) } : {}) });
      const captured = Object.freeze({ ...config, requests: freezeConfig(config.requests), attempts: freezeConfig(config.attempts),
        dnc: Object.freeze({ ...config.dnc, source: Object.freeze({ ...freezeConfig(config.dnc.source), contactRevision: Object.freeze({
          matches: config.dnc.source.contactRevision.matches.bind(config.dnc.source.contactRevision), read: config.dnc.source.contactRevision.read.bind(config.dnc.source.contactRevision) }) }) }) });
      // Capture methods now; replacement of a caller's adapter/grant object may
      // not replace the selected implementation during an observation.
      const bound = Object.freeze({ ...ports,
        attempt: Object.freeze({ allows: ports.attempt.allows.bind(ports.attempt), current: ports.attempt.current.bind(ports.attempt) }),
        request: Object.freeze({ allows: ports.request.allows.bind(ports.request), current: ports.request.current.bind(ports.request) }),
        contact: Object.freeze({ allows: ports.contact.allows.bind(ports.contact), current: ports.contact.current.bind(ports.contact) }),
        definition: Object.freeze({ currentFor: ports.definition.currentFor.bind(ports.definition) }),
        effects: Object.freeze({ matches: ports.effects.matches.bind(ports.effects), claimOnce: ports.effects.claimOnce.bind(ports.effects) }),
        record: Object.freeze({ allows: ports.record.allows.bind(ports.record), current: ports.record.current.bind(ports.record), producerAdmitted: ports.record.producerAdmitted.bind(ports.record) }),
        provider: Object.freeze({ binding: ports.provider.binding.bind(ports.provider), inspectStop: ports.provider.inspectStop.bind(ports.provider) }),
        authority: Object.freeze({ allows: ports.authority.allows.bind(ports.authority), current: ports.authority.current.bind(ports.authority) }) });
      return ok(new ClinikoOutboundStopOwner(captured, bound));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async retainStopOnce(binding: NativeOutboundReadBinding, external: AbortSignal): Promise<Result<OutboundStopOutcome, Failure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const c = this.#config, p = this.#ports, ms = c.deadlineMs ?? 60000, controller = new AbortController(), timer = setTimeout(() => controller.abort(), ms);
    const signal = AbortSignal.any([external, controller.signal]), began = performance.now();
    let last = "", q: OutboundStopQuery | undefined, attemptGrant: OutboundLaunchRecordQuery | undefined, requestGrant: OutboundRecordQuery | undefined;
    let known: NativeOutboundRetention | undefined;
    const contactGrants = new Map<string, OutboundContactQuery>(), operations = new Set<OutboundStopQuery["operation"]>();
    const active = () => !signal.aborted && performance.now() - began <= ms;
    const now = () => { const at = c.requests.clock ? c.requests.clock() : new Date().toISOString();
      if (!active() || !instant(at) || at < last) throw Error("Unavailable time"); last = at; return at; };
    const wait = async <T>(task: Promise<T>): Promise<T> => { const result = await awaitUntilAbort(task, signal); if (result === undefined || !active()) throw Error("Unavailable observation"); now(); return result; };
    const current = () => {
      now(); if (!q || !active() || !isDeepStrictEqual(p.provider.binding(), q.provider) || !attemptGrant || p.attempt.current(attemptGrant, signal) !== true ||
        requestGrant && p.request.current(requestGrant, signal) !== true || [...contactGrants.values()].some(g => p.contact.current(g, signal) !== true) ||
        [...operations].some(operation => p.authority.current(Object.freeze({ ...q!, operation }), signal) !== true)) throw Error("Unavailable grants");
      if (q.policy && now() >= q.policy.effectiveUntil) throw Error("Expired policy");
    };
    const policy = async () => {
      const result = await wait(this.#policyCurrent({ scope: c.dnc.source.scope, sourceBinding: contactSourceBinding(contactSourceSelection(c.dnc.source)),
        automationPrincipalRef: c.dnc.automationPrincipalRef, provider: q!.provider }, signal));
      if (!result.ok || !result.value) throw Error("Unavailable policy");
      if (q!.policy && !isDeepStrictEqual(q!.policy, result.value)) throw Error("Changed policy");
      q = Object.freeze({ ...q!, policy: result.value }); current();
    };
    const authorize = async (...requested: OutboundStopQuery["operation"][]) => {
      await policy();
      for (const operation of requested) { current(); const selected = Object.freeze({ ...q!, operation });
        if (await wait(Promise.resolve().then(() => p.authority.allows(selected, signal))) !== true) throw Error("Unavailable grant");
        operations.add(operation); current(); }
    };
    try {
      if (await wait(checkClinikoHeadroom(c.requests.rateBudget, c.maximumNativeRequests)) !== null) return err({ kind: "unavailable" });
      const attempts = ClinikoOutboundLaunchRecords.createReadOnly(c.attempts, { allows: p.attempt.allows,
        current: (g, s) => { if (g.attempt) attemptGrant = g; return p.attempt.current(g, s); } }, p.native);
      if (!attempts.ok) return err({ kind: "unavailable" });
      const read = await wait(attempts.value.readPossibleAttempt(structuredClone(binding), signal)); if (!read.ok) return err({ kind: "unavailable" });
      const a = read.value.attempt, provider = Object.freeze(structuredClone(p.provider.binding()));
      if (!a.capacityAllocationRef || !a.dncReferences) return err({ kind: "unrecoverable" });
      if (!validProvider(provider) || !isDeepStrictEqual(provider, a.provider)) return err({ kind: "forbidden" });
      q = Object.freeze({ operation: "readProviderStop", attempt: read.value, provider }); await authorize("readProviderStop");
      const report = structuredClone(await wait(p.provider.inspectStop(Object.freeze({ effectRef: a.effectRef, capacityAllocationRef: a.capacityAllocationRef }), signal))); current();
      if (report.kind !== "stop") return ok({ kind: "unresolved" });
      if (!exact(report, ["kind", "effectRef", "capacityAllocationRef", "provider", "number", "participant", "stoppedAt", "observedAt"]) || report.effectRef !== a.effectRef ||
        report.capacityAllocationRef !== a.capacityAllocationRef || !isDeepStrictEqual(report.provider, provider) || report.participant !== "anyAtDialledNumber" ||
        typeof report.number !== "string" || !/^\+[1-9][0-9]{7,14}$/.test(report.number) || !instant(report.stoppedAt) || !instant(report.observedAt) ||
        report.stoppedAt < a.attemptedAt || report.stoppedAt > report.observedAt || report.observedAt > now()) return err({ kind: "forbidden" });
      q = Object.freeze({ ...q, report: Object.freeze({ ...report, provider }) });
      const requests = ClinikoOutboundRecipientRecords.createReadOnly(c.requests, { allows: p.request.allows,
        current: (g, s) => { if (g.request) requestGrant = g; return p.request.current(g, s); } }, p.native);
      if (!requests.ok) return err({ kind: "unavailable" });
      const original = await wait(requests.value.readRequest({ recallRef: a.requestRecallRef, actionRef: a.requestActionRef, patientId: a.patientId }, signal));
      if (!original.ok || outboundRecipientRequestDigest(original.value.request) !== a.requestDigest || original.value.request.recipient.number !== report.number ||
        original.value.request.effectRef !== a.effectRef || original.value.request.campaignRef !== a.campaignRef || original.value.request.approvalRef !== a.approvalRef) return err({ kind: "unrecoverable" });
      q = Object.freeze({ ...q, request: original.value }); current();
      const contact = ClinikoOutboundContactSource.create(c.dnc.source, p.definition, { allows: p.contact.allows, current: (g, s) => {
        const key = JSON.stringify([g.operation, "recallRef" in g ? g.recallRef : null]), previous = contactGrants.get(key);
        if (!(g.operation === "readContactReview" && !g.review && previous?.operation === "readContactReview" && previous.review)) contactGrants.set(key, g);
        return p.contact.current(g, s);
      } }, p.native);
      if (!contact.ok) return err({ kind: "unavailable" });
      const history = await wait(contact.value.readHistoryForRequest(original.value.request, signal)); if (!history.ok) return err({ kind: "unavailable" });
      q = Object.freeze({ ...q, contact: history.value }); await authorize("readProviderStop", "approveAutomaticDecision");
      const prior = history.value.history.find(r => r.review.actionRef === a.dncReferences!.actionRef);
      if (prior) {
        if (prior.review.approvalRef !== a.dncReferences.approvalRef || prior.review.recipient.number !== report.number || prior.review.consent !== "unknown" || prior.review.doNotCall !== "blocked" ||
          prior.review.reviewerRef !== c.dnc.automationPrincipalRef || prior.review.reconsentApprovalRef !== null || prior.review.purposes.join(",") !== "followUp,sickDay") return err({ kind: "unrecoverable" });
        current(); return ok({ kind: "existingDecision", recallRef: prior.recallRef });
      }
      const used = new Set(history.value.history.flatMap(r => [r.review.actionRef, r.review.approvalRef, ...(r.review.reconsentApprovalRef ? [r.review.reconsentApprovalRef] : [])]));
      if (used.has(a.dncReferences.actionRef) || used.has(a.dncReferences.approvalRef)) return err({ kind: "unrecoverable" });
      const head = history.value.head, at = now(), s = contactSourceSelection(c.dnc.source);
      if (head && (head.review.revision >= 50 || head.review.reviewedAt > at || head.review.effectiveFrom > at)) return err({ kind: "unrecoverable" });
      const review: OutboundContactReview = Object.freeze({ actionRef: a.dncReferences.actionRef, approvalRef: a.dncReferences.approvalRef,
        reviewerRef: c.dnc.automationPrincipalRef, scope: s.scope, businessId: s.businessId, credentialFingerprint: s.credentialFingerprint,
        contactRecallTypeId: s.contactReviewRecallTypeId, policy: Object.freeze({ version: s.contactPolicyVersion, digest: s.contactPolicyDigest }),
        patientId: a.patientId, recipient: Object.freeze({ kind: "voice", number: report.number }), purposes: Object.freeze(["followUp", "sickDay"] as const),
        consent: "unknown", doNotCall: "blocked", revision: (head?.review.revision ?? 0) + 1,
        predecessor: head ? Object.freeze({ actionRef: head.review.actionRef, digest: head.digest }) : null, reconsentApprovalRef: null,
        reviewedAt: at, effectiveFrom: at, effectiveUntil: q.policy!.effectiveUntil });
      q = Object.freeze({ ...q, review }); await authorize("readProviderStop", "approveAutomaticDecision", "retainDecision");
      const records = ClinikoOutboundDncRecords.create(c.dnc, p.definition, { current: (g, sig) => { try { current(); return p.record.current(g, sig); } catch { return false; } },
        allows: async (g, sig) => { await authorize("readProviderStop", "approveAutomaticDecision", "retainDecision"); return p.record.allows(g, sig); },
        producerAdmitted: async (g, sig) => { await policy(); current(); return p.record.producerAdmitted(g, sig); } }, p.effects, p.native);
      if (!records.ok) return err({ kind: "unavailable" });
      const result = await wait(records.value.retainDecisionOnce(review, read.value.recallAt, signal).then(r => {
        if (r.ok && r.value.kind === "accepted") known = r.value; return r;
      }));
      return result.ok ? ok(result.value) : err({ kind: "unavailable" });
    } catch { return known ? ok(known) : err({ kind: "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
