import { isDeepStrictEqual } from "node:util";
import { AdministrativeMemoAuthentication, administrativeMemoActionRef, administrativeMemoDigest } from "../cliniko/administrative-memo.ts";
import type { AdministrativeMemo } from "../cliniko/administrative-memo.ts";
import { ClinikoAdministrativeMemos, administrativeMemoRecordBinding } from "../cliniko/administrative-memo-records.ts";
import type { AdministrativeMemoConfig, AdministrativeMemoQuery, AdministrativeMemoRetention, AdministrativeMemoWriteAuthority } from "../cliniko/administrative-memo-records.ts";
import { ClinikoBookingWriter } from "../cliniko/booking-write.ts";
import type { ClinikoBookingRequest } from "../cliniko/booking-write.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { LocationScope } from "../core/model.ts";
import type { OutboundEffectBarrier as OneUseEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { ClinikoBookingGuard } from "./cliniko-booking-guard.ts";
import type { PreparedClinikoBooking } from "./cliniko-booking-authority.ts";

export type BookingMemoOutcome = AdministrativeMemoRetention | Readonly<{ kind: "unavailable" }>;
export type ClinikoBookingMemoConfig = Readonly<{
  native: AdministrativeMemoConfig; authentication: AdministrativeMemoAuthentication;
  authority: AdministrativeMemoWriteAuthority; barrier: OneUseEffectBarrier;
  /** Separately owned retention lifetime; it grants no clinical continuation. */
  memoSignal: AbortSignal; fetchPort?: typeof fetch;
  observeOutcome?: (outcome: BookingMemoOutcome) => void;
}>;
type Call = Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string; writer: ClinikoBookingWriter; clock?: () => string }>;
const canonical = (at: unknown): at is string => typeof at === "string" && Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at;

/** Capture clinic-owned ports before asynchronous workflow selection. The
 * signal belongs to memo retention, independently of the clinical call. */
export function captureBookingMemoConfig(config: ClinikoBookingMemoConfig,
  binding: Readonly<{ scope: LocationScope; businessId: string; credentialFingerprint: string; rateBudget: ClinikoRequestBudget; clock?: () => string }>): ClinikoBookingMemoConfig {
  const owner = administrativeMemoRecordBinding(config.native, config.authentication);
  if (!(config.authentication instanceof AdministrativeMemoAuthentication) || !(config.memoSignal instanceof AbortSignal) || !owner ||
      !isDeepStrictEqual(config.native.scope, binding.scope) || config.native.businessId !== binding.businessId ||
      clinikoCredentialFingerprint(config.native.apiKey) !== binding.credentialFingerprint || config.native.rateBudget !== binding.rateBudget ||
      [config.authority?.allows, config.authority?.current, config.authority?.producerAdmitted, config.barrier?.matches, config.barrier?.claimOnce].some(f => typeof f !== "function") ||
      config.barrier.matches(binding.scope, owner) !== true || config.observeOutcome !== undefined && typeof config.observeOutcome !== "function")
    throw Error("Invalid administrative booking memo selection");
  const clock = config.native.clock?.bind(config.native) ?? binding.clock?.bind(binding) ?? (() => new Date().toISOString());
  return Object.freeze({ ...config, native: Object.freeze({ ...config.native, scope: Object.freeze({ ...config.native.scope }), policy: Object.freeze({ ...config.native.policy }), clock }),
    authority: Object.freeze({ allows: config.authority.allows.bind(config.authority), current: config.authority.current.bind(config.authority), producerAdmitted: config.authority.producerAdmitted.bind(config.authority) }),
    barrier: Object.freeze({ matches: config.barrier.matches.bind(config.barrier), claimOnce: config.barrier.claimOnce.bind(config.barrier) }),
    ...(config.observeOutcome ? { observeOutcome: config.observeOutcome.bind(config) } : {}) });
}

/** One call-private memo producer. A true native acknowledgement AND the
 * actual guard's verified dispatch source are required; no public completed
 * flag, later diary state or cloned receipt can supply either. Native memo
 * permission is separate and cannot veto/repeat a known clinical result. */
