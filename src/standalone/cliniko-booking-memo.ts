import { isDeepStrictEqual } from "node:util";
import { administrativeMemoActionRef } from "../cliniko/administrative-memo.ts";
import type { AdministrativeMemo } from "../cliniko/administrative-memo.ts";
import { ClinikoBookingWriter } from "../cliniko/booking-write.ts";
import type { ClinikoBookingRequest } from "../cliniko/booking-write.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { LocationScope } from "../core/model.ts";
import { ClinikoBookingGuard } from "./cliniko-booking-guard.ts";
import type { PreparedClinikoBooking } from "./cliniko-booking-authority.ts";
import { captureAdministrativeMemoConfig as captureBookingMemoConfig, retainAdministrativeMemo } from "./administrative-memo-retention.ts";
import type { ClinikoAdministrativeMemoConfig as ClinikoBookingMemoConfig, MemoRetentionOutcome as BookingMemoOutcome } from "./administrative-memo-retention.ts";

export { captureBookingMemoConfig };
export type { ClinikoBookingMemoConfig, BookingMemoOutcome };
type Call = Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string; writer: ClinikoBookingWriter; clock?: () => string }>;
const canonical = (at: unknown): at is string => typeof at === "string" && Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at;

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
    try { await retainAdministrativeMemo(this.#config, this.#memo); }
    finally { this.#pending = undefined; this.#memo = undefined; }
  }
}
