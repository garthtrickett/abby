import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes, OwnedBodyError } from "../shared/owned-body-bytes.ts";
import { validRecallMarker } from "./recall-note.ts";
import { outboundConfigShard, outboundNativeInstant } from "./internal/outbound-record-context.ts";
import { readAccountRecallHistory, PatientRecallHistoryError } from "./internal/patient-recall-history.ts";
import type { NativeOutboundContext, NativeOutboundFailure } from "./internal/outbound-native-record.ts";
import { claimClinikoBudget, observeCliniko429, clinikoCredentialFingerprint } from "./read-budget.ts";
import { ClinikoOutboundLaunchRecords, outboundLaunchRecordSelection, outboundLaunchRecordOwnerBinding } from "./outbound-launch-records.ts";
import type { OutboundLaunchRecordConfig, OutboundLaunchRecordQuery, OutboundLaunchRecord } from "./outbound-launch-records.ts";
import { outboundLaunchAttemptDigest } from "./outbound-launch-attempt.ts";
import { ClinikoTwilioOutboundReportRecords, twilioOutboundReportRecordBinding } from "./twilio-outbound-report-records.ts";
import type { TwilioOutboundReportConfig, TwilioOutboundReportQuery } from "./twilio-outbound-report-records.ts";
import { decodeTwilioOutboundReport, twilioOutboundReportDigest, TwilioOutboundReportAuthentication } from "./twilio-outbound-report.ts";
import type { TwilioOutboundReport } from "./twilio-outbound-report.ts";
import type { OutboundRuntimeCallIdentity } from "../voice/outbound-runtime.ts";

type Config = Readonly<{ reports: TwilioOutboundReportConfig; attempts: OutboundLaunchRecordConfig }>;
export type TwilioRuntimeHistoryQuery = Readonly<{
  operation: "readAccountProviderReportHistory"; identity: OutboundRuntimeCallIdentity; accountSid: string;
  reports: Pick<TwilioOutboundReportQuery, "scope" | "businessId" | "credentialFingerprint" | "outboundProviderReportRecallTypeId" | "providerReportPolicyDigest" | "ownerBinding" | "provider" | "authenticationBinding">;
  attempts: ReturnType<typeof outboundLaunchRecordSelection> & Readonly<{ ownerBinding: string }>;
  includeArchived: true; includeClosed: true;
}>;
export type TwilioRuntimeHistoryAuthority = Readonly<{
  allowsHistoryRead(query: TwilioRuntimeHistoryQuery, signal: AbortSignal): Promise<boolean>;
  allowsReportRead(query: TwilioOutboundReportQuery, signal: AbortSignal): Promise<boolean>;
  allowsAttemptRead(query: OutboundLaunchRecordQuery, signal: AbortSignal): Promise<boolean>;
  current(query: TwilioRuntimeHistoryQuery | TwilioOutboundReportQuery | OutboundLaunchRecordQuery, signal: AbortSignal): boolean;
}>;
export type TwilioRuntimeEvidence = Readonly<{ report: NativeOutboundContext<TwilioOutboundReport>; original: OutboundLaunchRecord }>;
class Refusal extends Error {
  readonly kind: NativeOutboundFailure["kind"];
  constructor(kind: NativeOutboundFailure["kind"]) { super("Native runtime evidence unavailable"); this.kind = kind; }
}
function discard(r: Response | undefined): void { try { void r?.body?.cancel().catch(() => {}); } catch { /* Own body only. */ } }
function freeze<T>(v: T): T { if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }

/** Cold correlation from the original runtime identity, without inventing lost
 * session/report IDs. Broad account visibility is a NEW independent read grant.
 * An authenticated report attests the captured original digest; editable native
 * origin notes must match that entire digest. Neither integrity nor absence is
 * terminal/speech coverage, patient verification, or permission to release. */
