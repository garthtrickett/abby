import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { outboundCapacityOwnerBinding, outboundContactGuardOwnerBinding } from "../core/outbound-capacity.ts";
import type { OutboundCapacity } from "../core/outbound-capacity.ts";
import { outboundContactTime } from "../core/outbound-contact-time.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoOutboundRecipientRecords, outboundRecordOwnerBinding } from "../cliniko/outbound-recipient-records.ts";
import type { OutboundRecordConfig, OutboundRecordReadAuthority, OutboundRecipientRecord } from "../cliniko/outbound-recipient-records.ts";
import { outboundRecordSelection } from "../cliniko/internal/outbound-record-context.ts";
import { ClinikoOutboundLaunchRecords } from "../cliniko/outbound-launch-records.ts";
import type { OutboundLaunchRecordConfig, OutboundLaunchRecordAuthority } from "../cliniko/outbound-launch-records.ts";
import { ClinikoOutboundLaunchHistory } from "../cliniko/outbound-launch-history.ts";
import type { OutboundLaunchHistoryAuthority } from "../cliniko/outbound-launch-history.ts";
import { ClinikoOutboundContactSource } from "../cliniko/outbound-contact-source.ts";
import type { OutboundContactSourceConfig, OutboundContactDefinition, OutboundContactAuthority } from "../cliniko/outbound-contact-source.ts";
import { outboundRecipientRequestDigest } from "../cliniko/outbound-recipient-request.ts";
import type { OutboundLaunchAttempt } from "../cliniko/outbound-launch-attempt.ts";
import { checkClinikoHeadroom } from "../cliniko/read-budget.ts";
import { OwnerFileOutboundCampaign } from "./owner-file-outbound-campaign.ts";
import type { OutboundCampaignApproval } from "./owner-file-outbound-campaign.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { ClinikoOutboundAppointmentTarget } from "../cliniko/outbound-appointment-target.ts";
import type { OutboundTargetAuthority, OutboundTargetObservation, OutboundTargetQuery } from "../cliniko/outbound-appointment-target.ts";

import type { OutboundContactSourceSelection } from "../cliniko/internal/outbound-contact-source-context.ts";
import { contactSourceSelection } from "../cliniko/outbound-contact-source.ts";
import { ClinikoOutboundNumberStops } from "./cliniko-outbound-number-stops.ts";
import type { OutboundNumberStopAuthority, OutboundNumberStopQuery } from "./cliniko-outbound-number-stops.ts";
import { OwnerFileOutboundContactAccount } from "./owner-file-outbound-contact-account.ts";
import type { OutboundProviderBinding, OutboundLaunchProvider } from "../voice/outbound-runtime.ts";
export type { OutboundProviderBinding, OutboundLaunchProvider } from "../voice/outbound-runtime.ts";
export type OutboundLaunchQuery = Readonly<{ operation: "approveAudience" | "approveProvider" | "producerAdmitted" | "approveLaunch" | "approveAppointmentTarget" | "approveContactSafety";
  ownerBinding: string; record: OutboundRecipientRecord; campaign: OutboundCampaignApproval; provider: OutboundProviderBinding;
  target?: Readonly<Pick<OutboundTargetObservation, "target" | "digest"> & { appointmentPolicyDigest: string }>;
  contactSafety?: Readonly<{ guardRef: string; ownerBinding: string; accountBinding: string }> }>;
