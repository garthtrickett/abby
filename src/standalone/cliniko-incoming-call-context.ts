import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, Result, VerifiedPatient } from "../core/model.ts";
import type { MissedCallContext } from "../core/missed-call.ts";
import { callIdFor } from "../voice/admission.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { outboundConfigShard, outboundRecordSelection, outboundNativeInstant } from "../cliniko/internal/outbound-record-context.ts";
import { PatientRecallSnapshot } from "../cliniko/internal/patient-recall-snapshot.ts";
import type { AccountRecallRow } from "../cliniko/internal/patient-recall-history.ts";
import { ClinikoOutboundRecipientRecords } from "../cliniko/outbound-recipient-records.ts";
import type { OutboundRecordConfig, OutboundRecordQuery, OutboundRecipientRecord } from "../cliniko/outbound-recipient-records.ts";
import { decodeOutboundRecipientRequest } from "../cliniko/outbound-recipient-request.ts";
import { ClinikoOutboundLaunchRecords, outboundLaunchRecordSelection } from "../cliniko/outbound-launch-records.ts";
import type { OutboundLaunchRecordConfig, OutboundLaunchRecordQuery, OutboundLaunchRecord } from "../cliniko/outbound-launch-records.ts";
import { decodeOutboundLaunchAttempt, outboundAttemptMatchesRequest, outboundLaunchAttemptDigest } from "../cliniko/outbound-launch-attempt.ts";
import { ClinikoTwilioOutboundTerminalObservationRecords } from "../cliniko/twilio-outbound-terminal-observation-records.ts";
import type { TwilioOutboundTerminalObservationConfig, TwilioOutboundTerminalObservationQuery } from "../cliniko/twilio-outbound-terminal-observation-records.ts";
import { decodeTwilioOutboundTerminalObservation, TwilioOutboundTerminalObservationAuthentication } from "../cliniko/twilio-outbound-terminal-observation.ts";
import type { TwilioOutboundTerminalObservation } from "../cliniko/twilio-outbound-terminal-observation.ts";
import { ClinikoTwilioOutboundUnansweredObservationRecords } from "../cliniko/twilio-outbound-unanswered-observation-records.ts";
import type { TwilioOutboundUnansweredObservationConfig, TwilioOutboundUnansweredObservationQuery } from "../cliniko/twilio-outbound-unanswered-observation-records.ts";
import { decodeTwilioOutboundUnansweredObservation, TwilioOutboundUnansweredObservationAuthentication } from "../cliniko/twilio-outbound-unanswered-observation.ts";
import type { TwilioOutboundUnansweredObservation } from "../cliniko/twilio-outbound-unanswered-observation.ts";
import type { NativeOutboundContext } from "../cliniko/internal/outbound-native-record.ts";
import { ClinikoOutboundAppointmentTarget } from "../cliniko/outbound-appointment-target.ts";
import type { OutboundTargetAuthority, OutboundTargetObservation } from "../cliniko/outbound-appointment-target.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";

