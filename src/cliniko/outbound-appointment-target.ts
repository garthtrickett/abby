import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes, OwnedBodyError } from "../shared/owned-body-bytes.ts";
import { claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import { outboundConfigShard, outboundRecordSelection, outboundNativeId, outboundNativeInstant } from "./internal/outbound-record-context.ts";
import type { OutboundRecordConfig, OutboundRecordSelection } from "./internal/outbound-record-context.ts";
import { encodeOutboundRecipientRequest, decodeOutboundRecipientRequest, outboundRecipientRequestDigest } from "./outbound-recipient-request.ts";
import type { OutboundRecipientRequest } from "./outbound-recipient-request.ts";

export type OutboundIndividualTarget = Readonly<{
  kind: "individualAppointmentTarget"; appointmentRef: string; patientId: string; businessId: string;
  practitionerId: string; appointmentTypeId: string;
  /** Preserve native precision/representation in the version binding. */
  startsAt: string; endsAt: string; createdAt: string; updatedAt: string;
  archivedAt: string | null; cancelledAt: string | null; deletedAt: string | null;
  didNotArrive: boolean | null; patientArrived: boolean | null;
}>;
export type OutboundTargetObservation = Readonly<{ kind: "outboundTargetObservation";
  target: OutboundIndividualTarget; digest: string; observedAt: string }>;
export type OutboundTargetQuery = OutboundRecordSelection & Readonly<{
  appointmentPolicyDigest: string; operation: "observeIndividualTarget" | "readRequestIndividualTarget";
  patientId: string; appointmentRef: string; request?: OutboundRecipientRequest; requestDigest?: string;
  target?: OutboundIndividualTarget; targetDigest?: string;
}>;
export type OutboundTargetAuthority = Readonly<{
  /** Includes the full native resource body, which may contain unrelated private
   * fields. The decoded target requires its own repeated current grant. */
  allows(query: OutboundTargetQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundTargetQuery, signal: AbortSignal): boolean;
}>;
export type OutboundTargetConfig = Readonly<{ requests: OutboundRecordConfig; appointmentPolicyDigest: string }>;
type FailureKind = "invalidConfig" | "invalidQuery" | "forbidden" | "unavailable" | "rateLimited" | "malformed" | "mismatched";
export type OutboundTargetFailure = Readonly<{ kind: FailureKind; resetAt?: string; retryAfterMs?: number }>;
type Input = Readonly<{ patientId: string; appointmentRef: string }>;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const self = (value: unknown) => object(object(value)?.links)?.self;
const targetId = (ref: unknown) => typeof ref === "string" ? /^cliniko:appointment:([1-9][0-9]{0,18})$/.exec(ref)?.[1] : undefined;
class Failure extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind) { super("Outbound target unavailable"); this.kind = kind; }
}
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch { /* Own body only. */ } }