export type OutboundLaunchAuthority = Readonly<{
  allows(query: OutboundLaunchQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundLaunchQuery, signal: AbortSignal): boolean;
}>;
export type OutboundLaunchOwnerConfig = Readonly<{
  requests: OutboundRecordConfig; attempts: OutboundLaunchRecordConfig; contact: OutboundContactSourceConfig;
  campaignRef: string; campaign: OwnerFileOutboundCampaign;
  /** Explicit staff-owned sick-day target observation. This is neither patient
   * verification nor permission for any subsequent clinical action. */
  individualTarget?: Readonly<{ appointmentPolicyDigest: string }>;
  /** Opt-in composed safety: bounded native number-stop observation plus one
   * unresolved contact hold across the complete clinic, not per campaign. */
  contactSafety?: Readonly<{ guardRef: string; account: OwnerFileOutboundContactAccount; maximumNativeRequests: number }>;
  /** Reviewed TOTAL native authority/reader/attempt cost for this complete exact
   * profile. No inherited zero/default, reservation or extra account capacity. */
  maximumNativeRequests: number; deadlineMs?: number; dispatchWindowMs?: number;
}>;
type Ports = Readonly<{ request: OutboundRecordReadAuthority; attempt: OutboundLaunchRecordAuthority;
  history: OutboundLaunchHistoryAuthority; contact: OutboundContactAuthority; contactDefinition: OutboundContactDefinition;
  authority: OutboundLaunchAuthority; provider: OutboundLaunchProvider;
  target?: OutboundTargetAuthority; numberStops?: OutboundNumberStopAuthority; contactCapacity?: OutboundCapacity;
  effects: OutboundEffectBarrier; attemptEffects: OutboundEffectBarrier; capacity: OutboundCapacity; native?: typeof fetch }>;
type Failure = Readonly<{ kind: "invalidConfig" | "unavailable" | "forbidden" | "alreadyAttempted" | "capacityUnavailable" }>;
export type OutboundLaunchOutcome = Readonly<{ kind: "accepted" | "unknown"; capacity: "held" }>;
const launchOperations = ["approveAudience", "approveProvider", "producerAdmitted", "approveLaunch"] as const;
const opaque = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(s);
function providerBinding(v: OutboundProviderBinding): boolean {
  return !!v && Object.keys(v).sort().join(",") === "bindingDigest,profileRef,ref" && opaque(v.ref) && opaque(v.profileRef) && /^[a-f0-9]{64}$/.test(v.bindingDigest);
}
export function outboundLaunchOwnerBinding(config: OutboundLaunchOwnerConfig): string | undefined {
  const source = outboundRecordOwnerBinding(config.requests);
  return source && outboundCapacityOwnerBinding(config.campaignRef) ? createHash("sha256").update(JSON.stringify(["abby.outbound-launch-owner.v1", source, config.campaignRef])).digest("hex") : undefined;
}
class Refusal extends Error { readonly kind: Failure["kind"]; constructor(kind: Failure["kind"]) { super("Outbound launch unavailable"); this.kind = kind; } }
const closed = (record: OutboundRecipientRecord) => record.recalled || record.recalledAt !== null || record.archivedAt !== null;

/** Conditional one-shot general follow-up or explicitly composed exact sick-day
 * launch. Protected callback actions still need independent patient verification
 * and clinical authority. No scheduler or default route.
 * Private native context stays volatile; local stores contain opaque IDs only. */
