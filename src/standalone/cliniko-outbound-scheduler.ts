import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { outboundContactTime } from "../core/outbound-contact-time.ts";
import { checkClinikoHeadroom } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { ClinikoOutboundPendingDiscovery } from "../cliniko/outbound-pending-discovery.ts";
import type { OutboundPendingAuthority } from "../cliniko/outbound-pending-discovery.ts";
import { outboundRecordSelection } from "../cliniko/internal/outbound-record-context.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoOutboundLaunchOwner } from "./cliniko-outbound-launch-owner.ts";
import type { OutboundLaunchOwnerConfig } from "./cliniko-outbound-launch-owner.ts";
import type { OutboundCampaignApproval } from "./owner-file-outbound-campaign.ts";

type LaunchPorts = Parameters<typeof ClinikoOutboundLaunchOwner.create>[1];
export type OutboundScheduleQuery = Readonly<{ operation: "scheduleAudience"; campaign: OutboundCampaignApproval;
  selection: ReturnType<typeof outboundRecordSelection> }>;
export type OutboundScheduleAuthority = Readonly<{
  allows(query: OutboundScheduleQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundScheduleQuery, signal: AbortSignal): boolean;
}>;
export type OutboundSchedulerConfig = Readonly<{ launch: OutboundLaunchOwnerConfig;
  /** Reviewed TOTAL first-stage campaign/account/record-read cost for this
   * exact native/authority profile. No zero/default or quota reservation. */
  maximumScanNativeRequests: number; tickDeadlineMs: number }>;
type Ports = Readonly<{ launch: LaunchPorts; pending: OutboundPendingAuthority; schedule: OutboundScheduleAuthority;
  waitForQuota?(milliseconds: number, signal: AbortSignal): Promise<void> }>;
export type OutboundTickSummary = Readonly<{ kind: "idle" | "observed" | "quotaWaiting" | "capacityWaiting" | "blocked" | "interrupted";
  considered: number; accepted: number; unknown: number; refused: number; alreadyAttempted: number }>;

/** One explicitly invoked finite scheduling tick. Private audience data exists
 * only in this invocation; a later tick rescans native truth. No daemon/default
 * route, private queue, retry payload or global campaign-completion claim.
 * Known launch observations survive a later cancellation. */
