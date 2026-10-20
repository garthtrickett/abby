import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";
import { packUuid, unpackUuid, packDigest, unpackDigest, packRecall, unpackRecall } from "./internal/outbound-note-packing.ts";
import { outboundLaunchAttemptDigest } from "./outbound-launch-attempt.ts";
import type { TwilioOriginalCall } from "../voice/twilio-outbound-context.ts";

/** Private clinic-owned producer evidence. Authentication protects the original
 * assertion against later note edits; it does NOT establish that assertion's
 * completeness. Independent producer/source/retention/restore grants still apply.
 * No transcript, raw audio or model summary is retained. */
export type TwilioOutboundReport = Readonly<{
  actionRef: string; scope: LocationScope; businessId: string; credentialFingerprint: string; patientId: string;
  original: Readonly<{ recallRef: string; actionRef: string; digest: string }>;
  accountSid: string; callSid: string; number: string;
  /** A restrictive stop observation can be retained before call closure. Null
   * never supports a complete no-stop or capacity-release claim. */
  terminal: Readonly<{ endedAt: string; observedAt: string }> | null;
  contact: Readonly<{ kind: "completeNoStop" }> | Readonly<{ kind: "stopRequested"; stoppedAt: string }>;
  reportedAt: string; recordedAt: string; authentication: string;
}>;
type Unsigned = Omit<TwilioOutboundReport, "authentication">;
type Provider = Readonly<{ ref: string; bindingDigest: string }>;
type Failure = Readonly<{ kind: "invalidTwilioOutboundReport" }>;
const invalid = (): Result<never, Failure> => err({ kind: "invalidTwilioOutboundReport" });
const header = "Abby Twilio report v1";
const instruction = "Producer evidence only. No call permission, patient verification or clinical result. Never replay.";
const exact = (v: unknown, keys: readonly string[]) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const numeric = (v: unknown) => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
const opaque = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function valid(v: TwilioOutboundReport): boolean {
  return exact(v, ["actionRef", "scope", "businessId", "credentialFingerprint", "patientId", "original", "accountSid", "callSid", "number", "terminal", "contact", "reportedAt", "recordedAt", "authentication"]) &&
    validRecallMarker(v.actionRef) && exact(v.scope, ["tenantId", "clinicId", "locationId"]) && Object.values(v.scope).every(opaque) &&
    numeric(v.businessId) && numeric(v.patientId) && digest(v.credentialFingerprint) && digest(v.authentication) &&
    exact(v.original, ["recallRef", "actionRef", "digest"]) && /^cliniko:recall:[1-9][0-9]{0,18}$/.test(v.original.recallRef) &&
    validRecallMarker(v.original.actionRef) && v.original.actionRef !== v.actionRef && digest(v.original.digest) &&
    /^AC[0-9a-f]{32}$/.test(v.accountSid) && /^CA[0-9a-f]{32}$/.test(v.callSid) && /^\+[1-9][0-9]{7,14}$/.test(v.number) &&
    [v.reportedAt, v.recordedAt].every(instant) && v.reportedAt <= v.recordedAt &&
    (v.terminal === null || exact(v.terminal, ["endedAt", "observedAt"]) && [v.terminal.endedAt, v.terminal.observedAt].every(instant) &&
      v.terminal.endedAt <= v.terminal.observedAt && v.terminal.observedAt <= v.reportedAt) &&
    (exact(v.contact, ["kind"]) && v.contact.kind === "completeNoStop" && v.terminal !== null || exact(v.contact, ["kind", "stoppedAt"]) &&
      v.contact.kind === "stopRequested" && instant(v.contact.stoppedAt) && v.contact.stoppedAt <= (v.terminal?.endedAt ?? v.reportedAt));
}
function packSid(value: string): string { return Buffer.from(value.slice(2), "hex").toString("base64url"); }
function unpackSid(value: unknown, prefix: "AC" | "CA"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value)) throw Error("Invalid provider identity");
  const b = Buffer.from(value, "base64url");
  if (b.length !== 16 || b.toString("base64url") !== value) throw Error("Invalid provider identity");
  return prefix + b.toString("hex");
}
export function encodeTwilioOutboundReport(v: TwilioOutboundReport): Result<string, Failure> {
  try {
    if (!valid(v)) return invalid();
    const a = [[v.scope.tenantId, v.scope.clinicId, v.scope.locationId], v.businessId, packDigest(v.credentialFingerprint), v.patientId,
      [packRecall(v.original.recallRef), packUuid(v.original.actionRef), packDigest(v.original.digest)],
      packSid(v.accountSid), packSid(v.callSid), v.number, v.terminal?.endedAt ?? null, v.terminal?.observedAt ?? null,
      v.contact.kind === "completeNoStop" ? [0] : [1, v.contact.stoppedAt], v.reportedAt, v.recordedAt, packDigest(v.authentication)];
    const summary = `${header}\n${JSON.stringify(a)}\n${instruction}`;
    return validRecallSummary(summary) ? ok(formatRecallNote(v.actionRef, summary)) : invalid();
  } catch { return invalid(); }
}
export function decodeTwilioOutboundReport(notes: unknown): Result<TwilioOutboundReport, Failure> {
  try {
    if (typeof notes !== "string" || notes.length > 1050) return invalid();
    const l = notes.split("\n");
    if (l.length !== 4 || !l[0]!.startsWith("Abby request ") || l[1] !== header || l[3] !== instruction) return invalid();
    const a: unknown = JSON.parse(l[2]!);
    if (!Array.isArray(a) || a.length !== 14 || !Array.isArray(a[0]) || a[0].length !== 3 ||
        !Array.isArray(a[4]) || a[4].length !== 3 || !Array.isArray(a[10]) ||
        !(a[10].length === 1 && a[10][0] === 0 || a[10].length === 2 && a[10][0] === 1)) return invalid();
    const v: TwilioOutboundReport = { actionRef: l[0]!.slice(13), scope: { tenantId: a[0][0], clinicId: a[0][1], locationId: a[0][2] },
      businessId: a[1], credentialFingerprint: unpackDigest(a[2]), patientId: a[3],
      original: { recallRef: unpackRecall(a[4][0]), actionRef: unpackUuid(a[4][1]), digest: unpackDigest(a[4][2]) },
      accountSid: unpackSid(a[5], "AC"), callSid: unpackSid(a[6], "CA"), number: a[7], terminal: a[8] === null && a[9] === null ? null : { endedAt: a[8], observedAt: a[9] },
      contact: a[10][0] === 0 ? { kind: "completeNoStop" } : { kind: "stopRequested", stoppedAt: a[10][1] },
      reportedAt: a[11], recordedAt: a[12], authentication: unpackDigest(a[13]) };
    const encoded = encodeTwilioOutboundReport(v);
    if (!encoded.ok || encoded.value !== notes) return invalid();
    return ok(Object.freeze({ ...v, scope: Object.freeze(v.scope), original: Object.freeze(v.original),
      terminal: v.terminal === null ? null : Object.freeze(v.terminal), contact: Object.freeze(v.contact) }));
  } catch { return invalid(); }
}
export function twilioOutboundReportDigest(v: TwilioOutboundReport): string | undefined {
  const encoded = encodeTwilioOutboundReport(v);
  return encoded.ok ? createHash("sha256").update(JSON.stringify(["abby.twilio-report.v1", encoded.value])).digest("hex") : undefined;
}
/** The key belongs only to the trusted producer/verifier. Signing is NOT a
 * classifier, terminal inspection or permission decision. No consumer may turn
 * successful MAC verification into complete all-call/speech truth by itself. */
