import { isDeepStrictEqual } from "node:util";
import { ClinikoAdministrativeMemoHistory } from "../cliniko/administrative-memo-history.ts";
import type { AdministrativeMemoHistoryAuthority, AdministrativeMemoHistoryResult } from "../cliniko/administrative-memo-history.ts";
import { AdministrativeMemoAuthentication } from "../cliniko/administrative-memo.ts";
import type { AdministrativeMemoConfig } from "../cliniko/administrative-memo-records.ts";
import { administrativeMemoNativeInstant as instant } from "../cliniko/internal/administrative-memo-native.ts";
import { clinikoCredentialFingerprint, claimClinikoBudget, observeCliniko429 } from "../cliniko/read-budget.ts";
import { validOutboundEffectRef } from "../core/outbound-effect-barrier.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";

export type BookingMemoSource = Readonly<{
  sourceActionRef: string; appointmentRef: string; startsAt: string; endsAt: string;
  practitionerRef: string; appointmentTypeRef: string; createdAt: string; updatedAt: string;
  archivedAt: string | null; cancelledAt: string | null; deletedAt: string | null;
}>;
export type BookingMemoSourceQuery = Readonly<{
  operation: "readOriginalBookingMemoSource"; scope: LocationScope; businessId: string; credentialFingerprint: string;
  patientId: string; appointmentRef: string; includeArchivedCancelledDeleted: true;
  /** Present only after an independently permitted exact native read. No raw
   * appointment notes or patient data outside this selection are disclosed. */
  source?: BookingMemoSource;
}>;
export type BookingMemoSourceAuthority = Readonly<{
  allows(query: BookingMemoSourceQuery, signal: AbortSignal): Promise<boolean>;
  current(query: BookingMemoSourceQuery, signal: AbortSignal): boolean;
}>;
export type BookingMemoRecoverySelection = Readonly<{
  patientId: string; appointmentRef: string; createdFrom: string; createdThrough: string;
}>;
type Failure = Readonly<{ kind: "bookingMemoRecoveryUnavailable" }>;
const unavailable = (): Result<never, Failure> => err({ kind: "bookingMemoRecoveryUnavailable" });
const numeric = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
const object = (v: unknown): Record<string, unknown> | undefined => !!v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const link = (v: unknown) => object(object(v)?.links)?.self;
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch {} }

/** Recover a historical memo for a clinic-selected native booking. The native
 * marker is context, never a clinical receipt, proof or send permit. No lost
 * review identity or communication ID is reconstructed from a diary match. */
