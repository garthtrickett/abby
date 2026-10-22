import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { outboundConfigShard, outboundNativeInstant } from "../cliniko/internal/outbound-record-context.ts";
import { readNativeOutboundPatientHistory } from "../cliniko/internal/outbound-account-history.ts";
import { ClinikoOutboundLaunchRecords, outboundLaunchRecordSelection, outboundLaunchRecordOwnerBinding } from "../cliniko/outbound-launch-records.ts";
import type { OutboundLaunchRecordConfig, OutboundLaunchRecordQuery } from "../cliniko/outbound-launch-records.ts";
import { ClinikoTwilioOutboundUnansweredObservationRecords, twilioOutboundUnansweredObservationRecordBinding } from "../cliniko/twilio-outbound-unanswered-observation-records.ts";
import type { TwilioOutboundUnansweredObservationQuery } from "../cliniko/twilio-outbound-unanswered-observation-records.ts";
import { decodeTwilioOutboundUnansweredObservation, twilioOutboundUnansweredActionRef, TwilioOutboundUnansweredObservationAuthentication } from "../cliniko/twilio-outbound-unanswered-observation.ts";
import { outboundLaunchAttemptDigest } from "../cliniko/outbound-launch-attempt.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { TwilioAbbyOutboundRuntime } from "../voice/twilio-outbound-runtime.ts";
import type { AuthenticatedTwilioOutboundCall } from "../voice/twilio-outbound-runtime.ts";
import type { SignedTwilioWebhook } from "../voice/twilio-signed-ingress.ts";
import { TwilioOutboundUnansweredObservationProducer, twilioUnansweredObservationProfileBinding } from "./twilio-outbound-unanswered-observation.ts";
import { readTerminalObservationApproval } from "./internal/twilio-terminal-observation-approval.ts";
import { NativeRequestAllowance } from "./internal/native-request-allowance.ts";

type ProducerConfig = Parameters<typeof TwilioOutboundUnansweredObservationProducer.create>[0];
type ProducerPorts = Parameters<typeof TwilioOutboundUnansweredObservationProducer.create>[1];
type ObservationSelection = Pick<TwilioOutboundUnansweredObservationQuery,
  "scope" | "businessId" | "credentialFingerprint" | "outboundUnansweredObservationRecallTypeId" | "unansweredObservationPolicyDigest" | "ownerBinding" | "provider" | "authenticationBinding">;
export type TwilioUnansweredHistoryQuery = Readonly<{
  operation: "readOriginalUnansweredHistory"; patientId: string; accountSid: string; callSid: string; sessionActionRef: string;
  originalRecallRef: string; originalActionRef: string; originalDigest: string;
  observations: ObservationSelection;
  attempts: ReturnType<typeof outboundLaunchRecordSelection> & Readonly<{ ownerBinding: string }>;
  includeArchived: true; includeClosed: true;
}>;
type NativeQuery = TwilioOutboundUnansweredObservationQuery | OutboundLaunchRecordQuery;
export type TwilioUnansweredHistoryAuthority = Readonly<{
  allowsHistoryRead(query: TwilioUnansweredHistoryQuery, signal: AbortSignal): Promise<boolean>;
  allowsObservationRead(query: TwilioOutboundUnansweredObservationQuery, signal: AbortSignal): Promise<boolean>;
  allowsAttemptRead(query: OutboundLaunchRecordQuery, signal: AbortSignal): Promise<boolean>;
  current(query: TwilioUnansweredHistoryQuery | NativeQuery, signal: AbortSignal): boolean;
}>;
type Config = ProducerConfig & Readonly<{ attempts: OutboundLaunchRecordConfig; maximumNativeRequests: number }>;
type Ports = ProducerPorts & Readonly<{ history: TwilioUnansweredHistoryAuthority }>;
type Failure = Readonly<{ kind: "invalidConfig" | "unavailable" | "forbidden" }>;
type Outcome = Readonly<{ kind: "notificationRetained" | "ignoredStatus" }>;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** ACK of separately permitted native no-answer provenance only. Recovery uses
 * the reauthenticated sealed original and current native records, never a local
 * patient journal or a supplied note ID. No conversation/contact/clinical truth
 * or hold-release port exists here; a spent purpose cannot send another POST. */
