import { copyBookingSearchWindow, validBookingSearchWindow } from "../core/booking-search-window.ts";
import type { BookingSearchWindow } from "../core/booking-search-window.ts";
import type { BookingEvidenceHost, BookingMenuHost, BookingMenuQuery, BookingMenuReadQuery, HostEffects, HostReadFailure } from "../core/host.ts";
import type { BookingMenuRead } from "../core/booking-menu.ts";
import { validBookingSearchPreference } from "../core/booking-search-preference.ts";
import type { BookingSearchPreference } from "../core/booking-search-preference.ts";
import { digestActionRequest } from "../core/digest.ts";
import { normalizedSpokenName } from "../core/pending-location.ts";
import { err, ok } from "../core/model.ts";
import type { ActionRequest, HostMutation, HostWriteReceipt, LocationScope, Result, StaffItem } from "../core/model.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import { OwnerFileBookingCatalogue } from "./owner-file-booking-catalogue.ts";
import { ClinikoBookingHost } from "./cliniko-booking-host.ts";
import { preparationMayBeDiscarded } from "./prepared-proposal.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

type Member = Readonly<{ practitionerId: string; name: string; host: ClinikoBookingHost }>;
type Config = Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string; ledger: LedgerStore;
  catalogue: OwnerFileBookingCatalogue; members: readonly Member[]; initialPreference?: BookingSearchPreference }>;
const denied = <T>(): Result<T, HostReadFailure> => err({ kind: "unavailable", target: "offer" });

/** One admitted location, one patient verifier and one possible send. Every
 * member's host owns its exact provider writer/approval; names never select IDs. */