export class ClinikoTwilioOutboundRuntimeHistory {
  readonly #config: Config;
  readonly #auth: TwilioOutboundReportAuthentication;
  readonly #authority: TwilioRuntimeHistoryAuthority;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  private constructor(c: Config, auth: TwilioOutboundReportAuthentication, authority: TwilioRuntimeHistoryAuthority, port: typeof fetch, shard: string) {
    const budget = c.reports.rateBudget;
    const rateBudget = Object.freeze({ claim: budget.claim.bind(budget), observe429: budget.observe429.bind(budget) });
    const capture = <T extends TwilioOutboundReportConfig | OutboundLaunchRecordConfig>(v: T): Readonly<T> =>
      Object.freeze<T>({ ...v, scope: Object.freeze({ ...v.scope }), rateBudget, ...(v.clock ? { clock: v.clock.bind(v) } : {}) });
    this.#config = Object.freeze({ reports: capture(c.reports), attempts: capture(c.attempts) });
    this.#auth = auth; this.#fetch = port; this.#base = `https://api.${shard}.cliniko.com/v1`;
    this.#authority = Object.freeze({ allowsHistoryRead: authority.allowsHistoryRead.bind(authority), allowsReportRead: authority.allowsReportRead.bind(authority),
      allowsAttemptRead: authority.allowsAttemptRead.bind(authority), current: authority.current.bind(authority) });
  }
  static create(c: Config, auth: TwilioOutboundReportAuthentication, authority: TwilioRuntimeHistoryAuthority,
    port: typeof fetch = fetch): Result<ClinikoTwilioOutboundRuntimeHistory, NativeOutboundFailure> {
    try {
      const r = c.reports, a = c.attempts, shard = outboundConfigShard({ ...r, outboundRecallTypeId: r.outboundProviderReportRecallTypeId, recordPolicyDigest: r.providerReportPolicyDigest }, port);
      if (!shard || !(auth instanceof TwilioOutboundReportAuthentication) || !twilioOutboundReportRecordBinding(r, auth) || !outboundLaunchRecordOwnerBinding(a) ||
          !isDeepStrictEqual(r.scope, a.scope) || r.businessId !== a.businessId || r.apiKey !== a.apiKey || r.rateBudget !== a.rateBudget ||
          r.outboundProviderReportRecallTypeId === a.outboundAttemptRecallTypeId ||
          [authority?.allowsHistoryRead, authority?.allowsReportRead, authority?.allowsAttemptRead, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      return ok(new ClinikoTwilioOutboundRuntimeHistory(c, auth, authority, port, shard));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async findForRuntime(input: OutboundRuntimeCallIdentity, accountSid: string, external: AbortSignal): Promise<Result<Readonly<{
    kind: "nativeRuntimeHistory"; selected: number; scanned: number; evidence?: TwilioRuntimeEvidence;
  }>, NativeOutboundFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    let identity: OutboundRuntimeCallIdentity;
    try {
      if (!input || Object.keys(input).sort().join(",") !== "capacityAllocationRef,effectRef" || !validRecallMarker(input.effectRef) ||
          !validRecallMarker(input.capacityAllocationRef) || input.effectRef === input.capacityAllocationRef || !/^AC[0-9a-f]{32}$/.test(accountSid)) return err({ kind: "invalidQuery" });
      identity = Object.freeze({ ...input });
    } catch { return err({ kind: "invalidQuery" }); }
    const c = this.#config, r = c.reports, controller = new AbortController(), ms = Math.min(r.deadlineMs ?? 15000, c.attempts.deadlineMs ?? 15000);
    const timer = setTimeout(() => controller.abort(), ms), signal = AbortSignal.any([external, controller.signal]), began = performance.now();
    let last = "", claims = 0;
    const q: TwilioRuntimeHistoryQuery = freeze({ operation: "readAccountProviderReportHistory", identity, accountSid, includeArchived: true, includeClosed: true,
      reports: { scope: r.scope, businessId: r.businessId, credentialFingerprint: clinikoCredentialFingerprint(r.apiKey), outboundProviderReportRecallTypeId: r.outboundProviderReportRecallTypeId,
        providerReportPolicyDigest: r.providerReportPolicyDigest, ownerBinding: twilioOutboundReportRecordBinding(r, this.#auth)!, provider: this.#auth.binding(), authenticationBinding: this.#auth.authenticationBinding() },
      attempts: { ...outboundLaunchRecordSelection(c.attempts), ownerBinding: outboundLaunchRecordOwnerBinding(c.attempts)! } });
    const grants = new Map<string, TwilioOutboundReportQuery | OutboundLaunchRecordQuery>();
    const now = () => { const at = r.clock ? r.clock() : new Date().toISOString();
      if (signal.aborted || performance.now() - began > ms || typeof at !== "string" || outboundNativeInstant(at) !== at || at < last) throw new Refusal("unavailable"); last = at; return at; };
    const wait = async <T>(task: Promise<T>): Promise<T> => { const v = await awaitUntilAbort(task, signal); if (v === undefined) throw new Refusal("unavailable"); now(); return v; };
    const current = () => { now(); if (this.#authority.current(q, signal) !== true || [...grants.values()].some(g => this.#authority.current(g, signal) !== true)) throw new Refusal("forbidden"); now(); };
    const permit = async () => { current(); if (await wait(this.#authority.allowsHistoryRead(q, signal)) !== true) throw new Refusal("forbidden"); current(); };
    const budget = Object.freeze({ claim: () => ++claims <= 180 ? r.rateBudget.claim() : { kind: "unavailable" as const }, observe429: r.rateBudget.observe429 });
    const readAuthority = <G extends TwilioOutboundReportQuery | OutboundLaunchRecordQuery>(allow: (g: G, s: AbortSignal) => Promise<boolean>) => ({
      allows: async (g: G, s: AbortSignal) => { await permit(); if (this.#authority.current(g, s) !== true || await wait(allow(g, s)) !== true) return false;
        const key = g.operation + ":" + g.recallRef, old = grants.get(key);
        if ("report" in g && g.report || "attempt" in g && g.attempt || !old) grants.set(key, g);
        current(); return this.#authority.current(g, s) === true; },
      current: (g: G, s: AbortSignal) => { try { current(); return this.#authority.current(g, s) === true; } catch { return false; } }
    });
    try {
      now();
      const get = async (url: string) => {
        await permit(); const limited = await wait(claimClinikoBudget(budget)); if (limited) throw new Refusal(limited.kind); await permit();
        let response: Response | undefined, owned = false;
        try {
          current(); const found = await wait(this.#fetch(url, { method: "GET", redirect: "error", signal, headers: { Accept: "application/json",
            Authorization: `Basic ${Buffer.from(`${r.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${r.contactEmail})` } }).then(v => { response = v; if (signal.aborted) discard(v); return v; }));
          if (found.redirected || found.url && found.url !== url) throw new Refusal("mismatched");
          if (found.status === 429) { await wait(observeCliniko429(budget, found.headers.get("X-RateLimit-Reset"))); throw new Refusal("rateLimited"); }
          if (found.status === 401 || found.status === 403) throw new Refusal("forbidden");
          if (found.status !== 200) throw new Refusal("unavailable");
          owned = true; const bytes = await wait(ownedBodyBytes(found.body, 1000000, signal)); let raw: unknown;
          try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Refusal("malformed"); }
          await permit(); return raw;
        } finally { if (!owned) discard(response); }
      };
      const scan = () => readAccountRecallHistory({ base: this.#base, typeIds: [r.outboundProviderReportRecallTypeId] }, get, now);
      const history = await scan(), actions = new Set<string>(), origins = new Set<string>();
      const reports = ClinikoTwilioOutboundReportRecords.createReadOnly({ ...r, rateBudget: budget }, this.#auth,
        readAuthority(this.#authority.allowsReportRead), this.#fetch);
      const attempts = ClinikoOutboundLaunchRecords.createReadOnly({ ...c.attempts, rateBudget: budget }, readAuthority(this.#authority.allowsAttemptRead), this.#fetch);
      if (!reports.ok || !attempts.ok) throw new Refusal("invalidConfig");
      const observed: TwilioRuntimeEvidence[] = []; let evidence: TwilioRuntimeEvidence | undefined;
      for (const row of history.rows) {
        const decoded = decodeTwilioOutboundReport(row.notes); if (!decoded.ok) throw new Refusal("malformed"); const report = decoded.value;
        if (actions.has(report.actionRef) || origins.has(report.original.recallRef)) throw new Refusal("mismatched");
        actions.add(report.actionRef); origins.add(report.original.recallRef);
        const read = await wait(reports.value.readReport({ recallRef: `cliniko:recall:${row.id}`, actionRef: report.actionRef, patientId: row.patientId }, signal));
        if (!read.ok) return read; const native = read.value;
        if (twilioOutboundReportDigest(native.record) !== twilioOutboundReportDigest(report) || native.recallAt !== row.recallAt || native.createdAt !== row.createdAt ||
            native.updatedAt !== row.updatedAt || native.recalled !== row.recalled || native.recalledAt !== row.recalledAt || native.archivedAt !== row.archivedAt) throw new Refusal("mismatched");
        const original = await wait(attempts.value.readPossibleAttempt({ recallRef: report.original.recallRef, actionRef: report.original.actionRef, patientId: report.patientId }, signal));
        if (!original.ok) return original; const a = original.value.attempt;
        if (outboundLaunchAttemptDigest(a) !== report.original.digest || !isDeepStrictEqual(a.provider, this.#auth.binding()) ||
            report.reportedAt < a.attemptedAt || report.reportedAt > now() || report.recordedAt > now() ||
            report.terminal && report.terminal.endedAt < a.attemptedAt || report.contact.kind === "stopRequested" && report.contact.stoppedAt < a.attemptedAt) throw new Refusal("mismatched");
        const entry = freeze({ report: native, original: original.value }); observed.push(entry);
        if (a.effectRef === identity.effectRef || a.capacityAllocationRef === identity.capacityAllocationRef) {
          if (evidence || a.effectRef !== identity.effectRef || a.capacityAllocationRef !== identity.capacityAllocationRef || report.accountSid !== accountSid) throw new Refusal("mismatched"); evidence = entry;
        }
      }
      await permit(); if (!isDeepStrictEqual(await scan(), history)) throw new Refusal("mismatched");
      for (const entry of observed) {
        const a = entry.original, fresh = await wait(attempts.value.readPossibleAttempt({ recallRef: a.recallRef, actionRef: a.attempt.actionRef, patientId: a.attempt.patientId }, signal));
        if (!fresh.ok) return fresh; if (!isDeepStrictEqual(fresh.value, a)) throw new Refusal("mismatched");
      }
      await permit(); current();
      return ok(Object.freeze({ kind: "nativeRuntimeHistory", selected: history.rows.length, scanned: history.scanned, ...(evidence ? { evidence } : {}) }));
    } catch (e) { return err({ kind: e instanceof Refusal || e instanceof OwnedBodyError || e instanceof PatientRecallHistoryError ? e.kind : "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
