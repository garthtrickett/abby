import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { OutboundCapacity } from "../core/outbound-capacity.ts";
import { outboundCapacityOwnerBinding } from "../core/outbound-capacity.ts";
import { validOutboundEffectScope } from "../portability/outbound-effect-history.ts";
import { ClinikoOutboundLaunchRecords } from "../cliniko/outbound-launch-records.ts";
import type { OutboundLaunchRecord, OutboundLaunchRecordConfig, OutboundLaunchReadAuthority, OutboundLaunchRecordQuery } from "../cliniko/outbound-launch-records.ts";
import { checkClinikoHeadroom } from "../cliniko/read-budget.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

import type { OutboundTerminalProviderBinding, OutboundTerminalProvider } from "../voice/outbound-runtime.ts";
export type { OutboundTerminalProviderBinding, OutboundTerminalProvider } from "../voice/outbound-runtime.ts";
export type OutboundTerminalQuery = Readonly<{ operation: "approveNativeSource" | "readProviderTerminal" | "releaseCapacity";
  record: OutboundLaunchRecord; provider: OutboundTerminalProviderBinding; capacityScope: LocationScope; capacityOwner: string }>;
export type OutboundTerminalAuthority = Readonly<{
  allows(query: OutboundTerminalQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundTerminalQuery, signal: AbortSignal): boolean;
}>;
export type OutboundTerminalConfig = Readonly<{ attempts: OutboundLaunchRecordConfig; campaignRef: string;
  /** Explicit target ownership; source-origin remapping requires its own current
   * approveNativeSource grant, never authority inferred from the old note. */
  capacityScope: LocationScope; maximumNativeRequests: number; deadlineMs?: number }>;
type Ports = Readonly<{ record: OutboundLaunchReadAuthority; provider: OutboundTerminalProvider; authority: OutboundTerminalAuthority;
  capacity: Pick<OutboundCapacity, "matches" | "releaseOnce">; native?: typeof fetch }>;
type Failure = Readonly<{ kind: "invalidConfig" | "unavailable" | "forbidden" | "unrecoverable" }>;
const operations = ["approveNativeSource", "readProviderTerminal", "releaseCapacity"] as const;
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const bindingValid = (v: OutboundTerminalProviderBinding) => v && Object.keys(v).sort().join(",") === "bindingDigest,ref" &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v.ref) && /^[a-f0-9]{64}$/.test(v.bindingDigest);

/** Release-only conditional recovery. It neither launches/retries nor edits
 * native reviews, contact/DNC, appointments or permanent effect exclusions. */