export class ClinikoCatalogueBookingHost extends NoStoredKnowledge implements BookingEvidenceHost, BookingMenuHost, HostEffects {
  readonly effectDeadlineMs = 30_000;
  readonly #config: Config;
  readonly #lifetime = new AbortController();
  #window: BookingSearchWindow | undefined;
  #preference: BookingSearchPreference | undefined;
  #menu: Readonly<{ turnId: string; member: Member }> | undefined;
  #selection: Readonly<{ verificationRef: string; offerRef: string; member: Member }> | undefined;
  #prepared: Readonly<{ request: Extract<ActionRequest, { kind: "book" }>; revision: number; member: Member }> | undefined;
  #attempted = false;
  #busy = false;
  #epoch = 0;
  constructor(config: Config) {
    super();
    if (!(config.catalogue instanceof OwnerFileBookingCatalogue) || !config.members.length || config.members.length > 3 || config.members.some(member => !(member.host instanceof ClinikoBookingHost))) throw new TypeError("invalid approved catalogue composition");
    if (config.initialPreference !== undefined && !validBookingSearchPreference(config.initialPreference)) throw new TypeError("invalid initial practitioner preference");
    this.#preference = config.initialPreference && Object.freeze({ ...config.initialPreference });
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }), members: Object.freeze(config.members.map(member => Object.freeze({ ...member }))) });
  }
  get financial() { return this.#selection?.member.host.financial ?? this.#prepared?.member.host.financial; }
  bookingMenuAvailable(): boolean { return !this.#lifetime.signal.aborted && !this.#attempted; }
  async searchProfile() { return this.#lifetime.signal.aborted ? undefined : this.#profile(); }
  currentSearchPreference(): BookingSearchPreference | undefined { return this.#preference && { ...this.#preference }; }
  async #profile() { const read = await this.#config.catalogue.current(this.#config.scope); return read.ok ? read.value : undefined; }
  #matches(query: BookingMenuQuery): boolean {
    const c = this.#config;
    return !this.#lifetime.signal.aborted && !query.signal.aborted && sameScope(query.scope, c.scope) && query.callId === c.callId &&
      query.sessionId === c.sessionId && query.policyVersion === c.policyVersion;
  }
  async readBookingMenu(incoming: BookingMenuReadQuery): Promise<Result<BookingMenuRead, HostReadFailure>> {
    if (!this.#matches(incoming) || this.#attempted || this.#busy) return denied();
    const query = structuredClone({ ...incoming, signal: undefined }) as Omit<BookingMenuReadQuery, "signal">;
    if (query.preference !== undefined && !validBookingSearchPreference(query.preference)) return denied();
    if (query.window !== undefined && query.window !== null && !validBookingSearchWindow(query.window)) return denied();
    if (query.window !== undefined) this.#window = query.window === null ? undefined : copyBookingSearchWindow(query.window);
    const bound = { ...query, window: this.#window ?? null, signal: AbortSignal.any([incoming.signal, this.#lifetime.signal]) };
    if (!this.#matches(bound) || this.#attempted || this.#busy || query.preference !== undefined && !validBookingSearchPreference(query.preference)) return denied();
    for (const member of this.#config.members) member.host.financial?.invalidate();
    const epoch = ++this.#epoch; this.#menu = undefined; this.#selection = undefined;
    if (query.preference !== undefined) this.#preference = Object.freeze({ ...this.#preference, ...query.preference });
    const profile = await this.#profile();
    if (!profile || !this.#matches(bound) || epoch !== this.#epoch || profile.practitioners.length !== this.#config.members.length ||
        profile.practitioners.some((member, index) => member.practitionerId !== this.#config.members[index]?.practitionerId || member.name !== this.#config.members[index]?.name)) return denied();
    const preference = this.#preference;
    if (preference?.location && normalizedSpokenName(preference.location) !== normalizedSpokenName(profile.locationName)) return denied();
    const members = preference?.practitioner === "any" ? this.#config.members : preference?.practitioner ?
      this.#config.members.filter(member => normalizedSpokenName(member.name) === normalizedSpokenName(preference.practitioner)) : [this.#config.members[0]!];
    if (!members.length) return denied();
    // Member reads share one operation-bound verifier. Its contact-attestation
    // recheck is exclusive, so serialize these reads; independent calls/tests
    // still run in parallel. Partial evidence never establishes earliest/no-match.
    const reads: { member: Member; read: Awaited<ReturnType<ClinikoBookingHost["readBookingMenu"]>> }[] = [];
    for (const member of members) {
      const read = await member.host.readBookingMenu(bound);
      if (!read.ok || !this.#matches(bound) || epoch !== this.#epoch) return denied();
      reads.push({ member, read });
    }
    if (!this.#matches(bound) || epoch !== this.#epoch || reads.some(item => !item.read.ok) || !await this.#profile()) return denied();
    const completed = reads.flatMap(item => item.read.ok ? [{ member: item.member, read: item.read.value }] : []);
    if (completed.some(item => item.read.practitionerName !== item.member.name || item.read.appointmentTypeName !== profile.appointmentTypeName || item.read.timeZone !== profile.timeZone)) return denied();
    const found = [...completed].sort((a, b) => (Date.parse(a.read.choices[0]?.startsAt ?? "") || Infinity) - (Date.parse(b.read.choices[0]?.startsAt ?? "") || Infinity));
    const winner = found[0];
    if (!winner || !this.#matches(bound) || epoch !== this.#epoch) return denied();
    this.#menu = { turnId: query.turnId, member: winner.member };
    return ok({ ...winner.read, locationName: profile.locationName, searchScope: { locationName: profile.locationName,
      practitioners: members.map(member => member.name), from: query.from, to: query.to,
      selection: preference?.practitioner === "any" ? "earliestApproved" : preference?.practitioner ? "preferred" : "default" },
      ...(completed.some(item => item.read.maxSearchDays !== undefined)
        ? { maxSearchDays: Math.min(...completed.map(item => item.read.maxSearchDays ?? 7)) } : {}) });
  }
  async selectBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>) {
    const menu = this.#menu;
    if (!this.#matches(query) || !menu || menu.turnId !== query.menuTurnId || this.#attempted || this.#busy) return denied<Readonly<{ verificationRef: string; offerRef: string }>>();
    const epoch = ++this.#epoch; this.#menu = undefined;
    const selected = await menu.member.host.selectBookingMenu(query);
    if (!selected.ok || !this.#matches(query) || epoch !== this.#epoch || !await this.#profile()) return denied<Readonly<{ verificationRef: string; offerRef: string }>>();
    if (!this.#matches(query) || epoch !== this.#epoch) return denied<Readonly<{ verificationRef: string; offerRef: string }>>();
    this.#selection = { ...selected.value, member: menu.member }; this.#menu = menu;
    return selected;
  }
  async correctBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; startsAt: string }>) {
    const menu = this.#menu;
    if (!this.#matches(query) || !menu || menu.turnId !== query.menuTurnId || this.#attempted || this.#busy) return denied<Readonly<{ verificationRef: string; offerRef: string }>>();
    const epoch = ++this.#epoch;
    const selected = await menu.member.host.correctBookingMenu(query);
    if (!selected.ok || !this.#matches(query) || epoch !== this.#epoch || !await this.#profile()) return denied<Readonly<{ verificationRef: string; offerRef: string }>>();
    if (!this.#matches(query) || epoch !== this.#epoch) return denied<Readonly<{ verificationRef: string; offerRef: string }>>();
    this.#selection = { ...selected.value, member: menu.member }; return selected;
  }
  async resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string, external?: AbortSignal):
    Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>> {
    const selected = this.#selection, c = this.#config;
    if (!selected || selected.offerRef !== offerRef || selected.verificationRef !== verificationRef || !sameScope(scope, c.scope) ||
        this.#lifetime.signal.aborted || this.#attempted || this.#busy) return denied();
    this.#busy = true;
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15_000), ...(external ? [external] : [])]);
    try {
      const state = await awaitUntilAbort(c.ledger.read(c.callId, c.scope), signal);
      if (!state?.ok || this.#prepared && !preparationMayBeDiscarded(state.value, this.#prepared.request, this.#prepared.revision) || !await this.#profile()) return denied();
      const resolved = await selected.member.host.resolveBooking(scope, verificationRef, offerRef, now, signal);
      const after = await awaitUntilAbort(c.ledger.read(c.callId, c.scope), signal);
      if (!resolved.ok && resolved.error.kind === "financialConsentRequired" && after?.ok && after.value.conversationRevision === state.value.conversationRevision &&
          !signal.aborted && this.#selection === selected && !this.#lifetime.signal.aborted) return resolved;
      if (!resolved.ok || !after?.ok || after.value.conversationRevision !== state.value.conversationRevision || signal.aborted ||
          this.#lifetime.signal.aborted || !await this.#profile()) return denied();
      if (signal.aborted || this.#lifetime.signal.aborted || this.#selection !== selected) return denied();
      this.#prepared = { request: structuredClone(resolved.value), member: selected.member, revision: state.value.conversationRevision };
      return resolved;
    } finally { this.#busy = false; }
  }
  async write(mutation: HostMutation, now: string, signal?: AbortSignal,
    onBookingAcknowledged?: Parameters<HostEffects["write"]>[3]): Promise<HostWriteReceipt> {
    const prepared = this.#prepared;
    if (this.#attempted || this.#busy || this.#lifetime.signal.aborted || !prepared || mutation.kind !== "book" ||
        mutation.payloadDigest !== digestActionRequest(prepared.request) || digestActionRequest(mutation.request) !== mutation.payloadDigest)
      return { kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" };
    this.#attempted = true;
    return prepared.member.host.write(mutation, now, signal, onBookingAcknowledged);
  }
  async reconcile(mutation: HostMutation) { return { kind: "stillUnknown" as const, actionKey: mutation.actionKey }; }
  async openTask(item: StaffItem) { return { kind: "rejected" as const, taskKey: item.key }; }
  async reconcileTask(item: StaffItem) { return { kind: "stillUnknown" as const, taskKey: item.key }; }
  dispose(): void { ++this.#epoch; this.#lifetime.abort(); for (const member of this.#config.members) member.host.dispose(); this.#menu = undefined; this.#selection = undefined; this.#prepared = undefined; this.#preference = undefined; this.#window = undefined; }
}
