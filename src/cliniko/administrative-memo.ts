import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { validOutboundEffectRef } from "../core/outbound-effect-barrier.ts";

type Appointment = Readonly<{ appointmentRef: string; startsAt: string; endsAt: string }>;
type Observation = Readonly<{ basis: "acknowledgedAndObservedBestEffort"; observedAt: string }>;
export type AdministrativeMemoOutcome = Appointment & (
  | Readonly<{ kind: "bookingConfirmed" }>
  | Readonly<{ kind: "cancellationObserved"; verification: Observation }>
  | Readonly<{ kind: "reschedulingObserved"; verification: Observation; practitionerRef: string;
      previous: Readonly<{ startsAt: string; endsAt: string; practitionerRef: string }> }>
);
/** Private native record, not a clinical receipt. A trusted workflow must
 * independently establish exact subject/result and current write permission.
 * No transcript, free prose, household inference or treatment fields exist. */
export type AdministrativeMemo = Readonly<{
  actionRef: string; sourceActionRef: string; scope: LocationScope;
  businessId: string; credentialFingerprint: string; patientId: string;
  authorRef: string; policy: Readonly<{ version: string; digest: string }>;
  direction: "inbound" | "outbound"; outcome: AdministrativeMemoOutcome;
  occurredAt: string; recordedAt: string; authentication: string;
}>;
export type UnsignedAdministrativeMemo = Omit<AdministrativeMemo, "authentication">;
type Failure = Readonly<{ kind: "invalidAdministrativeMemo" }>;
const invalid = (): Result<never, Failure> => err({ kind: "invalidAdministrativeMemo" });
const header = "Abby administrative memo v1", prefix = "Authentication sha256:";
const keys = ["actionRef", "sourceActionRef", "scope", "businessId", "credentialFingerprint", "patientId", "authorRef", "policy", "direction", "outcome", "occurredAt", "recordedAt", "authentication"];
const exact = (v: unknown, fields: readonly string[]) => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...fields].sort().join(",");
const opaque = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
const numeric = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const interval = (v: { startsAt: string; endsAt: string }) => instant(v.startsAt) && instant(v.endsAt) && v.startsAt < v.endsAt &&
  Date.parse(v.endsAt) - Date.parse(v.startsAt) <= 480 * 60_000;

/** One immutable memo purpose per original clinical action, independent of
 * account settings, template, operation label or signing-key rotation. */