type Notification = TwilioOutboundTerminalObservation | TwilioOutboundUnansweredObservation;
type NotificationQuery = TwilioOutboundTerminalObservationQuery | TwilioOutboundUnansweredObservationQuery;
type PatientOperation = "appointments.read" | "appointments.cancel" | "appointments.reschedule";
type CallBinding = Readonly<{
  callId: string; sessionId: string; policyVersion: string; receivedAt: string;
  patientId: string; patientOperation: PatientOperation; readPolicyDigest: string; lookBackMs: number;
  selection: ReturnType<typeof outboundRecordSelection>;
}>;
export type IncomingCallHistoryQuery = CallBinding & Readonly<{
  operation: "readIncomingCallHistory"; includeArchived: true; includeClosed: true;
  attemptSelection: ReturnType<typeof outboundLaunchRecordSelection>; observationTypeId: string; unansweredObservationTypeId?: string;
}>;
export type IncomingCallPurposeQuery = CallBinding & Readonly<{
  operation: "approveIncomingCallContext"; request: OutboundRecipientRecord; original: OutboundLaunchRecord;
  observation: NativeOutboundContext<Notification>;
}>;
type NativeQuery = OutboundRecordQuery | OutboundLaunchRecordQuery | NotificationQuery;
type Query = IncomingCallHistoryQuery | IncomingCallPurposeQuery | NativeQuery;
export type IncomingCallContextAuthority = Readonly<{
  allowsHistoryRead(query: IncomingCallHistoryQuery, signal: AbortSignal): Promise<boolean>;
  allowsPurpose(query: IncomingCallPurposeQuery, signal: AbortSignal): Promise<boolean>;
  allowsRequestRead(query: OutboundRecordQuery, signal: AbortSignal): Promise<boolean>;
  allowsAttemptRead(query: OutboundLaunchRecordQuery, signal: AbortSignal): Promise<boolean>;
  allowsObservationRead(query: NotificationQuery, signal: AbortSignal): Promise<boolean>;
  current(query: Query, signal: AbortSignal): boolean;
}>;
export type IncomingCallContextProvision = Readonly<{
  requests: OutboundRecordConfig; attempts: OutboundLaunchRecordConfig; observations: TwilioOutboundTerminalObservationConfig;
  authentication: TwilioOutboundTerminalObservationAuthentication; accountSid: string;
  unanswered?: Readonly<{ records: TwilioOutboundUnansweredObservationConfig; authentication: TwilioOutboundUnansweredObservationAuthentication }>;
  /** Explicit clinic-approved recency, with no activating default. */
  lookBackMs: number; readPolicyDigest: string; authority: IncomingCallContextAuthority;
  target?: Readonly<{ appointmentPolicyDigest: string; authority: OutboundTargetAuthority }>;
}>;
type Config = IncomingCallContextProvision & Readonly<{
  receipt: AdmissionReceipt; inbound: AuthenticatedInboundCall; sessionId: string; policyVersion: string;
  signal: AbortSignal; fetchPort?: typeof fetch;
}>;
type Failure = Readonly<{ kind: "missedCallContextUnavailable" }>;
const unavailable = <T>(): Result<T, Failure> => err({ kind: "missedCallContextUnavailable" });
function freezeQuery<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeQuery(child); Object.freeze(value); }
  return value;
}
type Selection = Readonly<{ context: MissedCallContext; originalDigest: string; target?: OutboundTargetObservation }>;
const exactRow = (native: Readonly<{ recallRef: string; recallAt: string; createdAt: string; updatedAt: string;
  recalled: boolean; recalledAt: string | null; archivedAt: string | null }>, row: AccountRecallRow) =>
  native.recallRef === `cliniko:recall:${row.id}` && native.recallAt === row.recallAt && native.createdAt === row.createdAt &&
  native.updatedAt === row.updatedAt && native.recalled === row.recalled && native.recalledAt === row.recalledAt && native.archivedAt === row.archivedAt;

/** Incoming native provenance, never an outgoing admission or a patient proof.
 * Protected reads resolve the actual independent verifier each time. A private
 * original selected for the explanation cannot silently change at a later move.
 * No native call/contact/clinical mutation or local persistence exists here. */