export class ClinikoOutboundScheduler {
  readonly #config: OutboundSchedulerConfig;
  readonly #owner: ClinikoOutboundLaunchOwner;
  readonly #budget: ClinikoRequestBudget;
  readonly #ports: Pick<Ports, "pending" | "schedule" | "waitForQuota">;
  readonly #native: LaunchPorts["native"];
  readonly #campaign: OutboundLaunchOwnerConfig["campaign"]["current"];
  readonly #clock: () => string;
  private constructor(config: OutboundSchedulerConfig, owner: ClinikoOutboundLaunchOwner, budget: ClinikoRequestBudget, ports: Ports) {
    this.#config = Object.freeze({ ...config, launch: Object.freeze({ ...config.launch,
      requests: Object.freeze({ ...config.launch.requests, scope: Object.freeze({ ...config.launch.requests.scope }), rateBudget: budget,
        ...(config.launch.requests.clock ? { clock: config.launch.requests.clock.bind(config.launch.requests) } : {}) }) }) });
    this.#owner = owner; this.#budget = budget; this.#native = ports.launch.native;
    this.#clock = config.launch.requests.clock?.bind(config.launch.requests) ?? (() => new Date().toISOString());
    this.#campaign = config.launch.campaign.current.bind(config.launch.campaign);
    this.#ports = Object.freeze({
      pending: Object.freeze({ allowsPendingRead: ports.pending.allowsPendingRead.bind(ports.pending),
        allowsRecordRead: ports.pending.allowsRecordRead.bind(ports.pending), current: ports.pending.current.bind(ports.pending) }),
      schedule: Object.freeze({ allows: ports.schedule.allows.bind(ports.schedule), current: ports.schedule.current.bind(ports.schedule) }),
      ...(ports.waitForQuota ? { waitForQuota: ports.waitForQuota.bind(ports) } : {}) });
  }
  static create(config: OutboundSchedulerConfig, ports: Ports): Result<ClinikoOutboundScheduler, Readonly<{ kind: "invalidConfig" }>> {
    try {
      const source = config.launch.requests.rateBudget;
      if (!Number.isSafeInteger(config.maximumScanNativeRequests) || config.maximumScanNativeRequests < 1 || config.maximumScanNativeRequests > 180 ||
          !Number.isSafeInteger(config.tickDeadlineMs) || config.tickDeadlineMs < 1 || config.tickDeadlineMs > 120_000 ||
          typeof source.checkHeadroom !== "function" || typeof ports.schedule.allows !== "function" || typeof ports.schedule.current !== "function" ||
          ports.waitForQuota !== undefined && typeof ports.waitForQuota !== "function") return err({ kind: "invalidConfig" });
      const owner = ClinikoOutboundLaunchOwner.create(config.launch, ports.launch);
      const pending = ClinikoOutboundPendingDiscovery.create(config.launch.requests, ports.pending, ports.launch.native);
      if (!owner.ok || !pending.ok) return err({ kind: "invalidConfig" });
      const budget = Object.freeze({ claim: source.claim.bind(source), observe429: source.observe429.bind(source), checkHeadroom: source.checkHeadroom.bind(source) });
      return ok(new ClinikoOutboundScheduler(config, owner.value, budget, ports));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async tick(external: AbortSignal): Promise<OutboundTickSummary> {
    const counts = { considered: 0, accepted: 0, unknown: 0, refused: 0, alreadyAttempted: 0 };
    const summary = (kind: OutboundTickSummary["kind"]): OutboundTickSummary => Object.freeze({ kind, ...counts });
    if (!(external instanceof AbortSignal) || external.aborted) return summary("interrupted");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.#config.tickDeadlineMs);
    const signal = AbortSignal.any([external, controller.signal]), began = performance.now();
    let last = "", query: OutboundScheduleQuery | undefined;
    const active = () => !signal.aborted && performance.now() - began <= this.#config.tickDeadlineMs;
    const now = () => {
      const at = this.#clock(), parsed = Date.parse(at);
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== at || at < last) throw new Error("Unavailable time");
      last = at; return at;
    };
    const current = () => active() && !!query && this.#ports.schedule.current(query, signal) === true &&
      outboundContactTime(query.campaign.schedule, now()).kind === "due";
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      const result = await awaitUntilAbort(task, signal);
      if (result === undefined || !active()) throw new Error("Unavailable scheduling stage"); now(); return result;
    };
    try {
      now();
      const admission = await wait(checkClinikoHeadroom(this.#budget, this.#config.maximumScanNativeRequests));
      if (admission) return summary(admission.kind === "rateLimited" ? "quotaWaiting" : "blocked");
      const policy = await wait(this.#campaign(signal));
      if (!policy.ok) return summary("blocked");
      if (!policy.value) return summary("idle");
      // Exact sick-day targets still belong to the one-shot launch owner. Its
      // separately configured reader/grants recheck the original at dispatch.
      const supported = policy.value.purpose === "followUp" ||
        policy.value.purpose === "sickDay" && this.#config.launch.individualTarget !== undefined;
      if (policy.value.campaignRef !== this.#config.launch.campaignRef || !supported) return summary("blocked");
      const due = outboundContactTime(policy.value.schedule, now());
      if (due.kind === "invalid") return summary("blocked");
      if (due.kind !== "due") return summary("idle");
      query = Object.freeze({ operation: "scheduleAudience", campaign: policy.value,
        selection: outboundRecordSelection(this.#config.launch.requests) });
      if (!current() || await wait(Promise.resolve().then(() => this.#ports.schedule.allows(query!, signal))) !== true || !current()) return summary("blocked");
      const discovery = ClinikoOutboundPendingDiscovery.create(this.#config.launch.requests, {
        allowsPendingRead: (q, s) => current() ? this.#ports.pending.allowsPendingRead(q, s) : Promise.resolve(false),
        allowsRecordRead: (q, s) => current() ? this.#ports.pending.allowsRecordRead(q, s) : Promise.resolve(false),
        current: (q, s) => current() && this.#ports.pending.current(q, s) === true
      }, this.#native);
      if (!discovery.ok) return summary("blocked");
      const found = await wait(discovery.value.scanPending(signal));
      if (!found.ok || !current()) return summary("blocked");
      for (const record of found.value.records) {
        if (record.request.campaignRef !== query.campaign.campaignRef) continue;
        if (!current()) return summary(active() ? "blocked" : "interrupted");
        let available = await wait(checkClinikoHeadroom(this.#budget, this.#config.launch.maximumNativeRequests));
        if (available?.kind === "rateLimited") {
          const reset = available.resetAt ? Date.parse(available.resetAt) - Date.parse(now()) : 0;
          const ms = Math.max(reset, available.retryAfterMs ?? 0);
          const remaining = this.#config.tickDeadlineMs - (performance.now() - began);
          if (!Number.isFinite(ms) || ms < 1 || ms >= remaining) return summary("quotaWaiting");
          // Only an explicit pre-dispatch headroom denial may wait. After one
          // bounded wait, recheck physical capacity and every current parent/
          // native launch grant. No uncertain attempt is retried here.
          await wait((this.#ports.waitForQuota ? this.#ports.waitForQuota(Math.ceil(ms), signal) : delay(Math.ceil(ms), undefined, { signal })).then(() => true));
          if (!current()) return summary(active() ? "blocked" : "interrupted");
          available = await wait(checkClinikoHeadroom(this.#budget, this.#config.launch.maximumNativeRequests));
        }
        if (available) return summary(available.kind === "rateLimited" ? "quotaWaiting" : "blocked");
        if (!current()) return summary("blocked"); counts.considered++;
        // Await the actual bounded owner instead of racing its result again:
        // its exact ACK must survive an outer cancellation/observer failure.
        const launched = await this.#owner.launchOnce({ recallRef: record.recallRef,
          actionRef: record.request.actionRef, patientId: record.request.patientId }, signal,
        campaign => current() && isDeepStrictEqual(campaign, query!.campaign));
        if (launched.ok) {
          if (launched.value.kind === "accepted") counts.accepted++; else counts.unknown++;
        } else if (launched.error.kind === "alreadyAttempted") counts.alreadyAttempted++;
        else if (launched.error.kind === "capacityUnavailable") return summary("capacityWaiting");
        else if (launched.error.kind === "forbidden") counts.refused++;
        else return summary(active() ? "blocked" : "interrupted");
        if (!active()) return summary("interrupted");
      }
      return summary("observed");
    } catch { return summary(active() ? "blocked" : "interrupted"); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