function decode(raw: unknown, input: Input, selection: OutboundRecordSelection, base: string): OutboundIndividualTarget | undefined {
  const r = object(raw), id = targetId(input.appointmentRef);
  if (!r || r.id !== id || self(r) !== `${base}/individual_appointments/${id}` ||
    self(r.patient) !== `${base}/patients/${input.patientId}` || self(r.business) !== `${base}/businesses/${selection.businessId}`) return undefined;
  const linked = (value: unknown, resource: string) => {
    const url = self(value), prefix = `${base}/${resource}/`;
    return typeof url === "string" && url.startsWith(prefix) && outboundNativeId(url.slice(prefix.length)) ? url.slice(prefix.length) : undefined;
  };
  const practitionerId = linked(r.practitioner, "practitioners"), appointmentTypeId = linked(r.appointment_type, "appointment_types");
  if (!practitionerId || !appointmentTypeId || ![r.starts_at, r.ends_at, r.created_at, r.updated_at].every(v => outboundNativeInstant(v)) ||
    Date.parse(String(r.ends_at)) <= Date.parse(String(r.starts_at)) || Date.parse(String(r.updated_at)) < Date.parse(String(r.created_at)) ||
    ![r.archived_at, r.cancelled_at, r.deleted_at].every(v => v === null || !!outboundNativeInstant(v)) ||
    ![r.did_not_arrive, r.patient_arrived].every(v => v === null || typeof v === "boolean")) return undefined;
  return Object.freeze({ kind: "individualAppointmentTarget", appointmentRef: input.appointmentRef, patientId: input.patientId,
    businessId: selection.businessId, practitionerId, appointmentTypeId,
    startsAt: r.starts_at as string, endsAt: r.ends_at as string, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    archivedAt: r.archived_at as string | null, cancelledAt: r.cancelled_at as string | null, deletedAt: r.deleted_at as string | null,
    didNotArrive: r.did_not_arrive as boolean | null, patientArrived: r.patient_arrived as boolean | null });
}
function digest(selection: OutboundRecordSelection, t: OutboundIndividualTarget): string {
  return createHash("sha256").update(JSON.stringify(["abby.outbound-individual-target.v1", selection.scope.tenantId,
    selection.scope.clinicId, selection.scope.locationId, selection.credentialFingerprint, t.businessId, t.patientId, t.appointmentRef,
    t.practitionerId, t.appointmentTypeId, t.startsAt, t.endsAt, t.createdAt, t.updatedAt,
    t.archivedAt, t.cancelledAt, t.deletedAt, t.didNotArrive, t.patientArrived])).digest("hex");
}

/** Exact staff-owned native observation. No patient proof, call/clinical grant,
 * eligibility decision, list/soonest fallback, atomic snapshot or local cache.
 * Cancelled/past state remains explicit data; owning action policy decides it. */
