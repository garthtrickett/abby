import { randomBytes } from "node:crypto";
import { ClinikoAppointmentReader } from "../cliniko/appointments.ts";
import { boundedClinikoJson } from "../cliniko/bounded-json.ts";
import { claimClinikoBudget, ClinikoReadBudget, clinikoCredentialFingerprint, isClinikoRequestBudget, observeCliniko429 } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { AppointmentHost, HostReadFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { AppointmentRead, AppointmentReadFailure, LocationScope, Result } from "../core/model.ts";
import { normalizeEmailAddress } from "../shared/email-address.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import type { AppointmentChangeAuthority, AppointmentChangeAuthorityEvidence } from "./appointment-change-authority.ts";
import { OwnerFileReschedulingPolicy } from "./owner-file-rescheduling-policy.ts";
import { OwnerFileCancellationPolicy } from "./owner-file-cancellation-policy.ts";
import { TransientPatientProofHost } from "./transient-patient-proof.ts";

export type ClinikoAppointmentSelectionConfig = Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string; apiKey: string;
  contactEmail: string; businessId: string; proof: TransientPatientProofHost; policy: OwnerFileCancellationPolicy | OwnerFileReschedulingPolicy;
  rateBudget?: ClinikoRequestBudget; clock?: () => string; timeoutMs?: number }>;
type Config = ClinikoAppointmentSelectionConfig;
export type SelectedAppointmentEvidence = Omit<AppointmentChangeAuthorityEvidence, "kind" | "offer" | "cancellationReason"> &
  Readonly<{ cancellationReason?: 10 | 20 | 30 | 40 | 50 | 60 }>;

type Selection = Readonly<{ appointmentId: string; patientId: string; verificationRef: string;
  startsAt: string; endsAt: string; timeZone: string; expiresAt: string }>;
const ref = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9:_-]{1,256}$/.test(value);
function row(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const parsed = Date.parse(value), day = Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(parsed) && Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10) &&
    Number(value.slice(11, 13)) < 24 ? parsed : undefined;
}

/** Protected call-scoped selection plus exact fresh provider target and public clinic fee policy.
 * It does not send, issue proof, establish patient permission or activate any capability. */
