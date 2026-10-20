import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OwnedBodyError } from "../shared/owned-body-bytes.ts";
import { validRecallMarker } from "./recall-note.ts";
import { outboundConfigShard, outboundNativeInstant } from "./internal/outbound-record-context.ts";
import { PatientRecallHistoryError } from "./internal/patient-recall-history.ts";
import type { NativeOutboundContext, NativeOutboundFailure } from "./internal/outbound-native-record.ts";
import { clinikoCredentialFingerprint } from "./read-budget.ts";
import { ClinikoOutboundLaunchRecords, outboundLaunchRecordSelection, outboundLaunchRecordOwnerBinding } from "./outbound-launch-records.ts";
import type { OutboundLaunchRecordConfig, OutboundLaunchRecordQuery, OutboundLaunchRecord } from "./outbound-launch-records.ts";
import { outboundLaunchAttemptDigest } from "./outbound-launch-attempt.ts";
import { ClinikoTwilioOutboundTerminalObservationRecords, twilioOutboundTerminalObservationRecordBinding } from "./twilio-outbound-terminal-observation-records.ts";
import type { TwilioOutboundTerminalObservationConfig, TwilioOutboundTerminalObservationQuery } from "./twilio-outbound-terminal-observation-records.ts";
import { decodeTwilioOutboundTerminalObservation, twilioOutboundTerminalObservationDigest, TwilioOutboundTerminalObservationAuthentication } from "./twilio-outbound-terminal-observation.ts";
import type { TwilioOutboundTerminalObservation } from "./twilio-outbound-terminal-observation.ts";
import { readNativeOutboundAccountHistory, NativeOutboundHistoryReadError } from "./internal/outbound-account-history.ts";
import type { OutboundRuntimeCallIdentity } from "../voice/outbound-runtime.ts";

type Config = Readonly<{ observations: TwilioOutboundTerminalObservationConfig; attempts: OutboundLaunchRecordConfig }>;
export type TwilioTerminalHistoryQuery = Readonly<{
  operation: "readAccountTerminalObservationHistory"; identity: OutboundRuntimeCallIdentity; accountSid: string;
  observations: Pick<TwilioOutboundTerminalObservationQuery, "scope" | "businessId" | "credentialFingerprint" | "outboundTerminalObservationRecallTypeId" | "terminalObservationPolicyDigest" | "ownerBinding" | "provider" | "authenticationBinding">;
  attempts: ReturnType<typeof outboundLaunchRecordSelection> & Readonly<{ ownerBinding: string }>;
  includeArchived: true; includeClosed: true;
}>;
export type TwilioTerminalHistoryAuthority = Readonly<{
  allowsHistoryRead(query: TwilioTerminalHistoryQuery, signal: AbortSignal): Promise<boolean>;
  allowsObservationRead(query: TwilioOutboundTerminalObservationQuery, signal: AbortSignal): Promise<boolean>;
  allowsAttemptRead(query: OutboundLaunchRecordQuery, signal: AbortSignal): Promise<boolean>;
  current(query: TwilioTerminalHistoryQuery | TwilioOutboundTerminalObservationQuery | OutboundLaunchRecordQuery, signal: AbortSignal): boolean;
}>;
export type TwilioTerminalEvidence = Readonly<{ observation: NativeOutboundContext<TwilioOutboundTerminalObservation>; original: OutboundLaunchRecord }>;
class Refusal extends Error {
  readonly kind: NativeOutboundFailure["kind"];
  constructor(kind: NativeOutboundFailure["kind"]) { super("Native runtime evidence unavailable"); this.kind = kind; }
}
function freeze<T>(v: T): T { if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }

/** Cold discovery of separately authenticated completed notifications from the
 * original runtime pair. Collection, protected notification and original reads
 * all require independent current grants, including the selected verifier key.
 * No lost session/note IDs or local private journal are required. A notification
 * remains provenance only; absence, MAC validity and this read do not establish
 * carrier closure, speech/contact truth or permission to release either hold. */