export class ClinikoIncomingCallContext {
  readonly #config: Config;
  readonly #base: string;
  #last = "";
  #closed = false;
  #busy = false;
  #originalDigest: string | undefined;
  #purpose: MissedCallContext["purpose"] | undefined;
  #retained: (() => boolean) | undefined;
  private constructor(config: Config, base: string) { this.#config = config; this.#base = base; }

  static create(config: Config): Result<ClinikoIncomingCallContext, Failure> {
    try {
      const r = config.requests, a = config.attempts, o = config.observations, u = config.unanswered, receipt = config.receipt, incoming = config.inbound;
      const shard = outboundConfigShard(r, config.fetchPort ?? fetch), authority = config.authority;
      if (!shard || !receipt || !incoming || receipt.lifecycle === "ended" || receipt.admission.direction === "outbound" ||
          receipt.callId !== callIdFor(incoming.key) || !isDeepStrictEqual(receipt.admission.key, incoming.key) ||
          receipt.admission.dialedNumber !== incoming.dialedNumber || !config.sessionId || !config.policyVersion ||
          !isDeepStrictEqual(receipt.scope, r.scope) || outboundNativeInstant(incoming.receivedAt) !== incoming.receivedAt ||
          incoming.receivedAt > receipt.admission.acceptedAt || !(config.signal instanceof AbortSignal) || config.signal.aborted ||
          ![a, o, ...(u ? [u.records] : [])].every(c => c.apiKey === r.apiKey && c.businessId === r.businessId && c.rateBudget === r.rateBudget && isDeepStrictEqual(c.scope, r.scope)) ||
          new Set([r.outboundRecallTypeId, a.outboundAttemptRecallTypeId, o.outboundTerminalObservationRecallTypeId,
            ...(u ? [u.records.outboundUnansweredObservationRecallTypeId] : [])]).size !== (u ? 4 : 3) ||
          u && (!(u.authentication instanceof TwilioOutboundUnansweredObservationAuthentication) || !isDeepStrictEqual(u.authentication.binding(), config.authentication.binding())) ||
          !(config.authentication instanceof TwilioOutboundTerminalObservationAuthentication) || !/^AC[0-9a-f]{32}$/.test(config.accountSid) ||
          !Number.isSafeInteger(config.lookBackMs) || config.lookBackMs < 1 || !/^[a-f0-9]{64}$/.test(config.readPolicyDigest) ||
          [authority?.allowsHistoryRead, authority?.allowsPurpose, authority?.allowsRequestRead, authority?.allowsAttemptRead,
            authority?.allowsObservationRead, authority?.current].some(f => typeof f !== "function")) return unavailable();
      const port = config.fetchPort ?? fetch;
      if (!ClinikoOutboundRecipientRecords.createReadOnly(r, { allows: authority.allowsRequestRead, current: authority.current }, port).ok ||
          !ClinikoOutboundLaunchRecords.createReadOnly(a, { allows: authority.allowsAttemptRead, current: authority.current }, port).ok ||
          !ClinikoTwilioOutboundTerminalObservationRecords.createReadOnly(o, config.authentication,
            { allows: authority.allowsObservationRead, current: authority.current }, port).ok ||
          u && !ClinikoTwilioOutboundUnansweredObservationRecords.createReadOnly(u.records, u.authentication,
            { allows: authority.allowsObservationRead, current: authority.current }, port).ok ||
          config.target && !ClinikoOutboundAppointmentTarget.create({ requests: r, appointmentPolicyDigest: config.target.appointmentPolicyDigest },
            config.target.authority, port).ok) return unavailable();
      const captured: Config = Object.freeze({ ...config, receipt: structuredClone(receipt), inbound: structuredClone(incoming),
        requests: Object.freeze({ ...r, scope: Object.freeze({ ...r.scope }), ...(r.clock ? { clock: r.clock.bind(r) } : {}) }),
        attempts: Object.freeze({ ...a, scope: Object.freeze({ ...a.scope }), ...(a.clock ? { clock: a.clock.bind(a) } : {}) }),
        observations: Object.freeze({ ...o, scope: Object.freeze({ ...o.scope }), ...(o.clock ? { clock: o.clock.bind(o) } : {}) }),
        ...(u ? { unanswered: Object.freeze({ authentication: u.authentication, records: Object.freeze({ ...u.records,
          scope: Object.freeze({ ...u.records.scope }), ...(u.records.clock ? { clock: u.records.clock.bind(u.records) } : {}) }) }) } : {}),
        authority: Object.freeze({ allowsHistoryRead: authority.allowsHistoryRead.bind(authority), allowsPurpose: authority.allowsPurpose.bind(authority),
          allowsRequestRead: authority.allowsRequestRead.bind(authority), allowsAttemptRead: authority.allowsAttemptRead.bind(authority),
          allowsObservationRead: authority.allowsObservationRead.bind(authority), current: authority.current.bind(authority) }),
        ...(config.target ? { target: Object.freeze({ ...config.target, authority: Object.freeze({
          allows: config.target.authority.allows.bind(config.target.authority), current: config.target.authority.current.bind(config.target.authority) }) }) } : {}) });
      return ok(new ClinikoIncomingCallContext(captured, `https://api.${shard}.cliniko.com/v1`));
    } catch { return unavailable(); }
  }

  usesBudget(budget: OutboundRecordConfig["rateBudget"]): boolean { return this.#config.requests.rateBudget === budget; }
  /** Sticky constraint: withdrawal must refuse, never fall back to a different
   * appointment merely because the selected original is no longer readable. */
  hasOriginalAppointment(): boolean { return !!this.#originalDigest && this.#purpose === "sickDay"; }
  current(): boolean {
    try {
      const c = this.#config, at = c.requests.clock ? c.requests.clock() : new Date().toISOString();
      if (this.#closed || c.signal.aborted) return false;
      if (outboundNativeInstant(at) !== at || at < this.#last || at < c.inbound.receivedAt) { this.#closed = true; return false; }
      this.#last = at; return this.#retained?.() === true;
    } catch { return false; }
  }
  matchesWorkflow(input: Readonly<{ scope: AdmissionReceipt["scope"]; callId: string; sessionId: string; policyVersion: string;
    credentialFingerprint: string; businessId: string }>): boolean {
    const c = this.#config;
    return !this.#closed && !c.signal.aborted && input.callId === c.receipt.callId && isDeepStrictEqual(input.scope, c.receipt.scope) &&
      input.sessionId === c.sessionId && input.policyVersion === c.policyVersion && input.businessId === c.requests.businessId &&
      input.credentialFingerprint === clinikoCredentialFingerprint(c.requests.apiKey);
  }
  matchesCall(receipt: AdmissionReceipt, sessionId: string, policyVersion: string): boolean {
    const c = this.#config;
    return !this.#closed && !c.signal.aborted && receipt.lifecycle !== "ended" && receipt.admission.direction !== "outbound" &&
      receipt.callId === c.receipt.callId && isDeepStrictEqual(receipt.scope, c.receipt.scope) &&
      isDeepStrictEqual(receipt.admission, c.receipt.admission) && sessionId === c.sessionId && policyVersion === c.policyVersion;
  }
  async read(verification: CallerVerificationSession, external: AbortSignal): Promise<Result<MissedCallContext, Failure>> {
    const selected = await this.#resolve(verification, "appointments.read", external);
    if (!selected.ok) return selected;
    this.#originalDigest = selected.value.originalDigest;
    this.#purpose = selected.value.context.purpose;
    return ok(selected.value.context);
  }
  async inspectAppointment(verification: CallerVerificationSession, operation: "appointments.cancel" | "appointments.reschedule",
    external: AbortSignal): Promise<Result<OutboundTargetObservation, Failure>> {
    if (!this.#originalDigest || !this.current()) return unavailable();
    const selected = await this.#resolve(verification, operation, external);
    return selected.ok && selected.value.originalDigest === this.#originalDigest && selected.value.target
      ? ok(selected.value.target) : unavailable();
  }
  async #resolve(verification: CallerVerificationSession, operation: PatientOperation, external: AbortSignal): Promise<Result<Selection, Failure>> {
    const c = this.#config, r = c.requests;
    if (this.#closed || this.#busy || c.signal.aborted || !(external instanceof AbortSignal) || external.aborted ||
        !(verification instanceof CallerVerificationSession) || !verification.proof.matchesCall(c.receipt.scope, c.receipt.callId, c.sessionId, c.policyVersion)) return unavailable();
    if (!verification.matchesClinikoAccount(clinikoCredentialFingerprint(r.apiKey), r.rateBudget)) return unavailable();
    this.#busy = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([external, c.signal, controller.signal, AbortSignal.timeout(r.deadlineMs ?? 15_000)]);
    const grants: Query[] = [], targetGrants: Parameters<OutboundTargetAuthority["current"]>[0][] = [];
    let patient: VerifiedPatient | undefined;
    const now = () => {
      const at = r.clock ? r.clock() : new Date().toISOString();
      if (this.#closed || signal.aborted || outboundNativeInstant(at) !== at || at < this.#last || at < c.inbound.receivedAt) {
        if (outboundNativeInstant(at) !== at || at < this.#last) this.#closed = true;
        throw Error("Incoming context unavailable");
      }
      this.#last = at; return at;
    };
    const current = () => {
      now();
      if (patient && !verification.proof.ownsLiveReference(patient.verificationRef, operation, now()) ||
          grants.some(q => c.authority.current(q, signal) !== true) ||
          targetGrants.some(q => c.target?.authority.current(q, signal) !== true)) throw Error("Incoming context unavailable");
    };
    const verify = async () => {
      current();
      const found = await awaitUntilAbort(verification.verifiedSubject(operation, signal), signal);
      if (!found || patient && !isDeepStrictEqual(found, patient) || !isDeepStrictEqual(found.scope, c.receipt.scope)) throw Error("Incoming context unavailable");
      patient = found; current();
    };
    // A permission callback is a non-disclosing gate. Keep its actual owner
    // current without rereading native contact for each selection/body grant.
    // Every protected HTTP dispatch and the returned result still revalidate
    // the independently verified subject, including native contact/permission.
    const owned = async () => {
      current();
      if (!patient || await awaitUntilAbort(verification.ownsCurrentProof(operation, patient.verificationRef, signal), signal) !== true)
        throw Error("Incoming context unavailable");
      current();
    };
    const protectedPort: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw Error("Incoming context unavailable");
      await verify(); current();
      if (init?.signal?.aborted) throw Error("Incoming context unavailable");
      return (c.fetchPort ?? fetch)(input, init);
    };
    const permit = async <Q extends Query>(q: Q, allows: (query: Q, signal: AbortSignal) => Promise<boolean>) => {
      freezeQuery(q);
      current(); await owned();
      if (c.authority.current(q, signal) !== true || await awaitUntilAbort(allows(q, signal), signal) !== true) throw Error("Incoming context unavailable");
      grants.push(q); current();
    };
    try {
      // Route this operation using its already-issued private reference. The
      // protected transport below verifies the native subject immediately
      // before EVERY dispatch, and verify() checks it again before disclosure.
      // An extra native contact GET here precedes no protected IO and would
      // repeat the first dispatch's check.
      const grant = await awaitUntilAbort(verification.ownedGrant(operation, signal), signal);
      if (!grant) return unavailable();
      const routing = await awaitUntilAbort(verification.proof.currentReference(c.receipt.scope, grant.verificationRef, operation, now()), signal);
      if (!routing?.ok || !isDeepStrictEqual(routing.value.scope, c.receipt.scope)) return unavailable();
      patient = routing.value; current();
      const binding: CallBinding = Object.freeze({ callId: c.receipt.callId, sessionId: c.sessionId, policyVersion: c.policyVersion,
        receivedAt: c.inbound.receivedAt, patientId: patient!.patientRef, patientOperation: operation,
        readPolicyDigest: c.readPolicyDigest, lookBackMs: c.lookBackMs, selection: outboundRecordSelection(r) });
      const history: IncomingCallHistoryQuery = Object.freeze({ ...binding, operation: "readIncomingCallHistory", includeArchived: true, includeClosed: true,
        attemptSelection: outboundLaunchRecordSelection(c.attempts), observationTypeId: c.observations.outboundTerminalObservationRecallTypeId,
        ...(c.unanswered ? { unansweredObservationTypeId: c.unanswered.records.outboundUnansweredObservationRecallTypeId } : {}) });
      const wait = async <T>(task: Promise<T>): Promise<T> => {
        const result = await awaitUntilAbort(task, signal); if (result === undefined) throw Error("Incoming context unavailable");
        current(); return result;
      };
      const scan = () => PatientRecallSnapshot.read({ base: this.#base, patientId: patient!.patientRef,
        typeIds: [r.outboundRecallTypeId, c.attempts.outboundAttemptRecallTypeId, c.observations.outboundTerminalObservationRecallTypeId,
          ...(c.unanswered ? [c.unanswered.records.outboundUnansweredObservationRecallTypeId] : [])],
        apiKey: r.apiKey, contactEmail: r.contactEmail, rateBudget: r.rateBudget },
        { signal, now, current, permit: () => permit(history, c.authority.allowsHistoryRead), wait }, protectedPort);
      const first = await scan(); current();
      const requests = new Map<string, { row: AccountRecallRow; request: ReturnType<typeof decodeOutboundRecipientRequest> }>();
      const attempts = new Map<string, { row: AccountRecallRow; attempt: ReturnType<typeof decodeOutboundLaunchAttempt> }>();
      const observations: { row: AccountRecallRow; observation: Notification }[] = [];
      for (const row of first.rows) {
        const ref = `cliniko:recall:${row.id}`;
        if (row.typeId === r.outboundRecallTypeId) {
          const request = decodeOutboundRecipientRequest(row.notes); if (!request.ok || request.value.patientId !== patient!.patientRef) return unavailable();
          requests.set(ref, { row, request });
        } else if (row.typeId === c.attempts.outboundAttemptRecallTypeId) {
          const attempt = decodeOutboundLaunchAttempt(row.notes); if (!attempt.ok || attempt.value.patientId !== patient!.patientRef) return unavailable();
          attempts.set(ref, { row, attempt });
        } else {
          const completed = row.typeId === c.observations.outboundTerminalObservationRecallTypeId;
          const observation = completed ? decodeTwilioOutboundTerminalObservation(row.notes) : decodeTwilioOutboundUnansweredObservation(row.notes);
          if (!observation.ok || (observation.value.status === "completed" ? !c.authentication.verify(observation.value)
            : !c.unanswered?.authentication.verify(observation.value)) || observation.value.patientId !== patient!.patientRef || observation.value.accountSid !== c.accountSid) return unavailable();
          observations.push({ row, observation: observation.value });
        }
      }
      // Notification receipt orders the prior call against the return call.
      // Native insertion may legitimately finish while the return call is live.
      const cutoff = Date.parse(c.inbound.receivedAt) - c.lookBackMs;
      const eligible = observations.filter(({ observation: o }) => Date.parse(o.receivedAt) >= cutoff && o.receivedAt <= c.inbound.receivedAt);
      if (eligible.length !== 1) return unavailable();
      const selected = eligible[0]!, o = selected.observation, origin = attempts.get(o.original.recallRef);
      if (!origin?.attempt.ok || outboundLaunchAttemptDigest(origin.attempt.value) !== o.original.digest) return unavailable();
      const attempt = origin.attempt.value, requestSource = requests.get(attempt.requestRecallRef);
      if (!requestSource?.request.ok || !outboundAttemptMatchesRequest(attempt, requestSource.request.value, attempt.requestRecallRef) ||
          !isDeepStrictEqual(attempt.scope, r.scope) || attempt.businessId !== r.businessId ||
          attempt.credentialFingerprint !== binding.selection.credentialFingerprint || !isDeepStrictEqual(attempt.provider, c.authentication.binding()) ||
          o.original.actionRef !== attempt.actionRef || o.number !== requestSource.request.value.recipient.number ||
          attempt.attemptedAt > o.receivedAt || Date.parse(attempt.attemptedAt) < cutoff ||
          o.recordedAt > now() || o.credentialFingerprint !== binding.selection.credentialFingerprint || !isDeepStrictEqual(o.scope, r.scope)) return unavailable();
      // Another possible attempt in the clinic-approved window can supersede
      // this call even when its authenticated notification has not been retained.
      if ([...attempts.values()].some(({ attempt: a }) => a.ok && a.value.actionRef !== attempt.actionRef &&
          Date.parse(a.value.attemptedAt) >= cutoff && a.value.attemptedAt <= c.inbound.receivedAt)) return unavailable();
      const readAuthority = <Q extends NativeQuery>(allows: (q: Q, signal: AbortSignal) => Promise<boolean>) => ({
        allows: async (q: Q) => { await permit(q, allows); return true; },
        current: (q: Q, stop: AbortSignal) => { try { current(); return !stop.aborted && c.authority.current(q, signal) === true; } catch { return false; } },
      });
      const recipientReader = ClinikoOutboundRecipientRecords.createReadOnly(r, readAuthority(c.authority.allowsRequestRead), protectedPort);
      const attemptReader = ClinikoOutboundLaunchRecords.createReadOnly(c.attempts, readAuthority(c.authority.allowsAttemptRead), protectedPort);
      const observationReader = o.status === "completed"
        ? ClinikoTwilioOutboundTerminalObservationRecords.createReadOnly(c.observations, c.authentication, readAuthority(c.authority.allowsObservationRead), protectedPort)
        : c.unanswered && ClinikoTwilioOutboundUnansweredObservationRecords.createReadOnly(c.unanswered.records, c.unanswered.authentication,
          readAuthority(c.authority.allowsObservationRead), protectedPort);
      if (!recipientReader.ok || !attemptReader.ok || !observationReader?.ok) return unavailable();
      const request = await recipientReader.value.readRequest({ recallRef: attempt.requestRecallRef, actionRef: attempt.requestActionRef, patientId: patient!.patientRef }, signal, first);
      const original = await attemptReader.value.readPossibleAttempt({ recallRef: o.original.recallRef, actionRef: attempt.actionRef, patientId: patient!.patientRef }, signal, first);
      const observation = await observationReader.value.readObservation({ recallRef: `cliniko:recall:${selected.row.id}`, actionRef: o.actionRef, patientId: patient!.patientRef }, signal, first);
      if (!request.ok || !original.ok || !observation.ok || !exactRow(request.value, requestSource.row) || !exactRow(original.value, origin.row) ||
          !exactRow(observation.value, selected.row) || !isDeepStrictEqual(request.value.request, requestSource.request.value) ||
          !isDeepStrictEqual(original.value.attempt, attempt) || !isDeepStrictEqual(observation.value.record, o)) return unavailable();
      const purpose: IncomingCallPurposeQuery = Object.freeze({ ...binding, operation: "approveIncomingCallContext", request: request.value,
        original: original.value, observation: observation.value });
      await permit(purpose, c.authority.allowsPurpose);
      let target: OutboundTargetObservation | undefined;
      if (request.value.request.purpose === "sickDay") {
        if (!c.target) return unavailable();
        const reader = ClinikoOutboundAppointmentTarget.create({ requests: r, appointmentPolicyDigest: c.target.appointmentPolicyDigest }, {
          allows: async (q, stop) => { current(); await owned();
            if (await c.target!.authority.allows(q, stop) !== true || c.target!.authority.current(q, stop) !== true) return false;
            targetGrants.push(q); current(); return true; },
          current: (q, stop) => { try { current(); return !stop.aborted && c.target!.authority.current(q, stop) === true; } catch { return false; } },
        }, protectedPort);
        if (!reader.ok) return unavailable();
        const inspected = await reader.value.readForRequest(request.value.request, signal);
        if (!inspected.ok) return unavailable(); target = inspected.value;
      }
      const final = await scan(); if (!first.sameVersion(final)) return unavailable();
      await verify(); current();
      if (this.#originalDigest && this.#originalDigest !== o.original.digest) return unavailable();
      // Native grants outlive this bounded read under the actual call lifetime,
      // not its temporary request signal. Patient proof is separately renewed
      // and revalidated for each later protected operation.
      const retained = [...grants], retainedTargets = [...targetGrants];
      this.#retained = () => retained.every(q => c.authority.current(q, c.signal) === true) &&
        retainedTargets.every(q => c.target?.authority.current(q, c.signal) === true);
      return ok({ context: Object.freeze({ scope: c.receipt.scope, callId: c.receipt.callId, sessionId: c.sessionId, policyVersion: c.policyVersion,
        checkedAt: now(), purpose: request.value.request.purpose }), originalDigest: o.original.digest, ...(target ? { target } : {}) });
    } catch { return unavailable(); }
    finally { controller.abort(); this.#busy = false; }
  }
  dispose(): void { this.#closed = true; }
}