export class ClinikoOutboundTerminalOwner {
  readonly #config: OutboundTerminalConfig;
  readonly #ports: Ports;
  readonly #capacityOwner: string;
  private constructor(config: OutboundTerminalConfig, ports: Ports, capacityOwner: string) {
    this.#config = config; this.#ports = ports; this.#capacityOwner = capacityOwner;
  }
  static create(input: OutboundTerminalConfig, incoming: Ports): Result<ClinikoOutboundTerminalOwner, Failure> {
    try {
      const owner = outboundCapacityOwnerBinding(input.campaignRef), ms = input.deadlineMs ?? 30_000;
      if (!owner || !validOutboundEffectScope(input.capacityScope) || !Number.isSafeInteger(input.maximumNativeRequests) ||
          input.maximumNativeRequests < 1 || input.maximumNativeRequests > 180 || !Number.isSafeInteger(ms) || ms < 1 || ms > 120_000 ||
          incoming.capacity.matches(input.capacityScope, owner) !== true ||
          [incoming.provider.binding, incoming.provider.inspectTerminal, incoming.authority.allows, incoming.authority.current, incoming.capacity.releaseOnce].some(f => typeof f !== "function"))
        return err({ kind: "invalidConfig" });
      const reader = ClinikoOutboundLaunchRecords.createReadOnly(input.attempts, incoming.record, incoming.native);
      if (!reader.ok) return err({ kind: "invalidConfig" });
      const physical = input.attempts.rateBudget;
      const config = Object.freeze({ ...input, capacityScope: Object.freeze({ ...input.capacityScope }),
        attempts: Object.freeze({ ...input.attempts, scope: Object.freeze({ ...input.attempts.scope }),
          ...(input.attempts.clock ? { clock: input.attempts.clock.bind(input.attempts) } : {}),
          rateBudget: Object.freeze({ claim: physical.claim.bind(physical), observe429: physical.observe429.bind(physical),
            ...(physical.checkHeadroom ? { checkHeadroom: physical.checkHeadroom.bind(physical) } : {}) }) }) });
      const ports = Object.freeze({ ...incoming,
        record: Object.freeze({ allows: incoming.record.allows.bind(incoming.record), current: incoming.record.current.bind(incoming.record) }),
        capacity: Object.freeze({ matches: incoming.capacity.matches.bind(incoming.capacity), releaseOnce: incoming.capacity.releaseOnce.bind(incoming.capacity) }),
        authority: Object.freeze({ allows: incoming.authority.allows.bind(incoming.authority), current: incoming.authority.current.bind(incoming.authority) }),
        provider: Object.freeze({ binding: incoming.provider.binding.bind(incoming.provider), inspectTerminal: incoming.provider.inspectTerminal.bind(incoming.provider) }) });
      return ok(new ClinikoOutboundTerminalOwner(config, ports, owner));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async inspectAndRelease(binding: Readonly<{ recallRef: string; actionRef: string; patientId: string }>, external: AbortSignal):
    Promise<Result<Readonly<{ kind: "held" } | { kind: "terminal"; released: boolean }>, Failure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    let selected: typeof binding;
    try { selected = Object.freeze(structuredClone(binding)); } catch { return err({ kind: "unavailable" }); }
    const controller = new AbortController(), ms = this.#config.deadlineMs ?? 30_000, timer = setTimeout(() => controller.abort(), ms);
    const signal = AbortSignal.any([external, controller.signal]), began = performance.now();
    let q: OutboundTerminalQuery | undefined, last = "";
    // Per-invocation strongest decoded native grant. Sharing this mutable
    // observation between concurrent inspections would check another record.
    let nativeQuery: OutboundLaunchRecordQuery | undefined;
    const reader = ClinikoOutboundLaunchRecords.createReadOnly(this.#config.attempts, {
      allows: this.#ports.record.allows,
      current: (query, sourceSignal) => {
        if (query.attempt && query.attemptDigest) nativeQuery = query;
        return this.#ports.record.current(query, sourceSignal);
      }
    }, this.#ports.native);
    const now = () => {
      const at = this.#config.attempts.clock?.() ?? new Date().toISOString();
      if (!instant(at) || at < last) throw new Error("Unavailable time"); last = at; return at;
    };
    const active = () => !signal.aborted && performance.now() - began <= ms;
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      const value = await awaitUntilAbort(promise, signal);
      if (value === undefined || !active()) throw new Error("Unavailable operation"); return value;
    };
    const current = () => {
      now();
      return active() && !!q && !!nativeQuery && this.#ports.record.current(nativeQuery, signal) === true && this.#ports.capacity.matches(this.#config.capacityScope, this.#capacityOwner) === true &&
        isDeepStrictEqual(this.#ports.provider.binding(), q.provider) &&
        operations.every(operation => this.#ports.authority.current(Object.freeze({ ...q!, operation }), signal) === true);
    };
    try {
      if (await wait(checkClinikoHeadroom(this.#config.attempts.rateBudget, this.#config.maximumNativeRequests)) !== null) return err({ kind: "unavailable" });
      if (!reader.ok) return err({ kind: "unavailable" });
      const read = await wait(reader.value.readPossibleAttempt(selected, signal));
      if (!read.ok) return err({ kind: "unavailable" });
      const a = read.value.attempt, provider = Object.freeze({ ...this.#ports.provider.binding() });
      if (!a.capacityAllocationRef) return err({ kind: "unrecoverable" });
      if (a.campaignRef !== this.#config.campaignRef || !bindingValid(provider) || !isDeepStrictEqual(provider, a.provider)) return err({ kind: "forbidden" });
      q = Object.freeze({ operation: "approveNativeSource", record: read.value, provider,
        capacityScope: this.#config.capacityScope, capacityOwner: this.#capacityOwner });
      for (const operation of operations) {
        const query = Object.freeze({ ...q, operation });
        if (!current() || await wait(Promise.resolve().then(() => this.#ports.authority.allows(query, signal))) !== true || !current()) return err({ kind: "forbidden" });
      }
      const answer = structuredClone(await wait(this.#ports.provider.inspectTerminal(Object.freeze({ effectRef: a.effectRef,
        capacityAllocationRef: a.capacityAllocationRef }), signal)));
      if (!current()) return err({ kind: "forbidden" });
      if (answer.kind !== "terminal") return ok({ kind: "held" });
      if (Object.keys(answer).sort().join(",") !== "capacityAllocationRef,complete,effectRef,endedAt,kind,observedAt,provider" || answer.complete !== true ||
          answer.effectRef !== a.effectRef || answer.capacityAllocationRef !== a.capacityAllocationRef || !isDeepStrictEqual(answer.provider, provider) ||
          !instant(answer.endedAt) || !instant(answer.observedAt) || answer.endedAt < a.attemptedAt || answer.endedAt > answer.observedAt || answer.observedAt > now()) return err({ kind: "forbidden" });
      const fresh = await wait(reader.value.readPossibleAttempt(selected, signal));
      if (!fresh.ok || !isDeepStrictEqual(fresh.value, read.value) || !current()) return err({ kind: "forbidden" });
      const released = await wait(this.#ports.capacity.releaseOnce(a.capacityAllocationRef, () => {
        try { return current(); } catch { return false; }
      }));
      // A known SQL result is preserved; a later observer/permission failure
      // cannot undo it. A lost result stays unknown and never initiates a call.
      return released.ok ? ok({ kind: "terminal", released: released.value.released }) : err({ kind: "unavailable" });
    } catch { return err({ kind: "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
