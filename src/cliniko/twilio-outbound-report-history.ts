import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OwnedBodyError, ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { validRecallMarker } from "./recall-note.ts";
import { outboundConfigShard, outboundNativeInstant } from "./internal/outbound-record-context.ts";
import { readPatientRecallHistory, PatientRecallHistoryError } from "./internal/patient-recall-history.ts";
import type { NativeOutboundContext, NativeOutboundFailure } from "./internal/outbound-native-record.ts";
import { clinikoCredentialFingerprint, claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import { outboundLaunchAttemptDigest, encodeOutboundLaunchAttempt, decodeOutboundLaunchAttempt } from "./outbound-launch-attempt.ts";
import { decodeTwilioOutboundReport, twilioOutboundReportDigest, TwilioOutboundReportAuthentication } from "./twilio-outbound-report.ts";
import type { TwilioOutboundReport } from "./twilio-outbound-report.ts";
import { ClinikoTwilioOutboundReportRecords, twilioOutboundReportRecordBinding } from "./twilio-outbound-report-records.ts";
import type { TwilioOutboundReportConfig, TwilioOutboundReportQuery } from "./twilio-outbound-report-records.ts";
import type { TwilioOriginalCall } from "../voice/twilio-outbound-context.ts";

export type TwilioOutboundReportHistoryQuery = Pick<TwilioOutboundReportQuery,
  "scope" | "businessId" | "credentialFingerprint" | "outboundProviderReportRecallTypeId" | "providerReportPolicyDigest" | "provider" | "authenticationBinding" | "ownerBinding"> & Readonly<{
    operation: "readProviderReportHistory"; original: TwilioOriginalCall; accountSid: string; includeArchived: true; includeClosed: true;
  }>;
export type TwilioOutboundReportHistoryAuthority = Readonly<{
  allowsHistoryRead(query: TwilioOutboundReportHistoryQuery, signal: AbortSignal): Promise<boolean>;
  allowsRecordRead(query: TwilioOutboundReportQuery, signal: AbortSignal): Promise<boolean>;
  current(query: TwilioOutboundReportHistoryQuery | TwilioOutboundReportQuery, signal: AbortSignal): boolean;
}>;
class Refusal extends Error {
  readonly kind: NativeOutboundFailure["kind"];
  constructor(kind: NativeOutboundFailure["kind"]) { super("Provider report unavailable"); this.kind = kind; }
}
function discard(r: Response | undefined): void { try { void r?.body?.cancel().catch(() => {}); } catch { /* Owned body only. */ } }
function freeze<T>(v: T): T { if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }
/** Bounded full native history, including closed/archived evidence, followed by
 * exact authenticated rereads and a complete rescan. It recovers the reserved
 * report action after ACK loss without a private local call index. Absence,
 * conflict and incomplete history never allow a report write or hold release. */
export class ClinikoTwilioOutboundReportHistory {
  readonly #config: TwilioOutboundReportConfig;
  readonly #auth: TwilioOutboundReportAuthentication;
  readonly #authority: TwilioOutboundReportHistoryAuthority;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #owner: string;
  private constructor(c: TwilioOutboundReportConfig, auth: TwilioOutboundReportAuthentication, authority: TwilioOutboundReportHistoryAuthority,
    port: typeof fetch, shard: string, owner: string) {
    this.#config = Object.freeze({ ...c, scope: Object.freeze({ ...c.scope }), ...(c.clock ? { clock: c.clock.bind(c) } : {}),
      rateBudget: Object.freeze({ claim: c.rateBudget.claim.bind(c.rateBudget), observe429: c.rateBudget.observe429.bind(c.rateBudget) }) });
    this.#auth = auth;
    this.#authority = Object.freeze({ allowsHistoryRead: authority.allowsHistoryRead.bind(authority), allowsRecordRead: authority.allowsRecordRead.bind(authority), current: authority.current.bind(authority) });
    this.#fetch = port; this.#base = `https://api.${shard}.cliniko.com/v1`; this.#owner = owner;
  }
  static create(c: TwilioOutboundReportConfig, auth: TwilioOutboundReportAuthentication, authority: TwilioOutboundReportHistoryAuthority,
    port: typeof fetch = fetch): Result<ClinikoTwilioOutboundReportHistory, NativeOutboundFailure> {
    try {
      const shard = outboundConfigShard({ ...c, outboundRecallTypeId: c.outboundProviderReportRecallTypeId, recordPolicyDigest: c.providerReportPolicyDigest }, port);
      const owner = twilioOutboundReportRecordBinding(c, auth);
      if (!shard || !owner || [authority?.allowsHistoryRead, authority?.allowsRecordRead, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      return ok(new ClinikoTwilioOutboundReportHistory(c, auth, authority, port, shard, owner));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async findForOriginal(input: TwilioOriginalCall, accountSid: string, external: AbortSignal): Promise<Result<Readonly<{
    kind: "nativeProviderReportHistory"; selected: number; scanned: number; record?: NativeOutboundContext<TwilioOutboundReport>;
  }>, NativeOutboundFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const c = this.#config; let original: TwilioOriginalCall;
    try {
      const v = structuredClone(input), encoded = encodeOutboundLaunchAttempt(v.original.attempt);
      if (!encoded.ok) return err({ kind: "invalidQuery" });
      const decoded = decodeOutboundLaunchAttempt(encoded.value);
      if (!decoded.ok || Object.keys(v).sort().join(",") !== "attemptDigest,number,original,reportActionRef,sessionActionRef" ||
          Object.keys(v.original).sort().join(",") !== "attempt,recallRef" || !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(v.original.recallRef) ||
          !validRecallMarker(v.reportActionRef) || !validRecallMarker(v.sessionActionRef) || v.reportActionRef === v.sessionActionRef ||
          !/^\+[1-9][0-9]{7,14}$/.test(v.number) || !/^AC[0-9a-f]{32}$/.test(accountSid) ||
          v.attemptDigest !== outboundLaunchAttemptDigest(decoded.value) || !isDeepStrictEqual(decoded.value.scope, c.scope) ||
          decoded.value.businessId !== c.businessId || decoded.value.credentialFingerprint !== clinikoCredentialFingerprint(c.apiKey) ||
          !isDeepStrictEqual(decoded.value.provider, this.#auth.binding())) return err({ kind: "invalidQuery" });
      original = freeze({ ...v, original: { recallRef: v.original.recallRef, attempt: decoded.value } });
    } catch { return err({ kind: "invalidQuery" }); }
    const controller = new AbortController(), ms = c.deadlineMs ?? 15000, timer = setTimeout(() => controller.abort(), ms);
    const signal = AbortSignal.any([external, controller.signal]), began = performance.now(); let last = "";
    const q: TwilioOutboundReportHistoryQuery = freeze({ scope: c.scope, businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey),
      outboundProviderReportRecallTypeId: c.outboundProviderReportRecallTypeId, providerReportPolicyDigest: c.providerReportPolicyDigest,
      provider: this.#auth.binding(), authenticationBinding: this.#auth.authenticationBinding(), ownerBinding: this.#owner,
      operation: "readProviderReportHistory", original, accountSid, includeArchived: true, includeClosed: true });
    const grants = new Map<string, TwilioOutboundReportQuery>();
    const now = () => { const at = c.clock ? c.clock() : new Date().toISOString(), canonical = outboundNativeInstant(at);
      if (signal.aborted || performance.now() - began > ms || !canonical || canonical !== at || at < last) throw new Refusal("unavailable"); last = at; return at; };
    const wait = async <T>(task: Promise<T>): Promise<T> => { const v = await awaitUntilAbort(task, signal); if (v === undefined) throw new Refusal("unavailable"); now(); return v; };
    const current = (query: TwilioOutboundReportHistoryQuery | TwilioOutboundReportQuery) => { now(); if (this.#authority.current(query, signal) !== true) throw new Refusal("forbidden"); now(); };
    const permit = async () => { current(q); if (await wait(this.#authority.allowsHistoryRead(q, signal)) !== true) throw new Refusal("forbidden"); current(q); };
    try {
      now();
      const scan = () => readPatientRecallHistory({ base: this.#base, patientId: original.original.attempt.patientId, typeId: c.outboundProviderReportRecallTypeId }, async url => {
        await permit(); const limited = await wait(claimClinikoBudget(c.rateBudget)); if (limited) throw new Refusal(limited.kind); await permit();
        let response: Response | undefined, owned = false;
        try {
          current(q);
          const found = await wait(this.#fetch(url, { method: "GET", redirect: "error", signal, headers: { Accept: "application/json",
            Authorization: `Basic ${Buffer.from(`${c.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${c.contactEmail})` } }).then(r => { response = r; if (signal.aborted) discard(r); return r; }));
          if (found.status === 429) { await wait(observeCliniko429(c.rateBudget, found.headers.get("X-RateLimit-Reset"))); throw new Refusal("rateLimited"); }
          if (found.status === 401 || found.status === 403) throw new Refusal("forbidden");
          if (found.status !== 200) throw new Refusal("unavailable");
          owned = true; const bytes = await wait(ownedBodyBytes(found.body, 1000000, signal)); let raw: unknown;
          try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Refusal("malformed"); }
          await permit(); return raw;
        } finally { if (!owned) discard(response); }
      }, now);
      const history = await scan(), actions = new Set<string>(); let result: NativeOutboundContext<TwilioOutboundReport> | undefined;
      const reader = ClinikoTwilioOutboundReportRecords.createReadOnly(c, this.#auth, {
        allows: async (g, s) => { await permit(); current(g); if (await wait(this.#authority.allowsRecordRead(g, s)) !== true) return false;
          current(g); if (g.report || !grants.has(g.recallRef!)) grants.set(g.recallRef!, g); return true; },
        current: g => { try { current(q); current(g); return true; } catch { return false; } },
      }, this.#fetch);
      if (!reader.ok) return reader;
      for (const row of history.rows) {
        const decoded = decodeTwilioOutboundReport(row.notes); if (!decoded.ok) throw new Refusal("malformed");
        const report = decoded.value;
        if (actions.has(report.actionRef)) throw new Refusal("mismatched"); actions.add(report.actionRef);
        const read = await wait(reader.value.readReport({ recallRef: `cliniko:recall:${row.id}`, actionRef: report.actionRef, patientId: row.patientId }, signal));
        if (!read.ok) return read; const native = read.value;
        if (twilioOutboundReportDigest(native.record) !== twilioOutboundReportDigest(report) || native.recallAt !== row.recallAt || native.createdAt !== row.createdAt ||
            native.updatedAt !== row.updatedAt || native.recalled !== row.recalled || native.recalledAt !== row.recalledAt || native.archivedAt !== row.archivedAt) throw new Refusal("mismatched");
        if (report.actionRef === original.reportActionRef || report.original.actionRef === original.original.attempt.actionRef || report.original.recallRef === original.original.recallRef) {
          if (result || !this.#auth.matchesOriginal(native.record, original, accountSid)) throw new Refusal("mismatched"); result = native;
        }
      }
      await permit(); if (!isDeepStrictEqual(await scan(), history)) throw new Refusal("mismatched");
      await permit(); for (const g of grants.values()) current(g); current(q);
      return ok(Object.freeze({ kind: "nativeProviderReportHistory", selected: history.rows.length, scanned: history.scanned, ...(result ? { record: result } : {}) }));
    } catch (e) { return err({ kind: e instanceof Refusal || e instanceof OwnedBodyError || e instanceof PatientRecallHistoryError ? e.kind : "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