export class ClinikoTwilioOutboundUnansweredDelivery {
  readonly #config: Config;
  readonly #ports: Ports;
  readonly #selected: ReturnType<TwilioAbbyOutboundRuntime["binding"]>;
  readonly #binding: TwilioAbbyOutboundRuntime["binding"];
  readonly #authenticate: TwilioAbbyOutboundRuntime["authenticateStatus"];
  readonly #auth: TwilioOutboundUnansweredObservationAuthentication;
  readonly #profile: string;
  readonly #base: string;
  private constructor(c: Config, p: Ports, auth: TwilioOutboundUnansweredObservationAuthentication, profile: string, shard: string) {
    const physical = c.observations.rateBudget;
    const rateBudget = Object.freeze({ claim: physical.claim.bind(physical), observe429: physical.observe429.bind(physical),
      ...(physical.checkHeadroom ? { checkHeadroom: physical.checkHeadroom.bind(physical) } : {}) });
    const capture = <T extends Config["observations"] | OutboundLaunchRecordConfig>(v: T): Readonly<T> =>
      Object.freeze<T>({ ...v, scope: Object.freeze({ ...v.scope }), rateBudget, ...(v.clock ? { clock: v.clock.bind(v) } : {}) });
    this.#config = Object.freeze({ ...c, key: Buffer.from(c.key), observations: capture(c.observations), attempts: capture(c.attempts) });
    this.#ports = Object.freeze({ source: Object.freeze({ read: p.source.read.bind(p.source), current: p.source.current.bind(p.source) }),
      record: Object.freeze({ allows: p.record.allows.bind(p.record), current: p.record.current.bind(p.record), producerAdmitted: p.record.producerAdmitted.bind(p.record) }),
      effects: p.effects.bind(p), native: p.native ?? fetch,
      history: Object.freeze({ allowsHistoryRead: p.history.allowsHistoryRead.bind(p.history), allowsObservationRead: p.history.allowsObservationRead.bind(p.history),
        allowsAttemptRead: p.history.allowsAttemptRead.bind(p.history), current: p.history.current.bind(p.history) }) });
    this.#selected = Object.freeze({ ...c.runtime.binding() }); this.#binding = c.runtime.binding.bind(c.runtime);
    this.#authenticate = c.runtime.authenticateStatus.bind(c.runtime); this.#auth = auth; this.#profile = profile;
    this.#base = `https://api.${shard}.cliniko.com/v1`;
  }
  static create(c: Config, p: Ports): Result<ClinikoTwilioOutboundUnansweredDelivery, Failure> {
    try {
      const r = c.observations, a = c.attempts;
      const shard = outboundConfigShard({ ...r, outboundRecallTypeId: r.outboundUnansweredObservationRecallTypeId, recordPolicyDigest: r.unansweredObservationPolicyDigest }, p.native ?? fetch);
      if (!(c.runtime instanceof TwilioAbbyOutboundRuntime) || !shard || !TwilioOutboundUnansweredObservationProducer.create(c, p).ok ||
          !Number.isSafeInteger(c.maximumNativeRequests) || c.maximumNativeRequests < 1 || c.maximumNativeRequests > 180 ||
          !isDeepStrictEqual(r.scope, a.scope) || r.apiKey !== a.apiKey || r.businessId !== a.businessId || r.rateBudget !== a.rateBudget ||
          r.outboundUnansweredObservationRecallTypeId === a.outboundAttemptRecallTypeId || !outboundLaunchRecordOwnerBinding(a) ||
          [p.history?.allowsHistoryRead, p.history?.allowsObservationRead, p.history?.allowsAttemptRead, p.history?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      const provider = c.runtime.binding(), auth = new TwilioOutboundUnansweredObservationAuthentication(c.key, { ref: provider.ref, bindingDigest: provider.bindingDigest });
      const profile = twilioUnansweredObservationProfileBinding(r, c.key);
      if (!profile || !ClinikoTwilioOutboundUnansweredObservationRecords.createReadOnly(r, auth, { allows: p.history.allowsObservationRead, current: p.history.current }, p.native).ok ||
          !ClinikoOutboundLaunchRecords.createReadOnly(a, { allows: p.history.allowsAttemptRead, current: p.history.current }, p.native).ok) return err({ kind: "invalidConfig" });
      return ok(new ClinikoTwilioOutboundUnansweredDelivery(c, p, auth, profile, shard));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  matchesRuntime(runtime: TwilioAbbyOutboundRuntime): boolean {
    try { return runtime instanceof TwilioAbbyOutboundRuntime && isDeepStrictEqual(runtime.binding(), this.#selected) && isDeepStrictEqual(this.#binding(), this.#selected); }
    catch { return false; }
  }
  async receiveStatus(request: SignedTwilioWebhook, external: AbortSignal, allowance?: NativeRequestAllowance): Promise<Result<Outcome, Failure>> {
    if (!(external instanceof AbortSignal) || external.aborted || allowance !== undefined && !(allowance instanceof NativeRequestAllowance)) return err({ kind: "unavailable" });
    const c = this.#config, p = this.#ports, controller = new AbortController(), ms = Math.min(c.observations.deadlineMs ?? 15000, c.attempts.deadlineMs ?? 15000);
    const signal = AbortSignal.any([external, controller.signal]), timer = setTimeout(() => controller.abort(), ms), began = performance.now();
    try {
      const raw = freeze(structuredClone(request)), event = this.#authenticate(raw);
      if (!event.ok || !this.matchesRuntime(c.runtime)) return err({ kind: "forbidden" });
      if (event.value.status !== "no-answer") return ok({ kind: "ignoredStatus" });
      const call = freeze(structuredClone(event.value.call)), a = call.context.original.attempt, r = c.observations;
      if (!isDeepStrictEqual(a.scope, r.scope) || a.businessId !== r.businessId || a.credentialFingerprint !== clinikoCredentialFingerprint(r.apiKey)) return err({ kind: "forbidden" });
      let last = call.receivedAt;
      const now = () => { const at = r.clock?.() ?? new Date().toISOString();
        if (signal.aborted || performance.now() - began > ms || outboundNativeInstant(at) !== at || at < last || !this.matchesRuntime(c.runtime)) throw Error("Notification unavailable");
        last = at; return at;
      };
      const selected = () => { try { now(); return true; } catch { return false; } };
      const admitted = await readTerminalObservationApproval(p.source, call, { scope: r.scope, profileRef: this.#selected.profileRef,
        terminalBinding: this.#profile, bindingField: "unansweredCallObservationBinding" }, signal, selected);
      if (!admitted.ok) return admitted;
      const current = admitted.value.current, physical = r.rateBudget; let claims = 0;
      const budget: ClinikoRequestBudget = Object.freeze({ claim: () => !current() || ++claims > c.maximumNativeRequests || allowance && !allowance.take()
        ? { kind: "unavailable" as const } : physical.claim(), observe429: physical.observe429.bind(physical),
        ...(physical.checkHeadroom ? { checkHeadroom: (n: number) => !current() || claims + n > c.maximumNativeRequests || allowance && !allowance.hasHeadroom(n)
          ? { kind: "unavailable" as const } : physical.checkHeadroom!(n) } : {}) });
      const producer = TwilioOutboundUnansweredObservationProducer.create({ runtime: c.runtime, observations: { ...r, rateBudget: budget }, key: c.key }, p);
      if (!producer.ok || !current()) return err({ kind: "unavailable" });
      const retained = await awaitUntilAbort(producer.value.observeStatus(raw, signal), signal);
      if (!retained || !current()) return err({ kind: "unavailable" });
      if (retained.ok && retained.value.kind === "accepted") return ok({ kind: "notificationRetained" });
      return await this.#recover(call, budget, signal, now, current) && current()
        ? ok({ kind: "notificationRetained" }) : err({ kind: "unavailable" });
    } catch { return err({ kind: "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async #recover(call: AuthenticatedTwilioOutboundCall, budget: ClinikoRequestBudget, signal: AbortSignal, now: () => string, sourceCurrent: () => boolean): Promise<boolean> {
    const c = this.#config, p = this.#ports, r = { ...c.observations, rateBudget: budget }, a = call.context.original.attempt;
    const q: TwilioUnansweredHistoryQuery = freeze({ operation: "readOriginalUnansweredHistory", patientId: a.patientId, accountSid: call.accountSid,
      callSid: call.callSid, sessionActionRef: call.context.sessionActionRef, originalRecallRef: call.context.original.recallRef,
      originalActionRef: a.actionRef, originalDigest: call.context.attemptDigest, includeArchived: true, includeClosed: true,
      observations: { scope: r.scope, businessId: r.businessId, credentialFingerprint: clinikoCredentialFingerprint(r.apiKey),
        outboundUnansweredObservationRecallTypeId: r.outboundUnansweredObservationRecallTypeId, unansweredObservationPolicyDigest: r.unansweredObservationPolicyDigest,
        ownerBinding: twilioOutboundUnansweredObservationRecordBinding(r, this.#auth)!, provider: this.#auth.binding(), authenticationBinding: this.#auth.authenticationBinding() },
      attempts: { ...outboundLaunchRecordSelection(c.attempts), ownerBinding: outboundLaunchRecordOwnerBinding(c.attempts)! } });
    const grants = new Set<NativeQuery>();
    const current = () => { now(); if (!sourceCurrent() || p.history.current(q, signal) !== true || [...grants].some(g => p.history.current(g, signal) !== true)) throw Error("Notification unavailable"); };
    const wait = async <T>(task: Promise<T>) => { const value = await awaitUntilAbort(task, signal); if (value === undefined) throw Error("Notification unavailable"); current(); return value; };
    const permit = async () => { current(); if (await wait(p.history.allowsHistoryRead(q, signal)) !== true) throw Error("Notification unavailable"); current(); };
    const authority = <Q extends NativeQuery>(allows: (query: Q, stop: AbortSignal) => Promise<boolean>) => ({
      allows: async (query: Q, stop: AbortSignal) => { await permit();
        if (p.history.current(query, stop) !== true || await wait(allows(query, stop)) !== true) return false;
        grants.add(query); current(); return p.history.current(query, stop) === true;
      },
      current: (query: Q, stop: AbortSignal) => { try { current(); return !stop.aborted && p.history.current(query, stop) === true; } catch { return false; } },
    });
    const scan = () => readNativeOutboundPatientHistory({ base: this.#base, patientId: a.patientId, typeIds: [r.outboundUnansweredObservationRecallTypeId],
      apiKey: r.apiKey, contactEmail: r.contactEmail, rateBudget: budget }, { signal, now, current, permit, wait }, p.native ?? fetch);
    const history = await scan(), action = twilioOutboundUnansweredActionRef(call.context.sessionActionRef);
    const matching = [];
    for (const row of history.rows) {
      const decoded = decodeTwilioOutboundUnansweredObservation(row.notes);
      if (!decoded.ok || !this.#auth.verify(decoded.value)) return false;
      if (decoded.value.actionRef === action) matching.push({ row, record: decoded.value });
    }
    if (matching.length !== 1) return false;
    const found = matching[0]!;
    if (!this.#auth.matchesOriginal(found.record, call.context, call.accountSid) || found.record.callSid !== call.callSid ||
        found.record.recordedAt > now() || found.record.receivedAt > now()) return false;
    const observations = ClinikoTwilioOutboundUnansweredObservationRecords.createReadOnly(r, this.#auth, authority(p.history.allowsObservationRead), p.native);
    const attempts = ClinikoOutboundLaunchRecords.createReadOnly({ ...c.attempts, rateBudget: budget }, authority(p.history.allowsAttemptRead), p.native);
    if (!observations.ok || !attempts.ok) return false;
    const observation = await wait(observations.value.readObservation({ recallRef: `cliniko:recall:${found.row.id}`, actionRef: found.record.actionRef, patientId: a.patientId }, signal));
    if (!observation.ok) return false;
    const native = observation.value, row = found.row;
    if (!isDeepStrictEqual(native.record, found.record) || native.recallAt !== row.recallAt || native.createdAt !== row.createdAt || native.updatedAt !== row.updatedAt ||
        native.recalled !== row.recalled || native.recalledAt !== row.recalledAt || native.archivedAt !== row.archivedAt) return false;
    const binding = { recallRef: call.context.original.recallRef, actionRef: a.actionRef, patientId: a.patientId };
    const original = await wait(attempts.value.readPossibleAttempt(binding, signal));
    if (!original.ok || !isDeepStrictEqual(original.value.attempt, a) || outboundLaunchAttemptDigest(original.value.attempt) !== call.context.attemptDigest) return false;
    if (!isDeepStrictEqual(await scan(), history)) return false;
    const fresh = await wait(attempts.value.readPossibleAttempt(binding, signal));
    if (!fresh.ok || !isDeepStrictEqual(original.value, fresh.value)) return false;
    await permit(); current(); return true;
  }
}
