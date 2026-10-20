import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, ProviderCallKey, Result } from "../core/model.ts";
import { callIdFor } from "../voice/admission.ts";
import type { OutboundOriginalSend } from "../voice/outbound-original-send.ts";
import type { CallerCandidateLookup } from "../voice/caller-candidates.ts";
import { validCallerCandidates } from "../voice/caller-candidates.ts";
import { outboundAttemptMatchesRequest, encodeOutboundLaunchAttempt, decodeOutboundLaunchAttempt, outboundLaunchAttemptDigest } from "../cliniko/outbound-launch-attempt.ts";
import { ClinikoOutboundRecipientRecords } from "../cliniko/outbound-recipient-records.ts";
import type { OutboundRecordConfig, OutboundRecordReadAuthority, OutboundRecipientRecord } from "../cliniko/outbound-recipient-records.ts";
import { outboundRecordSelection } from "../cliniko/internal/outbound-record-context.ts";
import { inheritClinikoRequestCost } from "../cliniko/request-cost.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { PatientOperation } from "./transient-patient-proof.ts";
import { ClinikoOutboundAppointmentTarget } from "../cliniko/outbound-appointment-target.ts";
import type { OutboundTargetAuthority, OutboundTargetObservation } from "../cliniko/outbound-appointment-target.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";

export type OutboundClinicalContextQuery = Readonly<{
  operation: "approveOriginalClinicalContext";
  selection: ReturnType<typeof outboundRecordSelection>;
  key: ProviderCallKey; clinicNumber: string;
  original: OutboundOriginalSend; originalDigest: string;
  /** Stronger decoded source grant, retained alongside the initial grant. */
  record?: OutboundRecipientRecord;
}>;
export type OutboundClinicalContextAuthority = Readonly<{
  allows(query: OutboundClinicalContextQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundClinicalContextQuery): boolean;
}>;
type Config = Readonly<{
  original: OutboundOriginalSend; key: ProviderCallKey; clinicNumber: string;
  requests: OutboundRecordConfig; records: OutboundRecordReadAuthority;
  authority: OutboundClinicalContextAuthority;
  /** Exact original sick-day target; a staff launch observation is not a
   * patient/action grant. Every protected use rereads its full native version. */
  target?: Readonly<{ appointmentPolicyDigest: string; authority: OutboundTargetAuthority }>;
  signal: AbortSignal; fetchPort?: typeof fetch;
}>;
type Failure = Readonly<{ kind: "outboundClinicalContextUnavailable" }>;
const unavailable = (): Result<never, Failure> => err({ kind: "outboundClinicalContextUnavailable" });
const phone = (v: unknown): v is string => typeof v === "string" && /^\+[1-9][0-9]{7,14}$/.test(v);
const ref = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

/** Private original routing constraint, never patient proof. This object has no
 * SQL/serialization/model port. A clinic host must explicitly select it after
 * authenticating the provider's original context. Independent registered-channel
 * verification and current patient/action permission remain mandatory. */
