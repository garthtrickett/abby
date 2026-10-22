import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../../core/model.ts";
import type { LocationScope, Result } from "../../core/model.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "../recall-note.ts";
import { packUuid, unpackUuid, packDigest, unpackDigest, packRecall, unpackRecall } from "./outbound-note-packing.ts";
import { outboundLaunchAttemptDigest } from "../outbound-launch-attempt.ts";
import type { TwilioOriginalCall } from "../../voice/twilio-outbound-context.ts";

export type TwilioNotification<Status extends string> = Readonly<{
  actionRef: string; scope: LocationScope; businessId: string; credentialFingerprint: string; patientId: string;
  original: Readonly<{ recallRef: string; actionRef: string; digest: string }>;
  accountSid: string; callSid: string; number: string; sessionActionRef: string;
  status: Status; receivedAt: string; recordedAt: string; authentication: string;
}>;
export type TwilioNotificationProvider = Readonly<{ ref: string; bindingDigest: string }>;

/** Private canonical notification engine. Completed and unanswered protocols
 * supply separate fixed domains; no consumer accepts an arbitrary status set. */
export function twilioNotificationCodec<Status extends string, Kind extends string>(profile: Readonly<{
  status: Status; error: Kind; header: string; instruction: string;
  actionDomain: string; digestDomain: string; keyDomain: string; authenticationDomain: string;
}>) {
  type Observation = TwilioNotification<Status>;
  type Unsigned = Omit<Observation, "authentication">;
  type Failure = Readonly<{ kind: Kind }>;
  const invalid = (): Result<never, Failure> => err({ kind: profile.error });
  const header = profile.header;
  const instruction = profile.instruction;
  const exact = (v: unknown, keys: readonly string[]) => !!v && typeof v === "object" && !Array.isArray(v) &&
    Object.keys(v).sort().join(",") === [...keys].sort().join(",");
  const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const numeric = (v: unknown) => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
  const opaque = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
  const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
    Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

  /** Stable purpose of a preallocated, sealed original session. Configuration,
   * policy, verifier-key and code revisions must NEVER change this domain or mint
   * a fresh action for the same session. Derivation supplies no source grant. */
  function actionRef(sessionActionRef: string): string | undefined {
    if (!validRecallMarker(sessionActionRef)) return;
    const bytes = createHash("sha256").update(JSON.stringify([profile.actionDomain, sessionActionRef])).digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.toString("hex"), value = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    return value === sessionActionRef ? undefined : value;
  }
  function valid(v: Observation): boolean {
    return exact(v, ["actionRef", "scope", "businessId", "credentialFingerprint", "patientId", "original", "accountSid", "callSid", "number",
      "sessionActionRef", "status", "receivedAt", "recordedAt", "authentication"]) &&
      validRecallMarker(v.actionRef) && validRecallMarker(v.sessionActionRef) && v.actionRef === actionRef(v.sessionActionRef) &&
      exact(v.scope, ["tenantId", "clinicId", "locationId"]) && Object.values(v.scope).every(opaque) &&
      numeric(v.businessId) && numeric(v.patientId) && digest(v.credentialFingerprint) && digest(v.authentication) &&
      exact(v.original, ["recallRef", "actionRef", "digest"]) && /^cliniko:recall:[1-9][0-9]{0,18}$/.test(v.original.recallRef) &&
      validRecallMarker(v.original.actionRef) && ![v.actionRef, v.sessionActionRef].includes(v.original.actionRef) && digest(v.original.digest) &&
      /^AC[0-9a-f]{32}$/.test(v.accountSid) && /^CA[0-9a-f]{32}$/.test(v.callSid) && /^\+[1-9][0-9]{7,14}$/.test(v.number) &&
      v.status === profile.status && instant(v.receivedAt) && instant(v.recordedAt) && v.receivedAt <= v.recordedAt;
  }
  function packSid(value: string): string { return Buffer.from(value.slice(2), "hex").toString("base64url"); }
  function unpackSid(value: unknown, prefix: "AC" | "CA"): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value)) throw Error("Invalid provider identity");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length !== 16 || bytes.toString("base64url") !== value) throw Error("Invalid provider identity");
    return prefix + bytes.toString("hex");
  }
  function encodeObservation(v: Observation): Result<string, Failure> {
    try {
      if (!valid(v)) return invalid();
      const fields = [[v.scope.tenantId, v.scope.clinicId, v.scope.locationId], v.businessId, packDigest(v.credentialFingerprint), v.patientId,
        [packRecall(v.original.recallRef), packUuid(v.original.actionRef), packDigest(v.original.digest)],
        packSid(v.accountSid), packSid(v.callSid), v.number, packUuid(v.sessionActionRef), v.status, v.receivedAt, v.recordedAt, packDigest(v.authentication)];
      const summary = `${header}\n${JSON.stringify(fields)}\n${instruction}`;
      return validRecallSummary(summary) ? ok(formatRecallNote(v.actionRef, summary)) : invalid();
    } catch { return invalid(); }
  }
  function decodeObservation(notes: unknown): Result<Observation, Failure> {
    try {
      if (typeof notes !== "string" || notes.length > 1050) return invalid();
      const lines = notes.split("\n");
      if (lines.length !== 4 || !lines[0]!.startsWith("Abby request ") || lines[1] !== header || lines[3] !== instruction) return invalid();
      const fields: unknown = JSON.parse(lines[2]!);
      if (!Array.isArray(fields) || fields.length !== 13 || !Array.isArray(fields[0]) || fields[0].length !== 3 ||
          !Array.isArray(fields[4]) || fields[4].length !== 3) return invalid();
      const v: Observation = { actionRef: lines[0]!.slice(13),
        scope: { tenantId: fields[0][0], clinicId: fields[0][1], locationId: fields[0][2] }, businessId: fields[1],
        credentialFingerprint: unpackDigest(fields[2]), patientId: fields[3],
        original: { recallRef: unpackRecall(fields[4][0]), actionRef: unpackUuid(fields[4][1]), digest: unpackDigest(fields[4][2]) },
        accountSid: unpackSid(fields[5], "AC"), callSid: unpackSid(fields[6], "CA"), number: fields[7], sessionActionRef: unpackUuid(fields[8]),
        status: fields[9], receivedAt: fields[10], recordedAt: fields[11], authentication: unpackDigest(fields[12]) };
      const encoded = encodeObservation(v);
      if (!encoded.ok || encoded.value !== notes) return invalid();
      return ok(Object.freeze({ ...v, scope: Object.freeze(v.scope), original: Object.freeze(v.original) }));
    } catch { return invalid(); }
  }
  function digestOf(v: Observation): string | undefined {
    const encoded = encodeObservation(v);
    return encoded.ok ? createHash("sha256").update(JSON.stringify([profile.digestDomain, encoded.value])).digest("hex") : undefined;
  }

  /** Separate MAC domain/key-selection identity. Signing authenticates the claimed
   * source observation; it never establishes actual complete provider closure.
   * A future producer must reauthenticate the request and require its own explicit
   * original-profile/native/source/restore grants before retaining anything. */
  class Authentication {
    readonly #key: Buffer;
    readonly #provider: TwilioNotificationProvider;
    readonly #binding: string;
    constructor(key: Uint8Array, provider: TwilioNotificationProvider) {
      if (!(key instanceof Uint8Array) || key.byteLength !== 32 || !exact(provider, ["ref", "bindingDigest"]) || !opaque(provider.ref) || !digest(provider.bindingDigest))
        throw Error("Invalid terminal observation authentication");
      this.#key = Buffer.from(key); this.#provider = Object.freeze({ ref: provider.ref, bindingDigest: provider.bindingDigest });
      this.#binding = createHash("sha256").update(JSON.stringify([profile.keyDomain, this.#provider,
        createHash("sha256").update(this.#key).digest("hex")])).digest("hex");
      Object.defineProperties(this, { binding: { value: this.binding.bind(this) }, sign: { value: this.sign.bind(this) }, verify: { value: this.verify.bind(this) },
        authenticationBinding: { value: this.authenticationBinding.bind(this) }, matchesOriginal: { value: this.matchesOriginal.bind(this) } });
      Object.freeze(this);
    }
    binding(): TwilioNotificationProvider { return this.#provider; }
    authenticationBinding(): string { return this.#binding; }
    #tag(v: Unsigned): string | undefined {
      const encoded = encodeObservation({ ...v, authentication: "0".repeat(64) });
      return encoded.ok ? createHmac("sha256", this.#key).update(JSON.stringify([profile.authenticationDomain, this.#provider, encoded.value])).digest("hex") : undefined;
    }
    sign(input: Unsigned): Result<Observation, Failure> {
      try {
        if (Object.hasOwn(input, "authentication")) return invalid();
        const v = structuredClone(input), authentication = this.#tag(v);
        if (!authentication) return invalid();
        const encoded = encodeObservation({ ...v, authentication });
        return encoded.ok ? decodeObservation(encoded.value) : invalid();
      } catch { return invalid(); }
    }
    verify(v: Observation): boolean {
      try {
        const encoded = encodeObservation(v); if (!encoded.ok) return false;
        const decoded = decodeObservation(encoded.value); if (!decoded.ok) return false;
        const { authentication, ...unsigned } = decoded.value, expected = this.#tag(unsigned);
        return !!expected && timingSafeEqual(Buffer.from(authentication, "hex"), Buffer.from(expected, "hex"));
      } catch { return false; }
    }
    matchesOriginal(v: Observation, context: TwilioOriginalCall, accountSid: string): boolean {
      try {
        const a = context.original.attempt, aliases = [context.reportActionRef, context.sessionActionRef, a.actionRef, a.effectRef, a.capacityAllocationRef,
          a.dncReferences?.actionRef, a.dncReferences?.approvalRef, a.contactReferences?.guardRef, a.contactReferences?.allocationRef, a.contactReferences?.outcomeActionRef];
        return this.verify(v) && v.accountSid === accountSid && v.sessionActionRef === context.sessionActionRef && !aliases.includes(v.actionRef) &&
          v.number === context.number && isDeepStrictEqual(v.scope, a.scope) && v.businessId === a.businessId && v.patientId === a.patientId &&
          v.credentialFingerprint === a.credentialFingerprint && isDeepStrictEqual(a.provider, this.#provider) &&
          v.original.recallRef === context.original.recallRef && v.original.actionRef === a.actionRef && v.original.digest === context.attemptDigest &&
          v.original.digest === outboundLaunchAttemptDigest(a) && v.receivedAt >= a.attemptedAt;
      } catch { return false; }
    }
  }

  return Object.freeze({ actionRef: actionRef, encode: encodeObservation,
    decode: decodeObservation, digest: digestOf,
    Authentication: Authentication });
}
