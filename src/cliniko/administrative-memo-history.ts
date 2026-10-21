import { AdministrativeMemoAuthentication, administrativeMemoActionRef, administrativeMemoDigest } from "./administrative-memo.ts";
import { administrativeMemoRecordBinding } from "./administrative-memo-records.ts";
import type { AdministrativeMemoConfig, AdministrativeMemoFailure, AdministrativeMemoQuery, NativeAdministrativeMemo } from "./administrative-memo-records.ts";
import { clinikoCredentialFingerprint, claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import { administrativeMemoNativeInstant as instant } from "./internal/administrative-memo-native.ts";
import { AdministrativeMemoHistoryError as Failure, readAdministrativeMemoHistory } from "./internal/administrative-memo-history-scan.ts";
import type { AdministrativeMemoHistorySelection } from "./internal/administrative-memo-history-scan.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";

export type { AdministrativeMemoHistorySelection };
export type AdministrativeMemoHistoryQuery = Omit<AdministrativeMemoQuery, "operation" | "memo" | "memoDigest" | "communicationRef" | "confidential"> &
  AdministrativeMemoHistorySelection & Readonly<{
    operation: "discoverAdministrativeMemo"; includeArchived: true; selectedConfidential: true;
    /** Native filters do not restrict author or confidentiality. This grant
     * covers the patient's whole memo/phone collection within the window. */
    collection: "patientMemoPhoneCommunications"; maxPages: 5; perPage: 100;
  }>;
export type AdministrativeMemoHistoryAuthority = Readonly<{
  allowsHistoryRead(query: AdministrativeMemoHistoryQuery, signal: AbortSignal): Promise<boolean>;
  allowsRecordRead(query: AdministrativeMemoQuery, signal: AbortSignal): Promise<boolean>;
  current(query: AdministrativeMemoHistoryQuery | AdministrativeMemoQuery, signal: AbortSignal): boolean;
}>;
export type AdministrativeMemoHistoryResult = Readonly<{
  kind: "located"; record: NativeAdministrativeMemo; selection: AdministrativeMemoHistorySelection; observedAt: string; scanned: number;
  consistency: "twoMatchingBoundedScans";
}> | Readonly<{
  /** Not a proof that no effect ever existed and never permission to retry. */
  kind: "notLocated"; selection: AdministrativeMemoHistorySelection; observedAt: string; scanned: number;
  consistency: "twoMatchingBoundedScans";
}>;
type HistoryFailure = AdministrativeMemoFailure | Readonly<{ kind: "conflict" }>;
const exact = (v: unknown, fields: readonly string[]) => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...fields].sort().join(",");
const numeric = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch {} }

/** GET-only cold discovery. A source root comes from independently approved
 * native recovery, not lost process memory. No writer, effect fence, clinical
 * continuation or patient-bearing local journal belongs to this reader. */
