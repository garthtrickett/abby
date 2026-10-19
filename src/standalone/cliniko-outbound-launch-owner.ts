import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { outboundCapacityOwnerBinding } from "../core/outbound-capacity.ts";
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

export type OutboundProviderBinding = Readonly<{ ref: string; bindingDigest: string; profileRef: string }>;
/** A selected trusted adapter must invoke beforeSend after all internal waits,
 * immediately before its only provider dispatch. Only exact parsed provider ACK
 * calls acknowledged. No live adapter or listener is installed by this module. */
export type OutboundLaunchProvider = Readonly<{
  binding(): OutboundProviderBinding;
  launchOnce(payload: Readonly<{ effectRef: string; capacityAllocationRef: string; number: string; profileRef: string }>, signal: AbortSignal,
    beforeSend: () => Promise<boolean>, acknowledged: (effectRef: string) => void): Promise<Readonly<{ kind: "accepted" | "definitiveUnsent" | "unknown"; effectRef?: string }>>;
}>;
export type OutboundLaunchQuery = Readonly<{ operation: "approveAudience" | "approveProvider" | "producerAdmitted" | "approveLaunch";
  ownerBinding: string; record: OutboundRecipientRecord; campaign: OutboundCampaignApproval; provider: OutboundProviderBinding }>;