export class ClinikoBookingMemoRecovery {
  readonly #native: AdministrativeMemoConfig;
  readonly #authentication: AdministrativeMemoAuthentication;
  readonly #source: BookingMemoSourceAuthority;
  readonly #history: AdministrativeMemoHistoryAuthority;
  readonly #port: typeof fetch;
  private constructor(c: AdministrativeMemoConfig, authentication: AdministrativeMemoAuthentication,
    source: BookingMemoSourceAuthority, history: AdministrativeMemoHistoryAuthority, port: typeof fetch) {
    const b = c.rateBudget;
    this.#native = Object.freeze({ ...c, scope: Object.freeze({ ...c.scope }), policy: Object.freeze({ ...c.policy }),
      rateBudget: Object.freeze({ claim: b.claim.bind(b), observe429: b.observe429.bind(b) }), clock: c.clock?.bind(c) ?? (() => new Date().toISOString()) });
    this.#authentication = authentication; this.#port = port;
    this.#source = Object.freeze({ allows: source.allows.bind(source), current: source.current.bind(source) });
    this.#history = Object.freeze({ allowsHistoryRead: history.allowsHistoryRead.bind(history), allowsRecordRead: history.allowsRecordRead.bind(history), current: history.current.bind(history) });
  }
  static create(c: AdministrativeMemoConfig, authentication: AdministrativeMemoAuthentication, source: BookingMemoSourceAuthority,
    history: AdministrativeMemoHistoryAuthority, port: typeof fetch = fetch): Result<ClinikoBookingMemoRecovery, Failure> {
    try {
      if (typeof source?.allows !== "function" || typeof source.current !== "function" ||
          !ClinikoAdministrativeMemoHistory.create(c, authentication, history, port).ok) return unavailable();
      return ok(new ClinikoBookingMemoRecovery(c, authentication, source, history, port));
    } catch { return unavailable(); }
  }
  async recover(input: BookingMemoRecoverySelection, external: AbortSignal): Promise<Result<AdministrativeMemoHistoryResult, Failure>> {
    let selected: BookingMemoRecoverySelection;
    try {
      if (!input || Object.keys(input).sort().join(",") !== "appointmentRef,createdFrom,createdThrough,patientId" || !numeric(input.patientId) ||
          !/^cliniko:appointment:[1-9][0-9]{0,18}$/.test(input.appointmentRef) || typeof input.createdFrom !== "string" || typeof input.createdThrough !== "string" ||
          instant(input.createdFrom) !== input.createdFrom || instant(input.createdThrough) !== input.createdThrough || input.createdFrom >= input.createdThrough ||
          Date.parse(input.createdThrough) - Date.parse(input.createdFrom) > 7 * 86400000 || !(external instanceof AbortSignal) || external.aborted) return unavailable();
      selected = Object.freeze({ ...input });
    } catch { return unavailable(); }
    const c = this.#native, controller = new AbortController(), signal = AbortSignal.any([external, controller.signal]),
      timer = setTimeout(() => controller.abort(), c.deadlineMs ?? 15000);
    const base = `https://api.${c.apiKey.split("-").at(-1)}.cliniko.com/v1`, id = selected.appointmentRef.split(":")[2]!;
    const q: BookingMemoSourceQuery = Object.freeze({ operation: "readOriginalBookingMemoSource", scope: c.scope,
      businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey), patientId: selected.patientId,
      appointmentRef: selected.appointmentRef, includeArchivedCancelledDeleted: true });
    const grants: BookingMemoSourceQuery[] = [q], historyGrants = new Set<Parameters<AdministrativeMemoHistoryAuthority["current"]>[0]>(); let last = "";
    const clock = () => { const at = c.clock!(); if (typeof at !== "string" || instant(at) !== at || at < last) throw Error("Source unavailable"); last = at; return at; };
    const current = () => {
      if (signal.aborted || Date.parse(selected.createdThrough) > Date.parse(clock()) + 30000 || grants.some(query => this.#source.current(query, signal) !== true) ||
          [...historyGrants].some(query => this.#history.current(query, signal) !== true)) throw Error("Source unavailable");
    };
    const wait = async <T>(pending: Promise<T>) => { const value = await awaitUntilAbort(pending, signal); current(); if (value === undefined) throw Error("Source unavailable"); return value; };
    const permit = async (query: BookingMemoSourceQuery) => { current(); if (await wait(Promise.resolve().then(() => this.#source.allows(query, signal))) !== true) throw Error("Source unavailable"); current(); };
    const read = async (): Promise<BookingMemoSource> => {
      for (const query of grants) await permit(query);
      if (await wait(claimClinikoBudget(c.rateBudget))) throw Error("Source unavailable");
      for (const query of grants) await permit(query);
      const url = new URL(`${base}/individual_appointments/${id}`);
      for (const field of ["archived_at", "cancelled_at", "deleted_at"]) url.searchParams.append("q[]", `${field}:*`);
      let response: Response | undefined;
      try {
        const found = await wait(Promise.resolve().then(() => this.#port(url.href, { method: "GET", redirect: "error", signal,
          headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${c.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${c.contactEmail})` }
        })).then(r => { response = r; if (signal.aborted) discard(r); return r; }));
        if (found.status === 429) { await wait(observeCliniko429(c.rateBudget, found.headers.get("X-RateLimit-Reset"))); throw Error("Source unavailable"); }
        if (found.status !== 200 || found.url && found.url !== url.href) throw Error("Source unavailable");
        const bytes = await wait(ownedBodyBytes(found.body, 1000000, signal));
        const row = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))), start = instant(row?.starts_at), end = instant(row?.ends_at),
          created = instant(row?.created_at), updated = instant(row?.updated_at);
        const root = typeof row?.notes === "string" ? /^Abby booking ([0-9a-f-]+)$/i.exec(row.notes)?.[1] : undefined;
        const status = (field: string) => row?.[field] === null ? null : instant(row?.[field]);
        const archived = status("archived_at"), cancelled = status("cancelled_at"), deleted = status("deleted_at");
        const reference = (field: string, collection: string) => {
          const value = link(row?.[field]), tail = typeof value === "string" && value.startsWith(`${base}/${collection}/`) ? value.slice(`${base}/${collection}/`.length) : undefined;
          return numeric(tail) ? `cliniko:${field === "practitioner" ? "practitioner" : "appointmentType"}:${tail}` : undefined;
        };
        const practitionerRef = reference("practitioner", "practitioners"), appointmentTypeRef = reference("appointment_type", "appointment_types");
        if (!row || row.id !== id || link(row) !== `${base}/individual_appointments/${id}` || link(row.patient) !== `${base}/patients/${selected.patientId}` ||
            link(row.business) !== `${base}/businesses/${c.businessId}` || !practitionerRef || !appointmentTypeRef || !root || !validOutboundEffectRef(root) ||
            row.notes !== `Abby booking ${root}` || !start || !end || start >= end || Date.parse(end) - Date.parse(start) > 480 * 60000 ||
            !created || !updated || created > updated || Date.parse(updated) > Date.parse(clock()) + 30000 ||
            archived === undefined || cancelled === undefined || deleted === undefined ||
            [archived, cancelled, deleted].some(at => at !== null && at > updated)) throw Error("Source unavailable");
        return Object.freeze({ sourceActionRef: root, appointmentRef: selected.appointmentRef, startsAt: start, endsAt: end, practitionerRef, appointmentTypeRef,
          createdAt: created, updatedAt: updated, archivedAt: archived, cancelledAt: cancelled, deletedAt: deleted });
      } finally { discard(response); }
    };
    try {
      current(); const source = await read(); const decoded: BookingMemoSourceQuery = Object.freeze({ ...q, source }); grants.push(decoded); await permit(decoded);
      const history = ClinikoAdministrativeMemoHistory.create({ ...c, clock }, this.#authentication, {
        allowsHistoryRead: (query, s) => { historyGrants.add(query); current(); return this.#history.allowsHistoryRead(query, s); },
        allowsRecordRead: (query, s) => { historyGrants.add(query); current(); return this.#history.allowsRecordRead(query, s); },
        current: (query, s) => { historyGrants.add(query); current(); return this.#history.current(query, s); }
      }, this.#port);
      if (!history.ok) return unavailable();
      const found = await wait(history.value.discover({ patientId: selected.patientId, sourceActionRef: source.sourceActionRef,
        createdFrom: selected.createdFrom, createdThrough: selected.createdThrough }, signal));
      if (!found.ok) return unavailable();
      if (!isDeepStrictEqual(await read(), source)) return unavailable();
      if (found.value.kind === "located") {
        const outcome = found.value.record.memo.outcome;
        if (outcome.kind !== "bookingConfirmed" || outcome.appointmentRef !== selected.appointmentRef || outcome.startsAt !== source.startsAt || outcome.endsAt !== source.endsAt) return unavailable();
      }
      for (const query of grants) await permit(query);
      current(); return ok(found.value);
    } catch { return unavailable(); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
