import { isDeepStrictEqual } from "node:util";
import { ClinikoRecallReader } from "../cliniko/recalls.ts";
import type { ClinikoReviewRecord } from "../cliniko/recalls.ts";
import { ClinikoAdministrativeMemoHistory } from "../cliniko/administrative-memo-history.ts";
import type { AdministrativeMemoHistoryAuthority, AdministrativeMemoHistoryResult } from "../cliniko/administrative-memo-history.ts";
import type { AdministrativeMemoAuthentication, AdministrativeMemo } from "../cliniko/administrative-memo.ts";
import type { AdministrativeMemoConfig } from "../cliniko/administrative-memo-records.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { administrativeMemoNativeInstant as instant } from "../cliniko/internal/administrative-memo-native.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";

export type AdministrativeMemoOriginalQuery = Readonly<{
  operation: "readOriginalAdministrativeMemoReview"; scope: LocationScope; businessId: string; credentialFingerprint: string;
  patientId: string; recallRef: string; recallTypeId: string; includeArchived: true;
}>;
export type AdministrativeMemoOriginalAuthority = Readonly<{
  allows(query: AdministrativeMemoOriginalQuery, signal: AbortSignal): Promise<boolean>;
  current(query: AdministrativeMemoOriginalQuery, signal: AbortSignal): boolean;
}>;
export type AdministrativeMemoRecoverySelection = Readonly<{
  patientId: string; recallRef: string; createdFrom: string; createdThrough: string;
}>;
type Failure = Readonly<{ kind: "administrativeMemoRecoveryUnavailable" }>;
const unavailable = (): Result<never, Failure> => err({ kind: "administrativeMemoRecoveryUnavailable" });
const numeric = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch {} }
/** The legacy review decoder owns its schema; this owner bounds and retires
 * its transport/body under the complete recovery operation's signal. */
function reviewPort(port: typeof fetch, current: () => boolean): typeof fetch {
  return async (url, init) => {
    const signal = init?.signal; if (!signal || signal.aborted) throw Error("Review unavailable");
    let response: Response | undefined;
    try {
      const found = await awaitUntilAbort(Promise.resolve().then(() => {
        // The SDK may have awaited its budget since the original grant.
        // Recheck inside dispatch's deferred callback, with no intervening await.
        if (signal.aborted || !current()) throw Error("Review unavailable");
        return port(url, init);
      }).then(r => {
        response = r; if (signal.aborted) discard(r); return r;
      }), signal);
      if (!found || signal.aborted || found.url && found.url !== String(url)) throw Error("Review unavailable");
      if (found.status !== 200) return new Response(null, { status: found.status, headers: found.headers });
      const bytes = await ownedBodyBytes(found.body, 1000000, signal);
      if (signal.aborted) throw Error("Review unavailable");
      return new Response(new Uint8Array(bytes), { status: 200, headers: found.headers });
    } finally { discard(response); }
  };
}
function source(record: ClinikoReviewRecord): Readonly<{ root: string; matches(memo: AdministrativeMemo): boolean }> | undefined {
  const r = record.envelope.request, o = r.operation;
  const root = o.kind === "classBook" || o.kind === "classMove" ? o.attendanceActionId : record.envelope.marker;
  const range = (a: Readonly<{ startsAt: string; endsAt: string }>, b: Readonly<{ startsAt: string; endsAt: string }>) => a.startsAt === b.startsAt && a.endsAt === b.endsAt;
  if (!["classBook", "classCancel", "classMove", "cancel", "reschedule"].includes(o.kind)) return;
  return { root, matches: memo => {
    const m = memo.outcome;
    if (memo.sourceActionRef !== root || memo.patientId !== r.patientId || !isDeepStrictEqual(memo.scope, r.scope) ||
        memo.businessId !== r.businessId || memo.credentialFingerprint !== r.credentialFingerprint) return false;
    if (o.kind === "classBook") return m.kind === "classBookingConfirmed" && m.appointmentRef === `cliniko:booking:${o.sessionId}` && range(m, o);
    if (o.kind === "classCancel") return m.kind === "classCancellationObserved" && m.appointmentRef === `cliniko:booking:${o.sessionId}` &&
      m.attendeeRef === `cliniko:attendee:${o.attendeeId}` && range(m, o);
    if (o.kind === "classMove") return m.kind === "classMovementReported" && m.original.appointmentRef === `cliniko:booking:${o.sessionId}` &&
      m.original.attendeeRef === `cliniko:attendee:${o.attendeeId}` && range(m.original, o) && m.appointmentRef === `cliniko:booking:${o.newSessionId}` &&
      m.startsAt === o.newStartsAt && m.endsAt === o.newEndsAt;
    if (o.kind === "cancel") return m.kind === "cancellationObserved" && m.appointmentRef === `cliniko:appointment:${o.appointmentId}` && range(m, o);
    return o.kind === "reschedule" && m.kind === "reschedulingObserved" && m.appointmentRef === `cliniko:appointment:${o.appointmentId}` &&
      range(m.previous, o) && m.previous.practitionerRef === `cliniko:practitioner:${o.practitionerId}` &&
      m.startsAt === o.newStartsAt && m.endsAt === o.newEndsAt && m.practitionerRef === `cliniko:practitioner:${o.newPractitionerId ?? o.practitionerId}`;
  } };
}

