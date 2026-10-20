import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { decodeOutboundLaunchAttempt, encodeOutboundLaunchAttempt, outboundLaunchAttemptDigest } from "../cliniko/outbound-launch-attempt.ts";
import { validRecallMarker } from "../cliniko/recall-note.ts";
import { captureOutboundOriginalSend } from "./outbound-original-send.ts";
import type { OutboundOriginalSend } from "./outbound-original-send.ts";
import type { OutboundProviderBinding, OutboundRuntimeCall } from "./outbound-runtime.ts";

export type TwilioOriginalCall = Readonly<{ original: OutboundOriginalSend; attemptDigest: string; number: string; reportActionRef: string; sessionActionRef: string }>;
const phone = (s: unknown): s is string => typeof s === "string" && /^\+[1-9][0-9]{7,14}$/.test(s);
const canonical = (s: unknown): s is string => typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const callSid = (s: unknown): s is string => typeof s === "string" && /^CA[0-9a-f]{32}$/.test(s);

/** Authenticated encryption, not base64 obfuscation. No local lookup map, native
 * reread, key registry or clinical permission. Separate purposes prevent a
 * stream capability from being accepted as a launch callback capability. */
export class TwilioOutboundContext {
  readonly #key: Buffer;
  readonly #binding: OutboundProviderBinding;
  readonly #account: string;
  readonly #from: string;
  constructor(key: Uint8Array, binding: OutboundProviderBinding, account: string, from: string) {
    if (key.byteLength !== 32) throw Error("Invalid outbound context key");
    this.#key = Buffer.from(key); this.#binding = Object.freeze({ ...binding }); this.#account = account; this.#from = from;
  }
  #seal(purpose: string, value: unknown): string {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`abby.twilio-outbound.${purpose}.v1`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
  }
  #open(purpose: string, token: unknown): unknown {
    if (typeof token !== "string" || token.length < 40 || token.length > 6000 || !/^[A-Za-z0-9_-]+$/.test(token)) throw Error("Unavailable outbound context");
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw Error("Unavailable outbound context");
    const cipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(`abby.twilio-outbound.${purpose}.v1`)); cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"));
  }
  sealLaunch(original: OutboundOriginalSend, call: OutboundRuntimeCall, reportActionRef: string, sessionActionRef: string): string {
    const captured = captureOutboundOriginalSend(original, call, this.#binding);
    if (!captured || !phone(call.number) || !validRecallMarker(reportActionRef) || !validRecallMarker(sessionActionRef) || sessionActionRef === reportActionRef) throw Error("Unavailable original send context");
    const encoded = encodeOutboundLaunchAttempt(captured.attempt);
    if (!encoded.ok) throw Error("Unavailable original send context");
    return this.#seal("launch", [2, this.#binding.bindingDigest, this.#binding.profileRef, this.#account, this.#from,
      call.number, reportActionRef, captured.recallRef, encoded.value, sessionActionRef]);
  }
  openLaunch(token: unknown): TwilioOriginalCall | undefined {
    try {
      const a = this.#open("launch", token);
      if (!Array.isArray(a) || a.length !== 10 || a[0] !== 2 || a[1] !== this.#binding.bindingDigest || a[2] !== this.#binding.profileRef ||
          a[3] !== this.#account || a[4] !== this.#from || !phone(a[5]) || !validRecallMarker(a[6]) || !validRecallMarker(a[9]) || a[9] === a[6]) return;
      const decoded = decodeOutboundLaunchAttempt(a[8]); if (!decoded.ok || !decoded.value.capacityAllocationRef) return;
      const call = { effectRef: decoded.value.effectRef, capacityAllocationRef: decoded.value.capacityAllocationRef, number: a[5], profileRef: this.#binding.profileRef };
      const original = captureOutboundOriginalSend({ recallRef: a[7], attempt: decoded.value }, call, this.#binding);
      const digest = original && outboundLaunchAttemptDigest(original.attempt); if (!original || !digest) return;
      return Object.freeze({ original, attemptDigest: digest, number: a[5], reportActionRef: a[6], sessionActionRef: a[9] });
    } catch { return; }
  }
  sealStream(launch: string, sid: string, issuedAt: string): string {
    if (!this.openLaunch(launch) || !callSid(sid) || !canonical(issuedAt)) throw Error("Unavailable stream context");
    return this.#seal("stream", [1, launch, sid, issuedAt]);
  }
  openStream(token: unknown, sid: string, now: string): Readonly<{ call: TwilioOriginalCall; receivedAt: string }> | undefined {
    try {
      const a = this.#open("stream", token);
      if (!Array.isArray(a) || a.length !== 4 || a[0] !== 1 || !callSid(sid) || a[2] !== sid || !canonical(a[3]) || !canonical(now) ||
          now < a[3] || Date.parse(now) - Date.parse(a[3]) > 180000) return;
      const call = this.openLaunch(a[1]); return call ? Object.freeze({ call, receivedAt: a[3] }) : undefined;
    } catch { return; }
  }
}