export class ClinikoOutboundAppointmentTarget {
  readonly #config: OutboundTargetConfig;
  readonly #selection: OutboundRecordSelection;
  readonly #authority: OutboundTargetAuthority;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  private constructor(config: OutboundTargetConfig, authority: OutboundTargetAuthority, port: typeof fetch, shard: string) {
    this.#selection = outboundRecordSelection(config.requests);
    this.#config = Object.freeze({ appointmentPolicyDigest: config.appointmentPolicyDigest, requests: Object.freeze({ ...config.requests,
      scope: this.#selection.scope, rateBudget: Object.freeze({ claim: config.requests.rateBudget.claim.bind(config.requests.rateBudget),
        observe429: config.requests.rateBudget.observe429.bind(config.requests.rateBudget) }),
      ...(config.requests.clock ? { clock: config.requests.clock.bind(config.requests) } : {}) }) });
    this.#authority = Object.freeze({ allows: authority.allows.bind(authority), current: authority.current.bind(authority) });
    this.#fetch = port; this.#base = `https://api.${shard}.cliniko.com/v1`;
  }
  static create(config: OutboundTargetConfig, authority: OutboundTargetAuthority, port: typeof fetch = fetch): Result<ClinikoOutboundAppointmentTarget, OutboundTargetFailure> {
    try {
      const shard = outboundConfigShard(config.requests, port);
      if (!shard || typeof config.appointmentPolicyDigest !== "string" || !/^[a-f0-9]{64}$/.test(config.appointmentPolicyDigest) ||
        typeof authority.allows !== "function" || typeof authority.current !== "function") return err({ kind: "invalidConfig" });
      return ok(new ClinikoOutboundAppointmentTarget(config, authority, port, shard));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async observeTarget(input: Input, signal: AbortSignal): Promise<Result<OutboundTargetObservation, OutboundTargetFailure>> {
    try { return await this.#read(input, signal); } catch { return err({ kind: "invalidQuery" }); }
  }
  async readForRequest(input: OutboundRecipientRequest, signal: AbortSignal): Promise<Result<OutboundTargetObservation, OutboundTargetFailure>> {
    try {
      const encoded = encodeOutboundRecipientRequest(input); if (!encoded.ok) return Promise.resolve(err({ kind: "invalidQuery" }));
      const request = decodeOutboundRecipientRequest(encoded.value); if (!request.ok || !request.value.appointment) return Promise.resolve(err({ kind: "invalidQuery" }));
      const r = request.value, s = this.#selection;
      if (r.scope.tenantId !== s.scope.tenantId || r.scope.clinicId !== s.scope.clinicId || r.scope.locationId !== s.scope.locationId ||
        r.businessId !== s.businessId || r.credentialFingerprint !== s.credentialFingerprint) return Promise.resolve(err({ kind: "invalidQuery" }));
      return await this.#read({ patientId: r.patientId, appointmentRef: r.appointment!.ref }, signal, r);
    } catch { return Promise.resolve(err({ kind: "invalidQuery" })); }
  }
  async #read(input: Input, external: AbortSignal, request?: OutboundRecipientRequest): Promise<Result<OutboundTargetObservation, OutboundTargetFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    if (!input || Object.keys(input).sort().join(",") !== "appointmentRef,patientId" || !outboundNativeId(input.patientId) || !targetId(input.appointmentRef)) return err({ kind: "invalidQuery" });
    const bound = Object.freeze({ ...input }), c = this.#config.requests, controller = new AbortController(), ms = c.deadlineMs ?? 15000;
    const timer = setTimeout(() => controller.abort(), ms), signal = AbortSignal.any([external, controller.signal]), began = performance.now();
    let last = "", response: Response | undefined, owned = false;
    let query: OutboundTargetQuery = Object.freeze({ ...this.#selection, appointmentPolicyDigest: this.#config.appointmentPolicyDigest,
      operation: request ? "readRequestIndividualTarget" : "observeIndividualTarget", ...bound,
      ...(request ? { request, requestDigest: outboundRecipientRequestDigest(request)! } : {}) });
    const active = () => !signal.aborted && performance.now() - began <= ms;
    const clock = () => { const at = c.clock ? c.clock() : new Date().toISOString();
      if (!active() || typeof at !== "string" || outboundNativeInstant(at) !== at || at < last) throw new Failure("unavailable"); last = at; return at; };
    const current = () => { clock(); if (this.#authority.current(query, signal) !== true || !active()) throw new Failure("forbidden"); };
    const wait = async <T>(task: Promise<T>): Promise<T> => { const value = await awaitUntilAbort(task, signal);
      if (value === undefined || !active()) throw new Failure("unavailable"); clock(); return value; };
    const permit = async () => { current(); if (await wait(Promise.resolve().then(() => this.#authority.allows(query, signal))) !== true) throw new Failure("forbidden"); current(); };
    try {
      await permit(); const limited = await wait(claimClinikoBudget(c.rateBudget)); if (limited) return err(limited); await permit(); current();
      const result = await wait(this.#fetch(`${this.#base}/individual_appointments/${targetId(bound.appointmentRef)}`, { method: "GET", redirect: "error", signal,
        headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${c.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${c.contactEmail})` } })
        .then(r => { response = r; if (signal.aborted) discard(r); return r; }));
      if (result.status === 429) return err(await wait(observeCliniko429(c.rateBudget, result.headers.get("X-RateLimit-Reset"))));
      if (result.status !== 200) return err({ kind: result.status === 401 || result.status === 403 ? "forbidden" : "unavailable" });
      owned = true; const bytes = await wait(ownedBodyBytes(result.body, 1_000_000, signal)); let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Failure("malformed"); }
      const target = decode(raw, bound, this.#selection, this.#base); if (!target) throw new Failure("mismatched");
      const version = digest(this.#selection, target); query = Object.freeze({ ...query, target, targetDigest: version }); await permit();
      if (request?.appointment?.digest !== undefined && request.appointment.digest !== version) return err({ kind: "mismatched" });
      const observedAt = clock(); current(); return ok(Object.freeze({ kind: "outboundTargetObservation", target, digest: version, observedAt }));
    } catch (error) { return err({ kind: error instanceof Failure || error instanceof OwnedBodyError ? error.kind : "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); if (!owned) discard(response); }
  }
}