export type OutboundLaunchAuthority = Readonly<{
  allows(query: OutboundLaunchQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundLaunchQuery, signal: AbortSignal): boolean;
}>;
export type OutboundLaunchOwnerConfig = Readonly<{
  requests: OutboundRecordConfig; attempts: OutboundLaunchRecordConfig; contact: OutboundContactSourceConfig;
  campaignRef: string; campaign: OwnerFileOutboundCampaign;
  /** Reviewed TOTAL native authority/reader/attempt cost for this complete exact
   * profile. No inherited zero/default, reservation or extra account capacity. */
  maximumNativeRequests: number; deadlineMs?: number; dispatchWindowMs?: number;
}>;
type Ports = Readonly<{ request: OutboundRecordReadAuthority; attempt: OutboundLaunchRecordAuthority;
  history: OutboundLaunchHistoryAuthority; contact: OutboundContactAuthority; contactDefinition: OutboundContactDefinition;
  authority: OutboundLaunchAuthority; provider: OutboundLaunchProvider;
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

/** Conditional one-shot general follow-up owner. Exact-target/sick-day and
 * protected callback actions deliberately refuse until their separate native
 * clinical reader/verified workflow is composed. No scheduler or default route.
 * Private native context stays volatile; local stores contain opaque IDs only. */
export class ClinikoOutboundLaunchOwner {
  readonly #config: OutboundLaunchOwnerConfig;
  readonly #ports: Ports;
  readonly #requests: Pick<ClinikoOutboundRecipientRecords, "readRequest">;
  readonly #attempts: ClinikoOutboundLaunchRecords;
  readonly #history: ClinikoOutboundLaunchHistory;
  readonly #contact: ClinikoOutboundContactSource;
  readonly #owner: string;
  readonly #campaign: Readonly<Pick<OwnerFileOutboundCampaign, "current" | "currentFor">>;
  private constructor(config: OutboundLaunchOwnerConfig, ports: Ports, requests: Pick<ClinikoOutboundRecipientRecords, "readRequest">,
    attempts: ClinikoOutboundLaunchRecords, history: ClinikoOutboundLaunchHistory, contact: ClinikoOutboundContactSource, owner: string) {
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
      const requests = ClinikoOutboundRecipientRecords.createReadOnly(input.requests, incoming.request, incoming.native);
      const attempts = ClinikoOutboundLaunchRecords.create(input.attempts, incoming.attempt, incoming.attemptEffects, incoming.native);
      const history = ClinikoOutboundLaunchHistory.create(input.attempts, incoming.history, incoming.native);
      const contact = ClinikoOutboundContactSource.create(input.contact, incoming.contactDefinition, incoming.contact, incoming.native);
      if (!requests.ok || !attempts.ok || !history.ok || !contact.ok) return err({ kind: "invalidConfig" });
      const ports = Object.freeze({ ...incoming,
        effects: Object.freeze({ matches: incoming.effects.matches.bind(incoming.effects), claimOnce: incoming.effects.claimOnce.bind(incoming.effects) }),
        capacity: Object.freeze({ matches: incoming.capacity.matches.bind(incoming.capacity), acquireOnce: incoming.capacity.acquireOnce.bind(incoming.capacity), releaseOnce: incoming.capacity.releaseOnce.bind(incoming.capacity) }),
        authority: Object.freeze({ allows: incoming.authority.allows.bind(incoming.authority), current: incoming.authority.current.bind(incoming.authority) }),
        provider: Object.freeze({ binding: incoming.provider.binding.bind(incoming.provider), launchOnce: incoming.provider.launchOnce.bind(incoming.provider) }) });
      const physical = input.requests.rateBudget;
      const config = Object.freeze({ ...input, requests: Object.freeze({ ...input.requests, scope: Object.freeze({ ...input.requests.scope }),
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
    const allocation = randomUUID(); let acquired = false, providerInvoked = false, dispatched = false, accepted = false, edgeInvoked = false;
    let q: OutboundLaunchQuery | undefined, own: { recallRef: string; attempt: OutboundLaunchAttempt } | undefined;
    let lastNow = -Infinity;
    let consentWindow: Readonly<{ observedAt: string; effectiveFrom: string; effectiveUntil: string }> | undefined;
    const now = () => {
      const text = clock(), value = Date.parse(text);
      if (!Number.isFinite(value) || new Date(value).toISOString() !== text || value < lastNow) throw new Refusal("unavailable");
      lastNow = value; return text;
    };
    const active = () => !signal.aborted && performance.now() - began <= ms;
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      const value = await awaitUntilAbort(promise, signal); if (value === undefined || !active()) throw new Refusal("unavailable"); return value;
    };
    const current = () => {
      const at = now();
      if (!active() || !q || parentCurrent && parentCurrent(q.campaign) !== true || this.#ports.effects.matches(this.#config.requests.scope, this.#owner) !== true ||
          this.#ports.capacity.matches(this.#config.requests.scope, outboundCapacityOwnerBinding(this.#config.campaignRef)!) !== true || launchOperations.some(operation => this.#ports.authority.current(Object.freeze({ ...q!, operation }), signal) !== true) || !isDeepStrictEqual(this.#ports.provider.binding(), q.provider) ||
          outboundContactTime(q.record.request.schedule, at).kind !== "due" ||
          consentWindow && (consentWindow.observedAt > at || consentWindow.effectiveFrom > at || at >= consentWindow.effectiveUntil)) throw new Refusal("forbidden");
    };
    const prepare = async () => {
      const policy = await wait(this.#campaign.current(signal));
      if (!policy.ok || !policy.value || policy.value.campaignRef !== this.#config.campaignRef || policy.value.purpose !== "followUp") throw new Refusal("forbidden");
      if (parentCurrent && parentCurrent(policy.value) !== true) throw new Refusal("forbidden");
      const record = await wait(this.#requests.readRequest(selected, signal));
      if (!record.ok || closed(record.value) || record.value.request.purpose !== "followUp" || record.value.request.appointment !== undefined) throw new Refusal("forbidden");
      const bound = await wait(this.#campaign.currentFor(outboundRecordSelection(this.#config.requests), record.value.request, signal));
      const provider = Object.freeze({ ...this.#ports.provider.binding() });
      if (!bound.ok || !bound.value || !isDeepStrictEqual(bound.value, policy.value) || !providerBinding(provider) || provider.ref !== bound.value.providerRef) throw new Refusal("forbidden");
      const next = Object.freeze({ operation: "approveAudience" as const, ownerBinding: this.#owner, record: record.value, campaign: bound.value, provider });
      if (q && (!isDeepStrictEqual(q.record, next.record) || !isDeepStrictEqual(q.campaign, next.campaign) || !isDeepStrictEqual(q.provider, next.provider))) throw new Refusal("forbidden");
      q = next; current();
      for (const operation of launchOperations) {
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
      const history = await wait(this.#history.readForRequest({ recallRef: q.record.recallRef, request: q.record.request }, signal));
      if (!history.ok || history.value.records.some(r => !own || r.recallRef !== own.recallRef || !isDeepStrictEqual(r.attempt, own.attempt) || r.recalled || r.archivedAt !== null) ||
          own && history.value.records.length !== 1) throw new Refusal("alreadyAttempted");
      const lastPolicy = await wait(this.#campaign.currentFor(outboundRecordSelection(this.#config.requests), q.record.request, signal));
      if (!lastPolicy.ok || !lastPolicy.value || !isDeepStrictEqual(lastPolicy.value, q.campaign)) throw new Refusal("forbidden");
      current();
    };
    try {
      if (await wait(checkClinikoHeadroom(this.#config.requests.rateBudget, this.#config.maximumNativeRequests)) !== null) throw new Refusal("unavailable");
      await prepare();
      const a = await wait(this.#ports.capacity.acquireOnce(allocation, q!.campaign.maximumConcurrent));
      if (!a.ok || a.value.kind !== "acquired") throw new Refusal("capacityUnavailable"); acquired = true;
      await prepare();
      for (const ref of [q!.record.request.approvalRef, q!.record.request.effectRef]) {
        current(); const claim = await wait(this.#ports.effects.claimOnce(ref));
        if (!claim.ok || !claim.value.claimed) throw new Refusal("alreadyAttempted");
      }
      const r = q!.record.request, attemptedAt = now();
      const attempt: OutboundLaunchAttempt = Object.freeze({ actionRef: randomUUID(), capacityAllocationRef: allocation, requestRecallRef: q!.record.recallRef, requestActionRef: r.actionRef,
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
      if (acquired && !providerInvoked) { try { await awaitUntilAbort(this.#ports.capacity.releaseOnce(allocation), AbortSignal.timeout(1000)); } catch { /* Occupancy remains conservative. */ } }
    }
  }
}