export class ClinikoBookingMemo {
  readonly #config: ClinikoBookingMemoConfig;
  readonly #call: Call;
  readonly #source: ClinikoBookingGuard["acknowledgementSource"];
  readonly #now: () => string;
  #pending: Readonly<{ prepared: PreparedClinikoBooking; request: ClinikoBookingRequest; digest: string; preparedAt: string }> | undefined;
  #prepared = false;
  #acknowledged = false;
  #memo: AdministrativeMemo | undefined;
  #retaining: Promise<void> | undefined;
  constructor(config: ClinikoBookingMemoConfig, call: Call, guard: ClinikoBookingGuard) {
    const selection = call.writer.selection();
    if (!(call.writer instanceof ClinikoBookingWriter) || !(guard instanceof ClinikoBookingGuard) ||
        !isDeepStrictEqual(selection.scope, call.scope) || !call.writer.sharesRequestBudget(config.native.rateBudget))
      throw Error("Invalid administrative booking memo selection");
    this.#call = Object.freeze({ ...call, scope: Object.freeze({ ...call.scope }) });
    this.#source = guard.acknowledgementSource.bind(guard);
    this.#config = captureBookingMemoConfig(config, { scope: call.scope, businessId: selection.businessId,
      credentialFingerprint: call.writer.credentialFingerprint(), rateBudget: config.native.rateBudget, ...(call.clock ? { clock: call.clock } : {}) });
    this.#now = this.#config.native.clock!;
  }
  /** No asynchronous wait or native read follows final availability. This
   * only captures the owning host's original private preparation beforehand. */
  prepare(prepared: PreparedClinikoBooking, request: ClinikoBookingRequest): void {
    if (this.#prepared) return; this.#prepared = true;
    try {
      const c = this.#call, p = structuredClone(prepared), r = structuredClone(request), at = this.#now();
      if (!canonical(at) || !administrativeMemoActionRef(r.marker) || !isDeepStrictEqual(p.query.scope, c.scope) ||
          p.query.callId !== c.callId || p.query.sessionId !== c.sessionId || p.query.policyVersion !== c.policyVersion ||
          !isDeepStrictEqual(r.scope, c.scope) || r.patientId !== p.request.patient.patientRef || r.patientId !== p.query.patientId ||
          r.startsAt !== p.request.offer.startsAt || r.endsAt !== p.evidence.endsAt || at < p.query.now) return;
      Object.freeze(r.scope); Object.freeze(r);
      this.#pending = Object.freeze({ prepared, request: r, digest: digestActionRequest(p.request), preparedAt: at });
    } catch { /* Missing memo provenance grants no clinical effect or replay. */ }
  }
  acknowledge(receipt: unknown): void {
    if (this.#acknowledged) return; this.#acknowledged = true;
    try {
      const p = this.#pending, c = this.#call;
      if (!p) return;
      const found = this.#source(p.prepared, receipt), at = this.#now();
      if (!found || !canonical(at) || at < p.preparedAt) return;
      const { dispatch: d, native: n } = found;
      if (!isDeepStrictEqual(n.request, p.request) || !isDeepStrictEqual(d.scope, c.scope) ||
          d.callId !== c.callId || d.sessionId !== c.sessionId || d.policyVersion !== c.policyVersion || d.clinicalDigest !== p.digest ||
          d.patientId !== n.request.patientId || d.businessId !== this.#config.native.businessId || d.credentialFingerprint !== n.credentialFingerprint ||
          d.startsAt !== n.request.startsAt || d.endsAt !== n.request.endsAt || !["inbound", "outbound"].includes(d.direction)) return;
      const signed = this.#config.authentication.sign({ actionRef: administrativeMemoActionRef(n.request.marker)!, sourceActionRef: n.request.marker,
        scope: c.scope, businessId: d.businessId, credentialFingerprint: n.credentialFingerprint, patientId: n.request.patientId,
        authorRef: this.#config.native.authorRef, policy: this.#config.native.policy, direction: d.direction,
        outcome: { kind: "bookingConfirmed", appointmentRef: n.appointmentRef, startsAt: new Date(n.request.startsAt).toISOString(), endsAt: new Date(n.request.endsAt).toISOString() },
        occurredAt: at, recordedAt: at });
      if (signed.ok) this.#memo = signed.value;
    } catch { /* Optional memo observation cannot erase clinical acknowledgement. */ }
  }
  retain(): Promise<void> {
    this.#retaining ??= this.#retain(); return this.#retaining;
  }
  async #retain(): Promise<void> {
    const c = this.#config, memo = this.#memo, fingerprint = memo && administrativeMemoDigest(memo);
    let outcome: BookingMemoOutcome = { kind: "unavailable" }, last: AdministrativeMemoQuery | undefined;
    const current = (q: AdministrativeMemoQuery, signal: AbortSignal) => {
      last = q; return !signal.aborted && !!fingerprint && q.memoDigest === fingerprint && c.authority.current(q, signal) === true;
    };
    try {
      if (memo && fingerprint) {
        const native = ClinikoAdministrativeMemos.create(c.native, c.authentication, { allows: c.authority.allows, current,
          producerAdmitted: (q, signal) => q.memoDigest === fingerprint ? c.authority.producerAdmitted(q, signal) : Promise.resolve(false) }, c.barrier, c.fetchPort);
        if (native.ok) { const result = await native.value.retainOnce(memo, c.memoSignal); if (result.ok) outcome = result.value; }
      }
      if (outcome.kind === "accepted") {
        let disclose = false; try { disclose = !!last && current(last, c.memoSignal); } catch {}
        if (!disclose) outcome = { kind: "acceptedWithheld" };
      }
    } catch { /* Report separate memo uncertainty without touching clinical truth. */ }
    try { if (c.observeOutcome) void Promise.resolve(c.observeOutcome(outcome)).catch(() => {}); }
    catch { /* A private observer cannot veto either retained result. */ }
    finally { this.#pending = undefined; this.#memo = undefined; }
  }
}