export class ClinikoOutboundClinicalContext {
  readonly #query: OutboundClinicalContextQuery;
  readonly #initial: OutboundClinicalContextQuery;
  readonly #authority: OutboundClinicalContextAuthority;
  readonly #nativeCurrent: () => boolean;
  readonly #signal: AbortSignal;
  readonly #clock: () => string;
  readonly #capturedAt: string;
  readonly #target: ClinikoOutboundAppointmentTarget | undefined;
  readonly #budget: ClinikoRequestBudget;
  readonly #refresh: (signal: AbortSignal) => Promise<boolean>;
  #last: string;
  #closed = false;
  private constructor(query: OutboundClinicalContextQuery, initial: OutboundClinicalContextQuery,
    authority: OutboundClinicalContextAuthority, nativeCurrent: () => boolean, signal: AbortSignal, clock: () => string, at: string,
    budget: ClinikoRequestBudget, refresh: (signal: AbortSignal) => Promise<boolean>, target?: ClinikoOutboundAppointmentTarget) {
    this.#query = query; this.#initial = initial; this.#authority = authority;
    this.#nativeCurrent = nativeCurrent; this.#signal = signal; this.#clock = clock;
    this.#capturedAt = at; this.#last = at;
    this.#target = target;
    this.#budget = budget;
    this.#refresh = refresh;
  }
  static async capture(incoming: Config): Promise<Result<ClinikoOutboundClinicalContext, Failure>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new AbortController();
    try {
      if (!(incoming.signal instanceof AbortSignal) || incoming.signal.aborted || !phone(incoming.clinicNumber) ||
          !incoming.key || Object.keys(incoming.key).sort().join(",") !== "accountRef,providerCallRef" || !Object.values(incoming.key).every(ref) ||
          !incoming.original || Object.keys(incoming.original).sort().join(",") !== "attempt,recallRef" ||
          !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(incoming.original.recallRef)) return unavailable();
      const requests = Object.freeze({ ...incoming.requests, scope: Object.freeze({ ...incoming.requests.scope }) });
      const fetchPort = incoming.fetchPort;
      const targetProvision = incoming.target ? Object.freeze({ appointmentPolicyDigest: incoming.target.appointmentPolicyDigest,
        authority: Object.freeze({ allows: incoming.target.authority.allows.bind(incoming.target.authority), current: incoming.target.authority.current.bind(incoming.target.authority) }) }) : undefined;
      const encoded = encodeOutboundLaunchAttempt(incoming.original.attempt);
      if (!encoded.ok) return unavailable();
      const decoded = decodeOutboundLaunchAttempt(encoded.value);
      if (!decoded.ok) return unavailable();
      const original = Object.freeze({ recallRef: incoming.original.recallRef, attempt: decoded.value });
      const selection = outboundRecordSelection(requests), a = original.attempt;
      if (!isDeepStrictEqual(a.scope, selection.scope) || a.businessId !== selection.businessId || a.credentialFingerprint !== selection.credentialFingerprint)
        return unavailable();
      const authority = Object.freeze({ allows: incoming.authority.allows.bind(incoming.authority), current: incoming.authority.current.bind(incoming.authority) });
      const recordGrants: Parameters<OutboundRecordReadAuthority["current"]>[0][] = [];
      const permits = incoming.records.allows.bind(incoming.records), current = incoming.records.current.bind(incoming.records);
      const ownerLifetime = incoming.signal;
      const signal = AbortSignal.any([ownerLifetime, bounded.signal]);
      timer = setTimeout(() => bounded.abort(), requests.deadlineMs ?? 15_000);
      const clock = requests.clock?.bind(requests) ?? (() => new Date().toISOString());
      const at = clock(); if (!instant(at) || at < a.attemptedAt) return unavailable();
      let last = at;
      const active = () => {
        const now = clock();
        if (signal.aborted || !instant(now) || now < last || Date.parse(now) - Date.parse(at) > (requests.deadlineMs ?? 15_000)) return false;
        last = now; return true;
      };
      const initial: OutboundClinicalContextQuery = Object.freeze({ operation: "approveOriginalClinicalContext", selection,
        key: Object.freeze({ ...incoming.key }), clinicNumber: incoming.clinicNumber, original, originalDigest: outboundLaunchAttemptDigest(a)! });
      const queries = [initial];
      const grants = () => active() && queries.every(q => authority.current(q) === true) && recordGrants.every(q => current(q, ownerLifetime) === true);
      const permit = async (query: OutboundClinicalContextQuery) => {
        if (!grants() || authority.current(query) !== true) return false;
        const allowed = await awaitUntilAbort(Promise.resolve().then(() => authority.allows(query, signal)), signal);
        if (allowed !== true || !grants() || authority.current(query) !== true) return false;
        if (!queries.includes(query)) queries.push(query);
        return true;
      };
      if (!await permit(initial)) return unavailable();
      const records = ClinikoOutboundRecipientRecords.createReadOnly({ ...requests, clock }, {
        allows: async (query, abort) => {
          if (!grants()) return false;
          const allowed = await permits(query, abort);
          if (allowed !== true || !grants() || current(query, ownerLifetime) !== true) return false;
          recordGrants.push(query); return true;
        },
        current: (query, abort) => !abort.aborted && grants() && current(query, ownerLifetime) === true,
      }, fetchPort);
      if (!records.ok) return unavailable();
      const binding = Object.freeze({ recallRef: a.requestRecallRef, actionRef: a.requestActionRef, patientId: a.patientId });
      const first = await awaitUntilAbort(records.value.readRequest(binding, signal), signal);
      if (!first?.ok || !grants() || !outboundAttemptMatchesRequest(a, first.value.request, first.value.recallRef)) return unavailable();
      const query: OutboundClinicalContextQuery = Object.freeze({ ...initial, record: first.value });
      if (!await permit(query)) return unavailable();
      // A second exact read brackets the decoded clinical-purpose approval.
      const final = await awaitUntilAbort(records.value.readRequest(binding, signal), signal);
      if (!final?.ok || !isDeepStrictEqual(final.value, first.value) || !grants()) return unavailable();
      let timeRetired = false;
      const purposeCurrent = () => {
        if (timeRetired || ownerLifetime.aborted) return false;
        const now = clock();
        if (!instant(now) || now < last || Date.parse(now) - Date.parse(at) >= 300_000) { timeRetired = true; return false; }
        last = now;
        return queries.every(q => authority.current(q) === true) && recordGrants.every(q => current(q, ownerLifetime) === true);
      };
      const targetGrants: Parameters<OutboundTargetAuthority["current"]>[0][] = [];
      let target: ClinikoOutboundAppointmentTarget | undefined;
      let targetCurrent = () => true;
      if (first.value.request.purpose === "sickDay") {
        if (!targetProvision) return unavailable();
        const allows = targetProvision.authority.allows, currentTarget = targetProvision.authority.current;
        targetCurrent = () => targetGrants.every(q => currentTarget(q, ownerLifetime) === true);
        const selected = ClinikoOutboundAppointmentTarget.create({ requests: { ...requests, clock },
          appointmentPolicyDigest: targetProvision.appointmentPolicyDigest }, {
          allows: async (q, abort) => {
            if (!purposeCurrent() || !targetCurrent()) return false;
            const allowed = await allows(q, abort);
            if (allowed !== true || abort.aborted || !purposeCurrent() || currentTarget(q, ownerLifetime) !== true || !targetCurrent()) return false;
            targetGrants.push(q); return true;
          }, current: (q, abort) => !abort.aborted && purposeCurrent() && targetCurrent() && currentTarget(q, ownerLifetime) === true,
        }, fetchPort);
        if (!selected.ok) return unavailable();
        target = selected.value;
      } else if (targetProvision !== undefined) return unavailable();
      const nativeCurrent = () => purposeCurrent() && targetCurrent();
      const refresh = async (signal: AbortSignal): Promise<boolean> => {
        if (signal.aborted || !nativeCurrent()) return false;
        const fresh = ClinikoOutboundRecipientRecords.createReadOnly({ ...requests, clock }, {
          allows: async (q, abort) => {
            if (!nativeCurrent()) return false;
            const allowed = await permits(q, abort);
            if (allowed !== true || abort.aborted || !nativeCurrent() || current(q, ownerLifetime) !== true) return false;
            recordGrants.push(q); return true;
          }, current: (q, abort) => !abort.aborted && nativeCurrent() && current(q, ownerLifetime) === true,
        }, fetchPort);
        if (!fresh.ok) return false;
        const read = await fresh.value.readRequest(binding, signal);
        return read.ok && !signal.aborted && nativeCurrent() && isDeepStrictEqual(read.value, first.value);
      };
      return ok(new ClinikoOutboundClinicalContext(query, initial, authority, nativeCurrent, ownerLifetime, clock, at, requests.rateBudget, refresh, target));
    } catch { return unavailable(); }
    finally { if (timer !== undefined) clearTimeout(timer); bounded.abort(); }
  }
  current(operation: PatientOperation): boolean {
    try {
      if (this.#closed || this.#signal.aborted) return false;
      const now = this.#clock(), request = this.#query.record!.request;
      // Once observed expired or with invalid/backwards time, this private
      // context cannot regain lifetime when the clock later recovers.
      if (!instant(now) || now < this.#last || Date.parse(now) - Date.parse(this.#capturedAt) >= 300_000) {
        this.#closed = true; return false;
      }
      this.#last = now;
      return (request.purpose === "followUp" ? operation === "appointments.book" : ["appointments.reschedule", "appointments.cancel"].includes(operation)) &&
        this.#authority.current(this.#initial) === true && this.#authority.current(this.#query) === true && this.#nativeCurrent();
    } catch { this.#closed = true; return false; }
  }

  matchesAdmission(receipt: AdmissionReceipt): boolean {
    const q = this.#query;
    return receipt.lifecycle !== "ended" && receipt.callId === callIdFor(q.key) && isDeepStrictEqual(receipt.scope, q.selection.scope) &&
      receipt.admission.direction === "outbound" && receipt.admission.clinicNumber === q.clinicNumber && isDeepStrictEqual(receipt.admission.key, q.key);
  }
  /** Private verifier wiring only. This selects a clue, never a verified subject. */
  verificationBinding() {
    const q = this.#query;
    return Object.freeze({ callId: callIdFor(q.key), scope: q.selection.scope, credentialFingerprint: q.selection.credentialFingerprint,
      businessId: q.selection.businessId, number: q.record!.request.recipient.number, patientId: q.original.attempt.patientId });
  }
  matchesWorkflow(input: Readonly<{ scope: AdmissionReceipt["scope"]; callId: string; credentialFingerprint: string; businessId: string }>): boolean {
    const q = this.#query;
    return !this.#closed && !this.#signal.aborted && input.callId === callIdFor(q.key) && isDeepStrictEqual(input.scope, q.selection.scope) &&
      input.credentialFingerprint === q.selection.credentialFingerprint && input.businessId === q.selection.businessId;
  }
  usesBudget(budget: ClinikoRequestBudget): boolean { return this.#budget === budget; }
  matchesContact(contact: ClinikoVerificationContactReader): boolean {
    return ClinikoVerificationContactReader.prototype.usesBudget.call(contact, this.#budget);
  }
  async refreshOriginal(operation: PatientOperation, external: AbortSignal): Promise<boolean> {
    try {
      if (!(external instanceof AbortSignal) || external.aborted || !this.current(operation)) return false;
      const signal = AbortSignal.any([external, this.#signal]);
      return await this.#refresh(signal) && !signal.aborted && this.current(operation);
    } catch { return false; }
  }
  async inspectAppointment(operation: "appointments.cancel" | "appointments.reschedule", external: AbortSignal):
    Promise<Result<OutboundTargetObservation, Failure>> {
    try {
      if (!(external instanceof AbortSignal) || external.aborted || !this.current(operation) || !this.#target) return unavailable();
      const signal = AbortSignal.any([external, this.#signal]);
      if (!await this.refreshOriginal(operation, signal)) return unavailable();
      const found = await this.#target.readForRequest(this.#query.record!.request, signal);
      return found.ok && !signal.aborted && this.current(operation) ? found : unavailable();
    } catch { return unavailable(); }
  }
  constrainLookup(lookup: CallerCandidateLookup, operation: PatientOperation): CallerCandidateLookup {
    const q = this.#query, patientId = q.original.attempt.patientId, number = q.record!.request.recipient.number;
    const candidates = lookup.candidates.bind(lookup);
    return Object.freeze({ candidates: inheritClinikoRequestCost(async (scope: Parameters<CallerCandidateLookup["candidates"]>[0], presented: string, signal?: AbortSignal) => {
      if (!this.current(operation) || signal?.aborted || !isDeepStrictEqual(scope, q.selection.scope) || presented !== number)
        return ok({ kind: "none" as const, candidateIds: [] });
      const result = await candidates(scope, presented, signal);
      return this.current(operation) && !signal?.aborted && result.ok && validCallerCandidates(result.value) &&
        result.value.kind === "one" && result.value.candidateIds.length === 1 && result.value.candidateIds[0] === patientId
        ? result : ok({ kind: "none" as const, candidateIds: [] });
    }, lookup.candidates) });
  }
  dispose(): void { this.#closed = true; }
}