export class ClinikoOutboundLaunchOwner {
  readonly #config: OutboundLaunchOwnerConfig;
  readonly #ports: Ports;
  readonly #requests: Pick<ClinikoOutboundRecipientRecords, "readRequest">;
  readonly #attempts: ClinikoOutboundLaunchRecords;
  readonly #history: ClinikoOutboundLaunchHistory;
  readonly #contact: ClinikoOutboundContactSource;
  readonly #owner: string;
  readonly #contactAccountCurrent: OwnerFileOutboundContactAccount["current"] | undefined;
  readonly #contactAccountMethods: readonly unknown[];
  readonly #contactAccountBinding: string | undefined;
  readonly #contactSource: OutboundContactSourceSelection;
  readonly #campaign: Readonly<Pick<OwnerFileOutboundCampaign, "current" | "currentFor">>;
  private constructor(config: OutboundLaunchOwnerConfig, ports: Ports, requests: Pick<ClinikoOutboundRecipientRecords, "readRequest">,
    attempts: ClinikoOutboundLaunchRecords, history: ClinikoOutboundLaunchHistory, contact: ClinikoOutboundContactSource, owner: string) {
    this.#contactAccountCurrent = config.contactSafety?.account.current.bind(config.contactSafety.account);
    this.#contactAccountMethods = config.contactSafety ? Object.freeze([config.contactSafety.account.current, config.contactSafety.account.matches, config.contactSafety.account.bindingFingerprint]) : [];
    this.#contactAccountBinding = config.contactSafety?.account.bindingFingerprint();
    this.#contactSource = contactSourceSelection(config.contact);
    this.#config = config; this.#ports = ports; this.#requests = requests; this.#attempts = attempts;
    this.#history = history; this.#contact = contact; this.#owner = owner;
    this.#campaign = Object.freeze({ current: config.campaign.current.bind(config.campaign), currentFor: config.campaign.currentFor.bind(config.campaign) });
  }
  static create(input: OutboundLaunchOwnerConfig, incoming: Ports): Result<ClinikoOutboundLaunchOwner, Failure> {
    try {
      const owner = outboundLaunchOwnerBinding(input), capacity = outboundCapacityOwnerBinding(input.campaignRef);
      if (!owner || !capacity || !(input.campaign instanceof OwnerFileOutboundCampaign) || !Number.isSafeInteger(input.maximumNativeRequests) ||
          input.maximumNativeRequests < 1 || input.maximumNativeRequests > 180 ||
          !Number.isSafeInteger(input.deadlineMs ?? 60_000) || (input.deadlineMs ?? 60_000) < 1 || (input.deadlineMs ?? 60_000) > 120_000 ||
          !Number.isSafeInteger(input.dispatchWindowMs ?? 10_000) || (input.dispatchWindowMs ?? 10_000) < 1 || (input.dispatchWindowMs ?? 10_000) > 30_000 ||
          incoming.effects.matches(input.requests.scope, owner) !== true || incoming.capacity.matches(input.requests.scope, capacity) !== true ||
          [incoming.authority.allows, incoming.authority.current, incoming.provider.binding, incoming.provider.launchOnce].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      for (const other of [input.attempts, input.contact]) if (!sameScope(input.requests.scope, other.scope) || input.requests.apiKey !== other.apiKey ||
        input.requests.businessId !== other.businessId || input.requests.rateBudget !== other.rateBudget) return err({ kind: "invalidConfig" });
      const safety = input.contactSafety;
      if (safety !== undefined) {
        const guard = outboundContactGuardOwnerBinding(safety.guardRef);
        if (!guard || !(safety.account instanceof OwnerFileOutboundContactAccount) || !incoming.numberStops || !incoming.contactCapacity ||
            incoming.contactCapacity.matches(input.requests.scope, guard) !== true ||
            !ClinikoOutboundNumberStops.create({ requests: input.requests, source: contactSourceSelection(input.contact), account: safety.account,
              maximumNativeRequests: safety.maximumNativeRequests }, incoming.numberStops, incoming.native).ok) return err({ kind: "invalidConfig" });
      } else if (incoming.numberStops !== undefined || incoming.contactCapacity !== undefined) return err({ kind: "invalidConfig" });
      const requests = ClinikoOutboundRecipientRecords.createReadOnly(input.requests, incoming.request, incoming.native);
      const attempts = ClinikoOutboundLaunchRecords.create(input.attempts, incoming.attempt, incoming.attemptEffects, incoming.native);
      const history = ClinikoOutboundLaunchHistory.create(input.attempts, incoming.history, incoming.native);
      const contact = ClinikoOutboundContactSource.create(input.contact, incoming.contactDefinition, incoming.contact, incoming.native);
      if (!requests.ok || !attempts.ok || !history.ok || !contact.ok) return err({ kind: "invalidConfig" });
      if (input.individualTarget !== undefined && (!incoming.target || !ClinikoOutboundAppointmentTarget.create({ requests: input.requests,
        appointmentPolicyDigest: input.individualTarget.appointmentPolicyDigest }, incoming.target, incoming.native).ok)) return err({ kind: "invalidConfig" });
      const ports = Object.freeze({ ...incoming,
        ...(incoming.numberStops ? { numberStops: Object.freeze({ allows: incoming.numberStops.allows.bind(incoming.numberStops), current: incoming.numberStops.current.bind(incoming.numberStops) }) } : {}),
        ...(incoming.contactCapacity ? { contactCapacity: Object.freeze({ matches: incoming.contactCapacity.matches.bind(incoming.contactCapacity), acquireOnce: incoming.contactCapacity.acquireOnce.bind(incoming.contactCapacity), releaseOnce: incoming.contactCapacity.releaseOnce.bind(incoming.contactCapacity) }) } : {}),
        ...(incoming.target ? { target: Object.freeze({ allows: incoming.target.allows.bind(incoming.target), current: incoming.target.current.bind(incoming.target) }) } : {}),
        effects: Object.freeze({ matches: incoming.effects.matches.bind(incoming.effects), claimOnce: incoming.effects.claimOnce.bind(incoming.effects) }),
        capacity: Object.freeze({ matches: incoming.capacity.matches.bind(incoming.capacity), acquireOnce: incoming.capacity.acquireOnce.bind(incoming.capacity), releaseOnce: incoming.capacity.releaseOnce.bind(incoming.capacity) }),
        authority: Object.freeze({ allows: incoming.authority.allows.bind(incoming.authority), current: incoming.authority.current.bind(incoming.authority) }),
        provider: Object.freeze({ binding: incoming.provider.binding.bind(incoming.provider), launchOnce: incoming.provider.launchOnce.bind(incoming.provider) }) });
      const physical = input.requests.rateBudget;
      const config = Object.freeze({ ...input, ...(safety ? { contactSafety: Object.freeze({ ...safety }) } : {}), ...(input.individualTarget ? { individualTarget: Object.freeze({ ...input.individualTarget }) } : {}), requests: Object.freeze({ ...input.requests, scope: Object.freeze({ ...input.requests.scope }),
        ...(input.requests.clock ? { clock: input.requests.clock.bind(input.requests) } : {}),
        rateBudget: Object.freeze({ claim: physical.claim.bind(physical), observe429: physical.observe429.bind(physical),
          ...(physical.checkHeadroom ? { checkHeadroom: physical.checkHeadroom.bind(physical) } : {}) }) }) });
      return ok(new ClinikoOutboundLaunchOwner(config, ports, requests.value, attempts.value, history.value, contact.value, owner));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async launchOnce(binding: Readonly<{ recallRef: string; actionRef: string; patientId: string }>, external: AbortSignal,
    parentCurrent?: (campaign: OutboundCampaignApproval) => boolean): Promise<Result<OutboundLaunchOutcome, Failure>> {
    if (!(external instanceof AbortSignal) || external.aborted || parentCurrent !== undefined && typeof parentCurrent !== "function") return err({ kind: "unavailable" });
    let selected: typeof binding;
    try { selected = Object.freeze(structuredClone(binding)); } catch { return err({ kind: "unavailable" }); }
    const controller = new AbortController(), ms = this.#config.deadlineMs ?? 60_000, timer = setTimeout(() => controller.abort(), ms);
    const signal = AbortSignal.any([external, controller.signal]), began = performance.now();
    const clock = this.#config.requests.clock ?? (() => new Date().toISOString());
    const allocation = randomUUID(), contactAllocation = randomUUID(); let contactAcquired = false, acquired = false, providerInvoked = false, dispatched = false, accepted = false, edgeInvoked = false;
    let q: OutboundLaunchQuery | undefined, own: { recallRef: string; attempt: OutboundLaunchAttempt } | undefined;
    let targetGrant: OutboundTargetQuery | undefined;
    const numberGrants = new Map<string, OutboundNumberStopQuery>();
    const safety = this.#config.contactSafety;
    const accountMethodsCurrent = () => {
      try { return !safety || [safety.account.current, safety.account.matches, safety.account.bindingFingerprint].every((method, index) => method === this.#contactAccountMethods[index]); }
      catch { return false; }
    };
    if (!accountMethodsCurrent()) { clearTimeout(timer); controller.abort(); return err({ kind: "forbidden" }); }
    const numberReader = safety && this.#ports.numberStops ? ClinikoOutboundNumberStops.create({ requests: this.#config.requests,
      source: this.#contactSource, account: safety.account, maximumNativeRequests: safety.maximumNativeRequests }, {
      allows: async (query, sourceSignal) => {
        const allowed = await this.#ports.numberStops!.allows(query, sourceSignal);
        if (allowed === true) {
          const key = query.operation + ":" + ("recallRef" in query ? query.recallRef : "entry" in query ? query.entry.review.actionRef : "stop" in query ? query.stop.review.actionRef : "account");
          const old = numberGrants.get(key);
          if (!(query.operation === "readContactNumberReview" && !query.review && old?.operation === "readContactNumberReview" && old.review)) numberGrants.set(key, query);
        }
        return allowed;
      }, current: this.#ports.numberStops.current,
    }, this.#ports.native) : undefined;
    let lastNow = -Infinity;
    let consentWindow: Readonly<{ observedAt: string; effectiveFrom: string; effectiveUntil: string }> | undefined;
    const now = () => {
      const text = clock(), value = Date.parse(text);
      if (!Number.isFinite(value) || new Date(value).toISOString() !== text || value < lastNow) throw new Refusal("unavailable");
      lastNow = value; return text;
    };
    const active = () => !signal.aborted && performance.now() - began <= ms;
    const targetOperations = () => [...launchOperations, ...(q?.target ? ["approveAppointmentTarget" as const] : []), ...(safety ? ["approveContactSafety" as const] : [])];
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      const value = await awaitUntilAbort(promise, signal); if (value === undefined || !active()) throw new Refusal("unavailable"); return value;
    };
    const current = () => {
      const at = now();
      if (!active() || !q || !accountMethodsCurrent() || parentCurrent && parentCurrent(q.campaign) !== true || this.#ports.effects.matches(this.#config.requests.scope, this.#owner) !== true ||
          this.#ports.capacity.matches(this.#config.requests.scope, outboundCapacityOwnerBinding(this.#config.campaignRef)!) !== true || targetOperations().some(operation => this.#ports.authority.current(Object.freeze({ ...q!, operation }), signal) !== true) || !isDeepStrictEqual(this.#ports.provider.binding(), q.provider) ||
          targetGrant && this.#ports.target?.current(targetGrant, signal) !== true ||
          safety && (this.#ports.contactCapacity?.matches(this.#config.requests.scope, outboundContactGuardOwnerBinding(safety.guardRef)!) !== true ||
            [...numberGrants.values()].some(grant => this.#ports.numberStops?.current(grant, signal) !== true ||
              grant.operation === "approveContactNumberHead" && grant.entry.review.consent === "granted" && grant.entry.review.doNotCall === "clear" &&
              (at < grant.entry.review.effectiveFrom || at >= grant.entry.review.effectiveUntil))) ||
          q.target && Date.parse(q.target.target.startsAt) <= Date.parse(at) ||
          outboundContactTime(q.record.request.schedule, at).kind !== "due" ||
          consentWindow && (consentWindow.observedAt > at || consentWindow.effectiveFrom > at || at >= consentWindow.effectiveUntil)) throw new Refusal("forbidden");
    };
    const targetReader = this.#config.individualTarget && this.#ports.target ? ClinikoOutboundAppointmentTarget.create({
      requests: this.#config.requests, appointmentPolicyDigest: this.#config.individualTarget.appointmentPolicyDigest }, {
      allows: this.#ports.target.allows, current: (g, s) => {
        if (g.target || !targetGrant) targetGrant = g;
        return this.#ports.target!.current(g, s);
      } }, this.#ports.native) : undefined;
    const readTarget = async (record: OutboundRecipientRecord) => {
      if (!targetReader?.ok || record.request.purpose !== "sickDay" || !record.request.appointment) throw new Refusal("forbidden");
      const observation = await wait(targetReader.value.readForRequest(record.request, signal));
      if (!observation.ok) throw new Refusal("forbidden");
      const t = observation.value.target, at = now();
      if (t.archivedAt !== null || t.cancelledAt !== null || t.deletedAt !== null || t.patientArrived === true || t.didNotArrive === true ||
          Date.parse(t.startsAt) <= Date.parse(at) || observation.value.observedAt > at) throw new Refusal("forbidden");
      return Object.freeze({ target: t, digest: observation.value.digest,
        appointmentPolicyDigest: this.#config.individualTarget!.appointmentPolicyDigest });
    };
    const prepare = async () => {
      const policy = await wait(this.#campaign.current(signal));
      if (!policy.ok || !policy.value || policy.value.campaignRef !== this.#config.campaignRef ||
          policy.value.purpose !== "followUp" && !(policy.value.purpose === "sickDay" && targetReader?.ok)) throw new Refusal("forbidden");
      if (parentCurrent && parentCurrent(policy.value) !== true) throw new Refusal("forbidden");
      const record = await wait(this.#requests.readRequest(selected, signal));
      if (!record.ok || closed(record.value)) throw new Refusal("forbidden");
      const targeted = policy.value.purpose === "sickDay";
      if (record.value.request.purpose !== policy.value.purpose || !targeted && record.value.request.appointment !== undefined) throw new Refusal("forbidden");
      const target = targeted ? await readTarget(record.value) : undefined;
      const bound = await wait(this.#campaign.currentFor(outboundRecordSelection(this.#config.requests), record.value.request, signal));
      const provider = Object.freeze({ ...this.#ports.provider.binding() });
      if (!bound.ok || !bound.value || !isDeepStrictEqual(bound.value, policy.value) || !providerBinding(provider) || provider.ref !== bound.value.providerRef) throw new Refusal("forbidden");
      if (safety) {
        const account = this.#contactAccountCurrent && await wait(this.#contactAccountCurrent(signal));
        if (!account || !account.ok || account.value?.account.contactGuardRef !== safety.guardRef) throw new Refusal("forbidden");
      }
      const next = Object.freeze({ operation: "approveAudience" as const, ownerBinding: this.#owner, record: record.value, campaign: bound.value, provider,
        ...(target ? { target } : {}), ...(safety ? { contactSafety: Object.freeze({ guardRef: safety.guardRef,
          ownerBinding: outboundContactGuardOwnerBinding(safety.guardRef)!, accountBinding: this.#contactAccountBinding! }) } : {}) });
      if (q && (!isDeepStrictEqual(q.record, next.record) || !isDeepStrictEqual(q.campaign, next.campaign) || !isDeepStrictEqual(q.provider, next.provider) || !isDeepStrictEqual(q.target, next.target))) throw new Refusal("forbidden");
      q = next; current();
      for (const operation of targetOperations()) {
        const query = Object.freeze({ ...q, operation });
        if (await wait(Promise.resolve().then(() => this.#ports.authority.allows(query, signal))) !== true || this.#ports.authority.current(query, signal) !== true) throw new Refusal("forbidden");
        current();
      }
      const consent = await wait(this.#contact.readCurrentForRequest(q.record.request, signal));
      if (!consent.ok || consent.value.disposition !== "eligibleEvidence" || !consent.value.head ||
          consent.value.requestDigest !== outboundRecipientRequestDigest(q.record.request)) throw new Refusal("forbidden");
      // Reader-local time cannot authorize a later dispatch. Keep the verified
      // review window in the synchronous fence across subsequent native waits.
      consentWindow = Object.freeze({ observedAt: consent.value.observedAt, effectiveFrom: consent.value.head.review.effectiveFrom,
        effectiveUntil: consent.value.head.review.effectiveUntil });
      current();
      if (safety) {
        if (!numberReader?.ok) throw new Refusal("forbidden");
        const observed = await wait(numberReader.value.readForRequest(q.record.request, signal));
        if (!observed.ok || observed.value.disposition !== "noRecordedStopObserved" || observed.value.requestDigest !== outboundRecipientRequestDigest(q.record.request) ||
            observed.value.accountBinding !== q.contactSafety?.accountBinding || observed.value.observedAt > now()) throw new Refusal("forbidden");
        current();
      }
      const history = await wait(this.#history.readForRequest({ recallRef: q.record.recallRef, request: q.record.request }, signal));
      if (!history.ok || history.value.records.some(r => !own || r.recallRef !== own.recallRef || !isDeepStrictEqual(r.attempt, own.attempt) || r.recalled || r.archivedAt !== null) ||
          own && history.value.records.length !== 1) throw new Refusal("alreadyAttempted");
      const lastPolicy = await wait(this.#campaign.currentFor(outboundRecordSelection(this.#config.requests), q.record.request, signal));
      if (!lastPolicy.ok || !lastPolicy.value || !isDeepStrictEqual(lastPolicy.value, q.campaign)) throw new Refusal("forbidden");
      // Complete every other native/grant wait first, then observe the same
      // original target again. No list, nearest appointment or replacement is
      // selected if it changed. This remains a fresh observation, never a CAS.
      if (q.target && !isDeepStrictEqual(await readTarget(q.record), q.target)) throw new Refusal("forbidden");
      current();
    };
    try {
      if (await wait(checkClinikoHeadroom(this.#config.requests.rateBudget, this.#config.maximumNativeRequests)) !== null) throw new Refusal("unavailable");
      await prepare();
      if (safety) {
        current(); const contact = await wait(this.#ports.contactCapacity!.acquireOnce(contactAllocation, 1));
        if (!contact.ok || contact.value.kind !== "acquired") throw new Refusal("capacityUnavailable"); contactAcquired = true;
      }
      const a = await wait(this.#ports.capacity.acquireOnce(allocation, q!.campaign.maximumConcurrent));
      if (!a.ok || a.value.kind !== "acquired") throw new Refusal("capacityUnavailable"); acquired = true;
      await prepare();
      for (const ref of [q!.record.request.approvalRef, q!.record.request.effectRef]) {
        current(); const claim = await wait(this.#ports.effects.claimOnce(ref));
        if (!claim.ok || !claim.value.claimed) throw new Refusal("alreadyAttempted");
      }
      const r = q!.record.request, attemptedAt = now();
      const attempt: OutboundLaunchAttempt = Object.freeze({ actionRef: randomUUID(), capacityAllocationRef: allocation,
        dncReferences: Object.freeze({ actionRef: randomUUID(), approvalRef: randomUUID() }),
        ...(safety ? { contactReferences: Object.freeze({ guardRef: safety.guardRef, allocationRef: contactAllocation, outcomeActionRef: randomUUID() }) } : {}), requestRecallRef: q!.record.recallRef, requestActionRef: r.actionRef,
        requestDigest: outboundRecipientRequestDigest(r)!, campaignRef: r.campaignRef, approvalRef: r.approvalRef, effectRef: r.effectRef,
        scope: r.scope, businessId: r.businessId, credentialFingerprint: r.credentialFingerprint, patientId: r.patientId,
        provider: Object.freeze({ ref: q!.provider.ref, bindingDigest: q!.provider.bindingDigest }), attemptedAt,
        dispatchNotAfter: new Date(Math.min(Date.parse(r.schedule.expiresAt), Date.parse(attemptedAt) + (this.#config.dispatchWindowMs ?? 10_000))).toISOString() });
      const retained = await wait(this.#attempts.retainPossibleAttemptOnce(attempt, q!.record.recallAt, signal));
      if (!retained.ok || retained.value.kind !== "accepted") throw new Refusal("unavailable");
      own = { recallRef: retained.value.recallRef, attempt }; await prepare();
      providerInvoked = true;
      const result = await wait(this.#ports.provider.launchOnce(Object.freeze({ effectRef: r.effectRef, capacityAllocationRef: allocation, number: r.recipient.number, profileRef: q!.provider.profileRef }), signal,
        async () => {
          if (edgeInvoked || !active()) return false; edgeInvoked = true;
          try { await prepare(); if (now() >= attempt.dispatchNotAfter) return false; current(); dispatched = true; return true; }
          catch { return false; }
        }, ref => { if (dispatched && ref === r.effectRef) accepted = true; }));
      if (dispatched && result.kind === "accepted" && result.effectRef === r.effectRef) accepted = true;
      return dispatched ? ok({ kind: accepted ? "accepted" : "unknown", capacity: "held" }) : err({ kind: "forbidden" });
    } catch (error) {
      return accepted ? ok({ kind: "accepted", capacity: "held" }) : providerInvoked ? ok({ kind: "unknown", capacity: "held" })
        : err({ kind: error instanceof Refusal ? error.kind : "unavailable" });
    } finally {
      clearTimeout(timer); controller.abort();
      // No provider method was even invoked: this process can prove no dispatch
      // was queued. Once invoked, every result retains the place for a separate
      // trusted terminal/recovery owner; neither timeout nor definitive-looking
      // unqualified payload frees capacity automatically.
      // This independent hold is deliberately NOT released by call-terminal
      // recovery. Missing/unknown contact outcome, native ACK loss or process
      // loss stays blocked; no TTL, heartbeat or local absence clears it.
      if (contactAcquired && !providerInvoked) { try { await awaitUntilAbort(this.#ports.contactCapacity!.releaseOnce(contactAllocation), AbortSignal.timeout(1000)); } catch { /* Hold remains conservative. */ } }
      if (acquired && !providerInvoked) { try { await awaitUntilAbort(this.#ports.capacity.releaseOnce(allocation), AbortSignal.timeout(1000)); } catch { /* Occupancy remains conservative. */ } }
    }
  }
}