export class ClinikoAdministrativeMemoHistory {
  readonly #config: AdministrativeMemoConfig;
  readonly #authentication: AdministrativeMemoAuthentication;
  readonly #authority: AdministrativeMemoHistoryAuthority;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #owner: string;
  private constructor(c: AdministrativeMemoConfig, authentication: AdministrativeMemoAuthentication,
    authority: AdministrativeMemoHistoryAuthority, port: typeof fetch, owner: string) {
    const b = c.rateBudget;
    this.#config = Object.freeze({ ...c, scope: Object.freeze({ ...c.scope }), policy: Object.freeze({ ...c.policy }),
      rateBudget: Object.freeze({ claim: b.claim.bind(b), observe429: b.observe429.bind(b) }), clock: c.clock?.bind(c) ?? (() => new Date().toISOString()) });
    this.#authentication = authentication; this.#fetch = port; this.#owner = owner;
    this.#base = `https://api.${c.apiKey.split("-").at(-1)}.cliniko.com/v1`;
    this.#authority = Object.freeze({ allowsHistoryRead: authority.allowsHistoryRead.bind(authority), allowsRecordRead: authority.allowsRecordRead.bind(authority), current: authority.current.bind(authority) });
  }
  static create(c: AdministrativeMemoConfig, authentication: AdministrativeMemoAuthentication,
    authority: AdministrativeMemoHistoryAuthority, port: typeof fetch = fetch): Result<ClinikoAdministrativeMemoHistory, HistoryFailure> {
    try {
      const owner = administrativeMemoRecordBinding(c, authentication);
      if (!owner || !(authentication instanceof AdministrativeMemoAuthentication) || typeof port !== "function" ||
          [authority?.allowsHistoryRead, authority?.allowsRecordRead, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      return ok(new ClinikoAdministrativeMemoHistory(c, authentication, authority, port, owner));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async discover(input: AdministrativeMemoHistorySelection, external: AbortSignal): Promise<Result<AdministrativeMemoHistoryResult, HistoryFailure>> {
    let selected: AdministrativeMemoHistorySelection;
    try {
      if (!exact(input, ["patientId", "sourceActionRef", "createdFrom", "createdThrough"]) || !numeric(input.patientId) || !administrativeMemoActionRef(input.sourceActionRef) ||
          typeof input.createdFrom !== "string" || typeof input.createdThrough !== "string" ||
          instant(input.createdFrom) !== input.createdFrom || instant(input.createdThrough) !== input.createdThrough || input.createdFrom >= input.createdThrough ||
          Date.parse(input.createdThrough) - Date.parse(input.createdFrom) > 7 * 86400000) return err({ kind: "invalidQuery" });
      selected = Object.freeze({ ...input });
    } catch { return err({ kind: "invalidQuery" }); }
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const c = this.#config, controller = new AbortController(), ms = c.deadlineMs ?? 15000,
      signal = AbortSignal.any([external, controller.signal]), timer = setTimeout(() => controller.abort(), ms), began = performance.now();
    const history: AdministrativeMemoHistoryQuery = Object.freeze({ operation: "discoverAdministrativeMemo", scope: c.scope,
      businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey), authorRef: c.authorRef, policy: c.policy,
      ownerBinding: this.#owner, authenticationBinding: this.#authentication.binding(), categoryCode: 12, typeCode: 3, selectedConfidential: true,
      actionRef: administrativeMemoActionRef(selected.sourceActionRef)!, ...selected, includeArchived: true,
      collection: "patientMemoPhoneCommunications", maxPages: 5, perPage: 100 });
    const grants: (AdministrativeMemoHistoryQuery | AdministrativeMemoQuery)[] = [history]; let last = "";
    const clock = () => { const at = c.clock!(); if (typeof at !== "string" || instant(at) !== at || at < last) throw new Failure("unavailable"); last = at; return at; };
    const current = () => {
      if (signal.aborted || performance.now() - began > ms || grants.some(q => this.#authority.current(q, signal) !== true)) throw new Failure("forbidden"); clock();
    };
    const wait = async <T>(promise: Promise<T>) => { const found = await awaitUntilAbort(promise, signal); if (found === undefined) throw new Failure("unavailable"); current(); return found; };
    const historyPermit = async () => {
      current(); if (await wait(Promise.resolve().then(() => this.#authority.allowsHistoryRead(history, signal))) !== true) throw new Failure("forbidden"); current();
    };
    const load = async (url: string): Promise<unknown> => {
      await historyPermit(); const limited = await wait(claimClinikoBudget(c.rateBudget)); if (limited) throw new Failure(limited.kind);
      await historyPermit(); let response: Response | undefined;
      try {
        const received = await wait(this.#fetch(url, { method: "GET", redirect: "error", signal,
          headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${c.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${c.contactEmail})` }
        }).then(r => { response = r; if (signal.aborted) discard(r); return r; }));
        if (received.status === 429) { await wait(observeCliniko429(c.rateBudget, received.headers.get("X-RateLimit-Reset"))); throw new Failure("rateLimited"); }
        if (received.status === 401 || received.status === 403) throw new Failure("forbidden");
        if (received.status !== 200) throw new Failure("unavailable");
        if (received.url && received.url !== url) throw new Failure("mismatched");
        const bytes = await wait(ownedBodyBytes(received.body, 1000000, signal));
        try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Failure("malformed"); }
      } finally { discard(response); }
    };
    try {
      if (Date.parse(selected.createdThrough) > Date.parse(clock()) + 30000) return err({ kind: "invalidQuery" });
      const selection = { ...selected, base: this.#base, config: c, authentication: this.#authentication };
      const first = await readAdministrativeMemoHistory(selection, load, clock), second = await readAdministrativeMemoHistory(selection, load, clock);
      if (JSON.stringify(first.inventory) !== JSON.stringify(second.inventory)) throw new Failure("unavailable");
      const found = second.match;
      if (found) {
        const q: AdministrativeMemoQuery = Object.freeze({ operation: "readAdministrativeMemo", scope: c.scope,
          businessId: c.businessId, credentialFingerprint: history.credentialFingerprint, authorRef: c.authorRef, policy: c.policy,
          ownerBinding: this.#owner, authenticationBinding: history.authenticationBinding, categoryCode: 12, typeCode: 3, confidential: true,
          actionRef: history.actionRef, patientId: selected.patientId, includeArchived: true,
          communicationRef: found.communicationRef, memo: found.memo, memoDigest: administrativeMemoDigest(found.memo)! });
        grants.push(q); current(); if (await wait(Promise.resolve().then(() => this.#authority.allowsRecordRead(q, signal))) !== true) throw new Failure("forbidden");
      }
      current(); const common = { selection: selected, observedAt: clock(), scanned: second.scanned, consistency: "twoMatchingBoundedScans" as const };
      return found ? ok(Object.freeze({ kind: "located", record: found, ...common })) : ok(Object.freeze({ kind: "notLocated", ...common }));
    } catch (error) { return err({ kind: error instanceof Failure ? error.kind : "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