export class TwilioOutboundReportAuthentication {
  readonly #key: Buffer;
  readonly #provider: Provider;
  readonly #authenticationBinding: string;
  constructor(key: Uint8Array, provider: Provider) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32 || !exact(provider, ["ref", "bindingDigest"]) || !opaque(provider.ref) || !digest(provider.bindingDigest))
      throw Error("Invalid report authentication configuration");
    this.#key = Buffer.from(key); this.#provider = Object.freeze({ ref: provider.ref, bindingDigest: provider.bindingDigest });
    this.#authenticationBinding = createHash("sha256").update(JSON.stringify(["abby.twilio-report-key.v1", this.#provider,
      createHash("sha256").update(this.#key).digest("hex")])).digest("hex");
    // Preserve the selected verifier across native permission and transport waits.
    Object.defineProperties(this, { binding: { value: this.binding.bind(this) }, sign: { value: this.sign.bind(this) },
      verify: { value: this.verify.bind(this) }, matchesOriginal: { value: this.matchesOriginal.bind(this) },
      authenticationBinding: { value: this.authenticationBinding.bind(this) } });
    Object.freeze(this);
  }
  binding(): Provider { return this.#provider; }
  /** Non-patient key-selection identity for independent current producer/read
   * grants. A provider name/digest alone cannot identify the selected MAC key. */
  authenticationBinding(): string { return this.#authenticationBinding; }
  #tag(v: Unsigned): string | undefined {
    const encoded = encodeTwilioOutboundReport({ ...v, authentication: "0".repeat(64) });
    return encoded.ok ? createHmac("sha256", this.#key).update(JSON.stringify(["abby.twilio-report.authentication.v1", this.#provider, encoded.value])).digest("hex") : undefined;
  }
  sign(value: Unsigned): Result<TwilioOutboundReport, Failure> {
    try {
      if (Object.hasOwn(value, "authentication")) return invalid();
      const v = structuredClone(value), authentication = this.#tag(v);
      if (!authentication) return invalid();
      const encoded = encodeTwilioOutboundReport({ ...v, authentication });
      return encoded.ok ? decodeTwilioOutboundReport(encoded.value) : invalid();
    } catch { return invalid(); }
  }
  verify(value: TwilioOutboundReport): boolean {
    try {
      if (!encodeTwilioOutboundReport(value).ok) return false;
      const { authentication, ...v } = value, expected = this.#tag(v);
      return !!expected && timingSafeEqual(Buffer.from(authentication, "hex"), Buffer.from(expected, "hex"));
    } catch { return false; }
  }
  /** Compare against authenticated original SEND context, never reconstruct it
   * from currently editable native notes. The context is still not patient proof. */
  matchesOriginal(v: TwilioOutboundReport, context: TwilioOriginalCall, accountSid: string): boolean {
    try {
      const a = context.original.attempt;
      return this.verify(v) && v.accountSid === accountSid && v.actionRef === context.reportActionRef && v.number === context.number &&
        isDeepStrictEqual(v.scope, a.scope) && v.businessId === a.businessId && v.credentialFingerprint === a.credentialFingerprint && v.patientId === a.patientId &&
        isDeepStrictEqual(a.provider, this.#provider) && v.original.recallRef === context.original.recallRef && v.original.actionRef === a.actionRef &&
        v.original.digest === context.attemptDigest && v.original.digest === outboundLaunchAttemptDigest(a) &&
        v.reportedAt >= a.attemptedAt && (v.terminal === null || v.terminal.endedAt >= a.attemptedAt) &&
        (v.contact.kind !== "stopRequested" || v.contact.stoppedAt >= a.attemptedAt);
    } catch { return false; }
  }
}