export class ClinikoTwilioOutboundTerminalHistory {
  readonly #config: Config;
  readonly #auth: TwilioOutboundTerminalObservationAuthentication;
  readonly #authority: TwilioTerminalHistoryAuthority;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  private constructor(c: Config, auth: TwilioOutboundTerminalObservationAuthentication, authority: TwilioTerminalHistoryAuthority, port: typeof fetch, shard: string) {
    const budget = c.observations.rateBudget;
    const rateBudget = Object.freeze({ claim: budget.claim.bind(budget), observe429: budget.observe429.bind(budget) });
    const capture = <T extends TwilioOutboundTerminalObservationConfig | OutboundLaunchRecordConfig>(v: T): Readonly<T> =>
      Object.freeze<T>({ ...v, scope: Object.freeze({ ...v.scope }), rateBudget, ...(v.clock ? { clock: v.clock.bind(v) } : {}) });
    this.#config = Object.freeze({ observations: capture(c.observations), attempts: capture(c.attempts) });
    this.#auth = auth; this.#fetch = port; this.#base = `https://api.${shard}.cliniko.com/v1`;
    this.#authority = Object.freeze({ allowsHistoryRead: authority.allowsHistoryRead.bind(authority), allowsObservationRead: authority.allowsObservationRead.bind(authority),
      allowsAttemptRead: authority.allowsAttemptRead.bind(authority), current: authority.current.bind(authority) });
  }
  static create(c: Config, auth: TwilioOutboundTerminalObservationAuthentication, authority: TwilioTerminalHistoryAuthority,
    port: typeof fetch = fetch): Result<ClinikoTwilioOutboundTerminalHistory, NativeOutboundFailure> {
    try {
      const r = c.observations, a = c.attempts, shard = outboundConfigShard({ ...r, outboundRecallTypeId: r.outboundTerminalObservationRecallTypeId, recordPolicyDigest: r.terminalObservationPolicyDigest }, port);
      if (!shard || !(auth instanceof TwilioOutboundTerminalObservationAuthentication) || !twilioOutboundTerminalObservationRecordBinding(r, auth) || !outboundLaunchRecordOwnerBinding(a) ||
          !isDeepStrictEqual(r.scope, a.scope) || r.businessId !== a.businessId || r.apiKey !== a.apiKey || r.rateBudget !== a.rateBudget ||
          r.outboundTerminalObservationRecallTypeId === a.outboundAttemptRecallTypeId ||
          [authority?.allowsHistoryRead, authority?.allowsObservationRead, authority?.allowsAttemptRead, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      return ok(new ClinikoTwilioOutboundTerminalHistory(c, auth, authority, port, shard));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async findForRuntime(input: OutboundRuntimeCallIdentity, accountSid: string, external: AbortSignal): Promise<Result<Readonly<{
    kind: "nativeTerminalObservationHistory"; selected: number; scanned: number; evidence?: TwilioTerminalEvidence;
  }>, NativeOutboundFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    let identity: OutboundRuntimeCallIdentity;
    try {
      if (!input || Object.keys(input).sort().join(",") !== "capacityAllocationRef,effectRef" || !validRecallMarker(input.effectRef) ||
          !validRecallMarker(input.capacityAllocationRef) || input.effectRef === input.capacityAllocationRef || !/^AC[0-9a-f]{32}$/.test(accountSid)) return err({ kind: "invalidQuery" });
      identity = Object.freeze({ ...input });
    } catch { return err({ kind: "invalidQuery" }); }
    const c = this.#config, r = c.observations, controller = new AbortController(), ms = Math.min(r.deadlineMs ?? 15000, c.attempts.deadlineMs ?? 15000);
    const timer = setTimeout(() => controller.abort(), ms), signal = AbortSignal.any([external, controller.signal]), began = performance.now();
    let last = "", claims = 0;
    const q: TwilioTerminalHistoryQuery = freeze({ operation: "readAccountTerminalObservationHistory", identity, accountSid, includeArchived: true, includeClosed: true,
      observations: { scope: r.scope, businessId: r.businessId, credentialFingerprint: clinikoCredentialFingerprint(r.apiKey), outboundTerminalObservationRecallTypeId: r.outboundTerminalObservationRecallTypeId,
        terminalObservationPolicyDigest: r.terminalObservationPolicyDigest, ownerBinding: twilioOutboundTerminalObservationRecordBinding(r, this.#auth)!, provider: this.#auth.binding(), authenticationBinding: this.#auth.authenticationBinding() },
      attempts: { ...outboundLaunchRecordSelection(c.attempts), ownerBinding: outboundLaunchRecordOwnerBinding(c.attempts)! } });
    const grants = new Map<string, TwilioOutboundTerminalObservationQuery | OutboundLaunchRecordQuery>();
    const now = () => { const at = r.clock ? r.clock() : new Date().toISOString();
      if (signal.aborted || performance.now() - began > ms || typeof at !== "string" || outboundNativeInstant(at) !== at || at < last) throw new Refusal("unavailable"); last = at; return at; };
    const wait = async <T>(task: Promise<T>): Promise<T> => { const v = await awaitUntilAbort(task, signal); if (v === undefined) throw new Refusal("unavailable"); now(); return v; };
    const current = () => { now(); if (this.#authority.current(q, signal) !== true || [...grants.values()].some(g => this.#authority.current(g, signal) !== true)) throw new Refusal("forbidden"); now(); };
    const permit = async () => { current(); if (await wait(this.#authority.allowsHistoryRead(q, signal)) !== true) throw new Refusal("forbidden"); current(); };
    const budget = Object.freeze({ claim: () => ++claims <= 180 ? r.rateBudget.claim() : { kind: "unavailable" as const }, observe429: r.rateBudget.observe429 });
    const readAuthority = <G extends TwilioOutboundTerminalObservationQuery | OutboundLaunchRecordQuery>(allow: (g: G, s: AbortSignal) => Promise<boolean>) => ({
      allows: async (g: G, s: AbortSignal) => { await permit(); if (this.#authority.current(g, s) !== true || await wait(allow(g, s)) !== true) return false;
        const key = g.operation + ":" + g.recallRef, old = grants.get(key);
        if ("observation" in g && g.observation || "attempt" in g && g.attempt || !old) grants.set(key, g);
        current(); return this.#authority.current(g, s) === true; },
      current: (g: G, s: AbortSignal) => { try { current(); return this.#authority.current(g, s) === true; } catch { return false; } }
    });
    try {
      now();
      const scan = () => readNativeOutboundAccountHistory({ base: this.#base, typeIds: [r.outboundTerminalObservationRecallTypeId],
        apiKey: r.apiKey, contactEmail: r.contactEmail, rateBudget: budget }, { signal, now, current, permit, wait }, this.#fetch);
      const history = await scan(), actions = new Set<string>(), origins = new Set<string>();
      const observations = ClinikoTwilioOutboundTerminalObservationRecords.createReadOnly({ ...r, rateBudget: budget }, this.#auth,
        readAuthority(this.#authority.allowsObservationRead), this.#fetch);
      const attempts = ClinikoOutboundLaunchRecords.createReadOnly({ ...c.attempts, rateBudget: budget }, readAuthority(this.#authority.allowsAttemptRead), this.#fetch);
      if (!observations.ok || !attempts.ok) throw new Refusal("invalidConfig");
      const observed: TwilioTerminalEvidence[] = []; let evidence: TwilioTerminalEvidence | undefined;
      for (const row of history.rows) {
        const decoded = decodeTwilioOutboundTerminalObservation(row.notes); if (!decoded.ok) throw new Refusal("malformed"); const observation = decoded.value;
        if (actions.has(observation.actionRef) || origins.has(observation.original.recallRef)) throw new Refusal("mismatched");
        actions.add(observation.actionRef); origins.add(observation.original.recallRef);
        const read = await wait(observations.value.readObservation({ recallRef: `cliniko:recall:${row.id}`, actionRef: observation.actionRef, patientId: row.patientId }, signal));
        if (!read.ok) return read; const native = read.value;
        if (twilioOutboundTerminalObservationDigest(native.record) !== twilioOutboundTerminalObservationDigest(observation) || native.recallAt !== row.recallAt || native.createdAt !== row.createdAt ||
            native.updatedAt !== row.updatedAt || native.recalled !== row.recalled || native.recalledAt !== row.recalledAt || native.archivedAt !== row.archivedAt) throw new Refusal("mismatched");
        const original = await wait(attempts.value.readPossibleAttempt({ recallRef: observation.original.recallRef, actionRef: observation.original.actionRef, patientId: observation.patientId }, signal));
        if (!original.ok) return original; const a = original.value.attempt;
        if (outboundLaunchAttemptDigest(a) !== observation.original.digest || !isDeepStrictEqual(a.provider, this.#auth.binding()) ||
            observation.receivedAt < a.attemptedAt || observation.receivedAt > now() || observation.recordedAt > now()) throw new Refusal("mismatched");
        const entry = freeze({ observation: native, original: original.value }); observed.push(entry);
        if (a.effectRef === identity.effectRef || a.capacityAllocationRef === identity.capacityAllocationRef) {
          if (evidence || a.effectRef !== identity.effectRef || a.capacityAllocationRef !== identity.capacityAllocationRef || observation.accountSid !== accountSid) throw new Refusal("mismatched"); evidence = entry;
        }
      }
      await permit(); if (!isDeepStrictEqual(await scan(), history)) throw new Refusal("mismatched");
      for (const entry of observed) {
        const a = entry.original, fresh = await wait(attempts.value.readPossibleAttempt({ recallRef: a.recallRef, actionRef: a.attempt.actionRef, patientId: a.attempt.patientId }, signal));
        if (!fresh.ok) return fresh; if (!isDeepStrictEqual(fresh.value, a)) throw new Refusal("mismatched");
      }
      await permit(); current();
      return ok(Object.freeze({ kind: "nativeTerminalObservationHistory", selected: history.rows.length, scanned: history.scanned, ...(evidence ? { evidence } : {}) }));
    } catch (e) { return err({ kind: e instanceof Refusal || e instanceof NativeOutboundHistoryReadError || e instanceof OwnedBodyError || e instanceof PatientRecallHistoryError ? e.kind : "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