/** Clinic-selected native review recovery, independent of the ended caller.
 * No communication ID, original process map, model note or clinical replay is
 * accepted. Individual creation needs a separate native booking-marker source;
 * its review alone deliberately cannot supply that missing root. */
export class ClinikoAdministrativeMemoRecovery {
  readonly #native: AdministrativeMemoConfig;
  readonly #recallTypeId: string;
  readonly #history: AdministrativeMemoHistoryAuthority;
  readonly #authentication: AdministrativeMemoAuthentication;
  readonly #port: typeof fetch;
  readonly #authority: AdministrativeMemoOriginalAuthority;
  private constructor(native: AdministrativeMemoConfig, recallTypeId: string,
    history: AdministrativeMemoHistoryAuthority, authority: AdministrativeMemoOriginalAuthority, authentication: AdministrativeMemoAuthentication, port: typeof fetch) {
    this.#native = native;
    this.#recallTypeId = recallTypeId; this.#authentication = authentication; this.#port = port;
    this.#history = Object.freeze({ allowsHistoryRead: history.allowsHistoryRead.bind(history), allowsRecordRead: history.allowsRecordRead.bind(history), current: history.current.bind(history) });
    this.#authority = Object.freeze({ allows: authority.allows.bind(authority), current: authority.current.bind(authority) });
  }
  static create(native: AdministrativeMemoConfig, authentication: AdministrativeMemoAuthentication, recallTypeId: string,
    originalAuthority: AdministrativeMemoOriginalAuthority, historyAuthority: AdministrativeMemoHistoryAuthority, port: typeof fetch = fetch): Result<ClinikoAdministrativeMemoRecovery, Failure> {
    try {
      if (!numeric(recallTypeId) || typeof originalAuthority?.allows !== "function" || typeof originalAuthority.current !== "function") return unavailable();
      const b = native.rateBudget, captured = Object.freeze({ ...native, scope: Object.freeze({ ...native.scope }), policy: Object.freeze({ ...native.policy }),
        rateBudget: Object.freeze({ claim: b.claim.bind(b), observe429: b.observe429.bind(b) }), clock: native.clock?.bind(native) ?? (() => new Date().toISOString()) });
      const history = ClinikoAdministrativeMemoHistory.create(captured, authentication, historyAuthority, port), reviews = ClinikoRecallReader.create(captured, port, captured.clock);
      return history.ok && reviews.ok ? ok(new ClinikoAdministrativeMemoRecovery(captured, recallTypeId, historyAuthority, originalAuthority, authentication, port)) : unavailable();
    } catch { return unavailable(); }
  }
  async recover(input: AdministrativeMemoRecoverySelection, external: AbortSignal): Promise<Result<AdministrativeMemoHistoryResult, Failure>> {
    let selected: AdministrativeMemoRecoverySelection;
    try {
      if (!input || Object.keys(input).sort().join(",") !== "createdFrom,createdThrough,patientId,recallRef" || !numeric(input.patientId) ||
          !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(input.recallRef) || typeof input.createdFrom !== "string" || typeof input.createdThrough !== "string" ||
          instant(input.createdFrom) !== input.createdFrom ||
          instant(input.createdThrough) !== input.createdThrough || input.createdFrom >= input.createdThrough ||
          Date.parse(input.createdThrough) - Date.parse(input.createdFrom) > 7 * 86400000 || !(external instanceof AbortSignal) || external.aborted) return unavailable();
      selected = Object.freeze({ ...input });
    } catch { return unavailable(); }
    const c = this.#native, controller = new AbortController(), signal = AbortSignal.any([external, controller.signal]),
      timer = setTimeout(() => controller.abort(), c.deadlineMs ?? 15000);
    const q: AdministrativeMemoOriginalQuery = Object.freeze({ operation: "readOriginalAdministrativeMemoReview", scope: c.scope,
      businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey), patientId: selected.patientId,
      recallRef: selected.recallRef, recallTypeId: this.#recallTypeId, includeArchived: true });
    const historyGrants = new Set<Parameters<AdministrativeMemoHistoryAuthority["current"]>[0]>(); let last = "";
    const current = () => {
      const at = (c.clock ?? (() => new Date().toISOString()))();
      if (signal.aborted || typeof at !== "string" || instant(at) !== at || at < last || Date.parse(selected.createdThrough) > Date.parse(at) + 30000) return false;
      last = at; return this.#authority.current(q, signal) === true && [...historyGrants].every(query => this.#history.current(query, signal) === true);
    };
    try {
      if (!current() || await awaitUntilAbort(this.#authority.allows(q, signal), signal) !== true || !current()) return unavailable();
      // Each invocation owns its grant closure, including concurrent selections.
      const reviews = ClinikoRecallReader.create(c, reviewPort(this.#port, current), c.clock);
      if (!reviews.ok) return unavailable();
      const original = await awaitUntilAbort(reviews.value.readReviewHistory(c.scope, selected.recallRef, this.#recallTypeId, signal), signal);
      if (!original?.ok || !current()) return unavailable();
      const r = original.value.envelope.request, binding = source(original.value);
      if (!binding || r.patientId !== selected.patientId || !isDeepStrictEqual(r.scope, c.scope) || r.businessId !== c.businessId || r.credentialFingerprint !== q.credentialFingerprint) return unavailable();
      const history = ClinikoAdministrativeMemoHistory.create(c, this.#authentication, {
        allowsHistoryRead: (query, s) => { historyGrants.add(query); return current() ? this.#history.allowsHistoryRead(query, s) : Promise.resolve(false); },
        allowsRecordRead: (query, s) => { historyGrants.add(query); return current() ? this.#history.allowsRecordRead(query, s) : Promise.resolve(false); },
        current: (query, s) => { historyGrants.add(query); return current() && this.#history.current(query, s); }
      }, this.#port);
      if (!history.ok) return unavailable();
      const found = await history.value.discover({ patientId: selected.patientId, sourceActionRef: binding.root,
        createdFrom: selected.createdFrom, createdThrough: selected.createdThrough }, signal);
      if (!found.ok || !current() || found.value.kind === "located" && !binding.matches(found.value.record.memo) ||
          await awaitUntilAbort(this.#authority.allows(q, signal), signal) !== true || !current()) return unavailable();
      return ok(found.value);
    } catch { return unavailable(); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