export function administrativeMemoActionRef(sourceActionRef: string): string | undefined {
  if (!validOutboundEffectRef(sourceActionRef)) return;
  const bytes = createHash("sha256").update(JSON.stringify(["abby.administrative-memo-purpose.v1", sourceActionRef])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex"), value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return value !== sourceActionRef ? value : undefined;
}

function validOutcome(o: AdministrativeMemoOutcome, occurredAt: string, recordedAt: string): boolean {
  if (!o || !/^cliniko:appointment:[1-9][0-9]{0,18}$/.test(o.appointmentRef) || !interval(o)) return false;
  if (o.kind === "bookingConfirmed") return exact(o, ["kind", "appointmentRef", "startsAt", "endsAt"]);
  if (o.kind !== "cancellationObserved" && o.kind !== "reschedulingObserved") return false;
  if (!exact(o.verification, ["basis", "observedAt"]) || o.verification.basis !== "acknowledgedAndObservedBestEffort" ||
      !instant(o.verification.observedAt) || o.verification.observedAt !== occurredAt || o.verification.observedAt > recordedAt) return false;
  if (o.kind === "cancellationObserved") return exact(o, ["kind", "appointmentRef", "startsAt", "endsAt", "verification"]);
  const practitioner = (v: unknown) => typeof v === "string" && /^cliniko:practitioner:[1-9][0-9]{0,18}$/.test(v);
  return exact(o, ["kind", "appointmentRef", "startsAt", "endsAt", "verification", "previous", "practitionerRef"]) &&
    exact(o.previous, ["startsAt", "endsAt", "practitionerRef"]) && interval(o.previous) && practitioner(o.practitionerRef) && practitioner(o.previous.practitionerRef) &&
    Date.parse(o.endsAt) - Date.parse(o.startsAt) === Date.parse(o.previous.endsAt) - Date.parse(o.previous.startsAt) &&
    (o.previous.startsAt !== o.startsAt || o.previous.endsAt !== o.endsAt || o.previous.practitionerRef !== o.practitionerRef);
}
function valid(v: AdministrativeMemo): boolean {
  return exact(v, keys) && validOutboundEffectRef(v.sourceActionRef) && v.actionRef === administrativeMemoActionRef(v.sourceActionRef) &&
    exact(v.scope, ["tenantId", "clinicId", "locationId"]) && Object.values(v.scope).every(opaque) &&
    numeric(v.businessId) && numeric(v.patientId) && digest(v.credentialFingerprint) && opaque(v.authorRef) &&
    exact(v.policy, ["version", "digest"]) && opaque(v.policy.version) && digest(v.policy.digest) &&
    ["inbound", "outbound"].includes(v.direction) && instant(v.occurredAt) && instant(v.recordedAt) && v.occurredAt <= v.recordedAt && digest(v.authentication) &&
    validOutcome(v.outcome, v.occurredAt, v.recordedAt);
}
function payload(v: AdministrativeMemo): UnsignedAdministrativeMemo {
  const o = v.outcome;
  return { actionRef: v.actionRef, sourceActionRef: v.sourceActionRef, scope: { tenantId: v.scope.tenantId, clinicId: v.scope.clinicId, locationId: v.scope.locationId },
    businessId: v.businessId, credentialFingerprint: v.credentialFingerprint, patientId: v.patientId, authorRef: v.authorRef,
    policy: { version: v.policy.version, digest: v.policy.digest }, direction: v.direction,
    outcome: { kind: o.kind, appointmentRef: o.appointmentRef, startsAt: o.startsAt, endsAt: o.endsAt,
      ...(o.kind !== "bookingConfirmed" ? { verification: { basis: o.verification.basis, observedAt: o.verification.observedAt } } : {}),
      ...(o.kind === "reschedulingObserved" ? { practitionerRef: o.practitionerRef,
        previous: { startsAt: o.previous.startsAt, endsAt: o.previous.endsAt, practitionerRef: o.previous.practitionerRef } } : {}) } as AdministrativeMemoOutcome,
    occurredAt: v.occurredAt, recordedAt: v.recordedAt };
}
function description(v: AdministrativeMemo): string {
  const o = v.outcome, range = `${o.startsAt} to ${o.endsAt} (UTC)`;
  if (o.kind === "bookingConfirmed") return `Confirmed booking ${o.appointmentRef}: ${range}.`;
  return o.kind === "cancellationObserved" ? `Observed cancelled ${o.appointmentRef}: ${range}; inspected ${o.verification.observedAt}.` :
    `Observed ${o.appointmentRef} at ${range}, practitioner ${o.practitionerRef}, after a rescheduling request from ${o.previous.startsAt} to ${o.previous.endsAt} (UTC); inspected ${o.verification.observedAt}.`;
}
function frozen(v: AdministrativeMemo): AdministrativeMemo {
  const p = payload(v); Object.freeze(p.scope); Object.freeze(p.policy);
  if (p.outcome.kind !== "bookingConfirmed") Object.freeze(p.outcome.verification);
  if (p.outcome.kind === "reschedulingObserved") Object.freeze(p.outcome.previous);
  Object.freeze(p.outcome); return Object.freeze({ ...p, authentication: v.authentication });
}
export function encodeAdministrativeMemo(v: AdministrativeMemo): Result<string, Failure> {
  try {
    if (!valid(v)) return invalid();
    const text = [header, description(v), JSON.stringify(payload(v)), prefix + v.authentication].join("\n");
    return text.length <= 4096 ? ok(text) : invalid();
  } catch { return invalid(); }
}
export function decodeAdministrativeMemo(content: unknown): Result<AdministrativeMemo, Failure> {
  try {
    if (typeof content !== "string" || content.length > 4096) return invalid();
    const lines = content.split("\n");
    if (lines.length !== 4 || lines[0] !== header || !lines[3]!.startsWith(prefix)) return invalid();
    const p: unknown = JSON.parse(lines[2]!);
    if (!exact(p, keys.filter(k => k !== "authentication"))) return invalid();
    const memo = { ...p as UnsignedAdministrativeMemo, authentication: lines[3]!.slice(prefix.length) };
    const encoded = encodeAdministrativeMemo(memo);
    return encoded.ok && encoded.value === content ? ok(frozen(memo)) : invalid();
  } catch { return invalid(); }
}
export function administrativeMemoDigest(v: AdministrativeMemo): string | undefined {
  const text = encodeAdministrativeMemo(v); return text.ok ? createHash("sha256").update(text.value).digest("hex") : undefined;
}
/** MAC integrity is not patient verification, clinical success, or permission
 * to create/read a memo. The actual workflow producer needs its own grant. */
export class AdministrativeMemoAuthentication {
  readonly #key: Buffer;
  readonly #binding: string;
  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw Error("Invalid memo authentication configuration");
    this.#key = Buffer.from(key); this.#binding = createHash("sha256").update(JSON.stringify(["abby.administrative-memo-key.v1", createHash("sha256").update(this.#key).digest("hex")])).digest("hex");
    Object.defineProperties(this, { binding: { value: this.binding.bind(this) }, sign: { value: this.sign.bind(this) }, verify: { value: this.verify.bind(this) } }); Object.freeze(this);
  }
  binding(): string { return this.#binding; }
  sign(input: UnsignedAdministrativeMemo): Result<AdministrativeMemo, Failure> {
    try {
      if (!exact(input, keys.filter(k => k !== "authentication"))) return invalid();
      const candidate = { ...structuredClone(input), authentication: "0".repeat(64) };
      if (!valid(candidate)) return invalid();
      const authentication = createHmac("sha256", this.#key).update(JSON.stringify(["abby.administrative-memo.v1", payload(candidate)])).digest("hex");
      return ok(frozen({ ...candidate, authentication }));
    } catch { return invalid(); }
  }
  verify(memo: AdministrativeMemo): boolean {
    try {
      if (!valid(memo)) return false;
      const expected = createHmac("sha256", this.#key).update(JSON.stringify(["abby.administrative-memo.v1", payload(memo)])).digest();
      return timingSafeEqual(expected, Buffer.from(memo.authentication, "hex"));
    } catch { return false; }
  }
}