export class ClinikoAppointmentSelection implements AppointmentHost {
  readonly #config: Config;
  readonly #base: string;
  readonly #budget: ClinikoRequestBudget;
  readonly #fetch: typeof fetch;
  readonly #lifetime = new AbortController();
  readonly #targets = new Map<string, Selection>();
  #choices: Readonly<{ snapshot: AppointmentRead; from: string; to: string }> | undefined;
  #listing = 0;
  clearSelection(): void { ++this.#listing; this.#targets.clear(); this.#choices = undefined; }
  private constructor(config: Config, shard: string, fetchPort: typeof fetch) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    this.#base = `https://api.${shard}.cliniko.com/v1`; this.#budget = config.rateBudget ?? new ClinikoReadBudget(); this.#fetch = fetchPort;
  }
  static create(config: Config, fetchPort: typeof fetch = fetch): Result<ClinikoAppointmentSelection, Readonly<{ kind: "invalidConfig" }>> {
    try {
      const shard = config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1], binding = config.policy.binding();
      if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || /[\u0000-\u001f\u007f]/.test(config.apiKey) ||
          !normalizeEmailAddress(config.contactEmail) || !sameScope(binding.scope, config.scope) ||
          ![config.callId, config.sessionId, config.policyVersion].every(ref) || !validClinikoId(config.businessId) ||
          binding.businessId !== config.businessId || binding.policyVersion !== config.policyVersion ||
          binding.credentialFingerprint !== clinikoCredentialFingerprint(config.apiKey) ||
          !(config.proof instanceof TransientPatientProofHost) ||
          !config.proof.matchesCall(config.scope, config.callId, config.sessionId, config.policyVersion) ||
          !(config.policy instanceof OwnerFileCancellationPolicy || config.policy instanceof OwnerFileReschedulingPolicy) ||
          typeof fetchPort !== "function" || (config.clock !== undefined && typeof config.clock !== "function") ||
          (config.rateBudget !== undefined && !isClinikoRequestBudget(config.rateBudget)) ||
          (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 20_000))) return err({ kind: "invalidConfig" });
      return ok(new ClinikoAppointmentSelection(config, shard, fetchPort));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #operation(): "appointments.cancel" | "appointments.reschedule" {
    return this.#config.policy instanceof OwnerFileCancellationPolicy ? "appointments.cancel" : "appointments.reschedule";
  }
  #now(): string { return (this.#config.clock ?? (() => new Date().toISOString()))(); }
  #currentTime(now: string): boolean {
    try {
      const supplied = instant(now), actual = instant(this.#now());
      return supplied !== undefined && actual !== undefined && Math.abs(actual - supplied) <= 30_000;
    } catch { return false; }
  }
  async #bounded<Value>(run: (signal: AbortSignal) => Promise<Value>, external?: AbortSignal): Promise<Value | undefined> {
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.#lifetime.signal, ...(external ? [external] : [])]);
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 15_000);
    let onAbort: () => void = () => undefined;
    const stopped = new Promise<undefined>(resolve => { onAbort = () => resolve(undefined); signal.addEventListener("abort", onAbort); if (signal.aborted) resolve(undefined); });
    try { return await Promise.race([Promise.resolve().then(() => signal.aborted ? undefined : run(signal)), stopped]); }
    catch { return undefined; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); controller.abort(); }
  }

  async list(scope: LocationScope, verificationRef: string, from: string, to: string, now: string, external?: AbortSignal): Promise<Result<AppointmentRead, AppointmentReadFailure>> {
    if (!sameScope(scope, this.#config.scope) || !ref(verificationRef) || !this.#currentTime(now) || this.#lifetime.signal.aborted) return err({ kind: "invalidProof" });
    const epoch = ++this.#listing; this.#targets.clear(); this.#choices = undefined;
    const found = await this.#bounded(async signal => {
      const policy = await this.#config.policy.current(scope);
      if (!policy.ok || signal.aborted) return undefined;
      const reader = ClinikoAppointmentReader.create({ scope, apiKey: this.#config.apiKey, contactEmail: this.#config.contactEmail,
        businessId: this.#config.businessId, rateBudget: this.#budget }, {
        verifyPatient: (bound, proof, at) => this.#config.proof.verifyOperation(bound, proof, this.#operation(), at, signal),
      }, async (value, init) => {
        if (signal.aborted) throw new Error("appointment selection unavailable");
        return this.#fetch(value, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
      }, () => this.#now());
      if (!reader.ok) return undefined;
      const result = await reader.value.list(scope, verificationRef, from, to, now);
      if (!result.ok || signal.aborted || epoch !== this.#listing || result.value.timeZone !== policy.value.timeZone ||
          !this.#currentTime(now) || !(await this.#config.policy.current(scope)).ok) return undefined;
      const verified = await this.#config.proof.verifyOperation(scope, verificationRef, this.#operation(), this.#now(), signal);
      if (!verified.ok || signal.aborted || epoch !== this.#listing || verified.value.patientRef !== result.value.patientRef) return undefined;
      const appointments = [...result.value.appointments].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
      if (appointments.some(target => instant(target.startsAt) === undefined || instant(target.endsAt) === undefined || instant(target.endsAt)! <= instant(target.startsAt)!) ||
          new Set(appointments.map(target => instant(target.startsAt))).size !== appointments.length) return undefined;
      const targets = appointments.map(target => {
        const targetRef = randomBytes(24).toString("base64url");
        return { targetRef, selected: { appointmentId: target.appointmentRef, patientId: verified.value.patientRef, verificationRef,
          startsAt: target.startsAt, endsAt: target.endsAt, timeZone: result.value.timeZone, expiresAt: verified.value.expiresAt } };
      });
      if (signal.aborted || epoch !== this.#listing) return undefined;
      for (const { targetRef, selected } of targets) this.#targets.set(targetRef, selected);
      if (targets.length === 1) this.#targets.set("selected", targets[0]!.selected);
      const snapshot = { ...result.value, appointments: targets.map(({ targetRef, selected }) => ({ appointmentRef: targetRef,
        startsAt: selected.startsAt, endsAt: selected.endsAt })) };
      if (targets.length > 1) this.#choices = { snapshot, from, to };
      return snapshot;
    }, external);
    return found ? ok(found) : err({ kind: "unavailable" });
  }

  async select(scope: LocationScope, verificationRef: string, choice: 1 | 2 | 3, now: string, external?: AbortSignal):
    Promise<Result<Readonly<{ snapshot: AppointmentRead; from: string; to: string }>, AppointmentReadFailure>> {
    const prior = this.#choices; this.#choices = undefined;
    const epoch = ++this.#listing, signal = AbortSignal.any([this.#lifetime.signal, ...(external ? [external] : [])]);
    const selected = prior?.snapshot.appointments[choice - 1];
    if (!sameScope(scope, this.#config.scope) || ![1, 2, 3].includes(choice) || !prior || !selected ||
        prior.snapshot.verificationRef !== verificationRef || signal.aborted || !this.#currentTime(now) || Date.parse(now) >= Date.parse(prior.to)) return err({ kind: "notFound" });
    const fresh = await this.resolveTarget({ scope, callId: this.#config.callId, sessionId: this.#config.sessionId,
      policyVersion: this.#config.policyVersion, kind: this.#config.policy instanceof OwnerFileCancellationPolicy ? "cancel" : "reschedule", targetRef: selected.appointmentRef, verificationRef,
      patientId: prior.snapshot.patientRef, phase: "proposal", now, signal });
    if (!fresh.ok || signal.aborted || epoch !== this.#listing || this.#targets.get(selected.appointmentRef)?.verificationRef !== verificationRef) return err({ kind: "notFound" });
    this.#targets.set("selected", this.#targets.get(selected.appointmentRef)!);
    return ok({ snapshot: { ...prior.snapshot, observedAt: now, appointments: [selected] },
      from: new Date(Math.max(Date.parse(now), Date.parse(prior.from))).toISOString(), to: prior.to });
  }

  async #get(path: string, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    if (signal.aborted || await claimClinikoBudget(this.#budget) || signal.aborted) return undefined;
    const response = await this.#fetch(`${this.#base}${path}`, { method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`,
        "User-Agent": `Abby (${this.#config.contactEmail})` } });
    if (response.status === 429) await observeCliniko429(this.#budget, response.headers.get("X-RateLimit-Reset"));
    if (response.status !== 200 || signal.aborted) return undefined;
    const parsed = await boundedClinikoJson(response); return parsed.ok && !signal.aborted ? row(parsed.value) : undefined;
  }

  async resolveTarget(incoming: Omit<Parameters<AppointmentChangeAuthority["resolve"]>[0], "kind" | "offerRef"> & Readonly<{ kind: "cancel" | "reschedule" }>): Promise<Result<SelectedAppointmentEvidence, HostReadFailure>> {
    const query = { ...incoming, scope: { ...incoming.scope } };
    const config = this.#config, selected = this.#targets.get(query.targetRef);
    const denied = (): Result<SelectedAppointmentEvidence, HostReadFailure> => err({ kind: "unavailable", target: "appointment" });
    if (query.kind !== (config.policy instanceof OwnerFileCancellationPolicy ? "cancel" : "reschedule") || !(query.signal instanceof AbortSignal) || !sameScope(query.scope, config.scope) || query.callId !== config.callId ||
        query.sessionId !== config.sessionId || query.policyVersion !== config.policyVersion || !selected ||
        selected.patientId !== query.patientId || selected.verificationRef !== query.verificationRef ||
        !this.#currentTime(query.now) || (query.phase !== "proposal" && query.phase !== "commit")) return denied();
    const result = await this.#bounded(async signal => {
      const verified = await config.proof.verifyOperation(config.scope, query.verificationRef, this.#operation(), this.#now(), signal);
      if (!verified.ok || verified.value.patientRef !== selected.patientId || signal.aborted) return undefined;
      const policy = await config.policy.current(config.scope);
      if (!policy.ok || signal.aborted) return undefined;
      const business = await this.#get(`/businesses/${config.businessId}`, signal);
      if (!business || business.id !== config.businessId || business.archived_at !== null || business.time_zone_identifier !== selected.timeZone ||
          business.time_zone_identifier !== policy.value.timeZone || signal.aborted) return undefined;
      const appointment = await this.#get(`/individual_appointments/${selected.appointmentId}`, signal);
      const link = (name: string) => row(row(appointment?.[name])?.links)?.self;
      const linkedId = (name: string, collection: string): string | undefined => {
        const value = link(name), prefix = `${this.#base}/${collection}/`;
        return typeof value === "string" && value.startsWith(prefix) && validClinikoId(value.slice(prefix.length)) ? value.slice(prefix.length) : undefined;
      };
      const practitionerId = linkedId("practitioner", "practitioners"), appointmentTypeId = linkedId("appointment_type", "appointment_types");
      if (!appointment || appointment.id !== selected.appointmentId || appointment.archived_at !== null || appointment.deleted_at !== null ||
          appointment.cancelled_at !== null || link("patient") !== `${this.#base}/patients/${selected.patientId}` ||
          link("business") !== `${this.#base}/businesses/${config.businessId}` || !practitionerId || !appointmentTypeId ||
          instant(appointment.starts_at) !== instant(selected.startsAt) || instant(appointment.ends_at) !== instant(selected.endsAt) ||
          !this.#currentTime(query.now) || Date.parse(selected.expiresAt) <= Date.parse(this.#now()) || signal.aborted) return undefined;
      const terms = OwnerFileReschedulingPolicy.termsFor(policy.value, selected.startsAt, this.#now());
      const freshPolicy = await config.policy.current(config.scope);
      const freshProof = await config.proof.verifyOperation(config.scope, query.verificationRef, this.#operation(), this.#now(), signal);
      if (!terms || !freshPolicy.ok || JSON.stringify(freshPolicy.value) !== JSON.stringify(policy.value) || !freshProof.ok || freshProof.value.patientRef !== selected.patientId || signal.aborted ||
          this.#targets.get(query.targetRef) !== selected || !this.#currentTime(query.now) ||
          JSON.stringify(terms) !== JSON.stringify(OwnerFileReschedulingPolicy.termsFor(freshPolicy.value, selected.startsAt, this.#now()))) return undefined;
      return { scope: config.scope, callId: config.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
        patientId: selected.patientId, targetRef: query.targetRef, businessId: config.businessId, credentialFingerprint: policy.value.credentialFingerprint,
        practitionerId, appointmentTypeId, terms,
        ...("cancellationReason" in policy.value ? { cancellationReason: policy.value.cancellationReason } : {}),
        target: { scope: config.scope, appointmentRef: selected.appointmentId, patientRef: selected.patientId,
          startsAt: selected.startsAt, endsAt: selected.endsAt, timeZone: selected.timeZone } };
    }, query.signal);
    return result ? ok(result) : denied();
  }
  dispose(): void { this.#listing++; this.#lifetime.abort(); this.#targets.clear(); this.#choices = undefined; }
}
