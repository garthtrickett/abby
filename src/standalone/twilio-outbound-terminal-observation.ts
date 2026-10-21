import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { outboundConfigShard } from "../cliniko/internal/outbound-record-context.ts";
import type { NativeOutboundFailure, NativeOutboundRetention } from "../cliniko/internal/outbound-native-record.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { ClinikoTwilioOutboundTerminalObservationRecords, twilioOutboundTerminalObservationRecordBinding } from "../cliniko/twilio-outbound-terminal-observation-records.ts";
import type { TwilioOutboundTerminalObservationConfig, TwilioOutboundTerminalObservationWriteAuthority } from "../cliniko/twilio-outbound-terminal-observation-records.ts";
import { twilioOutboundTerminalActionRef, TwilioOutboundTerminalObservationAuthentication } from "../cliniko/twilio-outbound-terminal-observation.ts";
import { TwilioAbbyOutboundRuntime } from "../voice/twilio-outbound-runtime.ts";
import { outboundConversationProfileRef } from "../voice/outbound-voice-entry.ts";
import type { OutboundConversationPolicySource } from "../voice/outbound-voice-entry.ts";
import type { SignedTwilioWebhook } from "../voice/twilio-signed-ingress.ts";

type Config = Readonly<{ runtime: TwilioAbbyOutboundRuntime; observations: TwilioOutboundTerminalObservationConfig; key: Uint8Array }>;
type Ports = Readonly<{ source: OutboundConversationPolicySource; record: TwilioOutboundTerminalObservationWriteAuthority;
  effects(scope: LocationScope, owner: string): OutboundEffectBarrier; native?: typeof fetch }>;
type Outcome = NativeOutboundRetention | Readonly<{ kind: "ignoredStatus" }>;
const instant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v;
}

/** Computed before runtime selection, without a runtime->profile cycle. This
 * binds only the separate native notification purpose, not speech or closure. */
export function twilioTerminalObservationProfileBinding(c: TwilioOutboundTerminalObservationConfig, key: Uint8Array): string | undefined {
  try {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32 || !outboundConfigShard({ ...c,
      outboundRecallTypeId: c.outboundTerminalObservationRecallTypeId, recordPolicyDigest: c.terminalObservationPolicyDigest }, fetch)) return;
    return createHash("sha256").update(JSON.stringify(["abby.twilio-terminal-observation-profile.v1", c.scope.tenantId, c.scope.clinicId, c.scope.locationId,
      c.businessId, clinikoCredentialFingerprint(c.apiKey), c.outboundTerminalObservationRecallTypeId, c.terminalObservationPolicyDigest, c.deadlineMs ?? 15000,
      createHash("sha256").update(key).digest("hex")])).digest("hex");
  } catch { return; }
}

/** Optional trusted-host hook for actual raw signed status requests. It never
 * trusts a supplied decoded event, invents an end time or releases a hold.
 * Native history and complete independent provider closure are separate work.
 * No legacy profile acquires this producer, and no default route is installed. */
export class TwilioOutboundTerminalObservationProducer {
  readonly #selected: ReturnType<TwilioAbbyOutboundRuntime["binding"]>;
  readonly #binding: TwilioAbbyOutboundRuntime["binding"];
  readonly #authenticate: TwilioAbbyOutboundRuntime["authenticateStatus"];
  readonly #account: TwilioAbbyOutboundRuntime["acceptsAccount"];
  readonly #observations: TwilioOutboundTerminalObservationConfig;
  readonly #auth: TwilioOutboundTerminalObservationAuthentication;
  readonly #owner: string;
  readonly #profile: string;
  readonly #source: OutboundConversationPolicySource;
  readonly #record: TwilioOutboundTerminalObservationWriteAuthority;
  readonly #effects: Ports["effects"];
  readonly #native: typeof fetch;
  readonly #now: () => string;
  private constructor(c: Config, p: Ports, profile: string, auth: TwilioOutboundTerminalObservationAuthentication, owner: string) {
    this.#selected = Object.freeze({ ...c.runtime.binding() }); this.#binding = c.runtime.binding.bind(c.runtime);
    this.#authenticate = c.runtime.authenticateStatus.bind(c.runtime); this.#account = c.runtime.acceptsAccount.bind(c.runtime);
    const b = c.observations.rateBudget;
    this.#now = c.observations.clock?.bind(c.observations) ?? (() => new Date().toISOString());
    this.#observations = Object.freeze({ ...c.observations, scope: Object.freeze({ ...c.observations.scope }), clock: this.#now,
      rateBudget: Object.freeze({ claim: b.claim.bind(b), observe429: b.observe429.bind(b) }) });
    this.#auth = auth; this.#owner = owner; this.#profile = profile;
    this.#source = Object.freeze({ read: p.source.read.bind(p.source), current: p.source.current.bind(p.source) });
    this.#record = Object.freeze({ allows: p.record.allows.bind(p.record), current: p.record.current.bind(p.record), producerAdmitted: p.record.producerAdmitted.bind(p.record) });
    this.#effects = p.effects.bind(p); this.#native = p.native ?? fetch;
  }
  static create(c: Config, p: Ports): Result<TwilioOutboundTerminalObservationProducer, Readonly<{ kind: "invalidConfig" }>> {
    try {
      const profile = twilioTerminalObservationProfileBinding(c.observations, c.key);
      if (!(c.runtime instanceof TwilioAbbyOutboundRuntime) || !profile ||
          [p.source?.read, p.source?.current, p.record?.allows, p.record?.current, p.record?.producerAdmitted, p.effects].some(f => typeof f !== "function"))
        return err({ kind: "invalidConfig" });
      const provider = c.runtime.binding(); if (!/^abby-outbound-v1:[a-f0-9]{64}$/.test(provider.profileRef)) return err({ kind: "invalidConfig" });
      const auth = new TwilioOutboundTerminalObservationAuthentication(c.key, { ref: provider.ref, bindingDigest: provider.bindingDigest });
      const owner = twilioOutboundTerminalObservationRecordBinding(c.observations, auth);
      return owner ? ok(new TwilioOutboundTerminalObservationProducer(c, p, profile, auth, owner)) : err({ kind: "invalidConfig" });
    } catch { return err({ kind: "invalidConfig" }); }
  }
  profileBinding(): string { return this.#profile; }
  async observeStatus(request: SignedTwilioWebhook, external: AbortSignal): Promise<Result<Outcome, NativeOutboundFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const deadline = new AbortController(), ms = this.#observations.deadlineMs ?? 15000, timer = setTimeout(() => deadline.abort(), ms);
    const signal = AbortSignal.any([external, deadline.signal]), began = performance.now();
    try {
      const decoded = this.#authenticate(structuredClone(request));
      if (!decoded.ok || !isDeepStrictEqual(this.#binding(), this.#selected)) return err({ kind: "invalidQuery" });
      const event = freeze(structuredClone(decoded.value));
      if (event.status !== "completed") return ok({ kind: "ignoredStatus" });
      const call = event.call, a = call.context.original.attempt, c = this.#observations;
      if (!this.#account(call.accountSid) || !isDeepStrictEqual(a.scope, c.scope) || a.businessId !== c.businessId ||
          a.credentialFingerprint !== clinikoCredentialFingerprint(c.apiKey)) return err({ kind: "invalidQuery" });
      let last = call.receivedAt;
      const selected = () => {
        const at = this.#now();
        if (signal.aborted || performance.now() - began > ms || !instant(at) || at < last || !isDeepStrictEqual(this.#binding(), this.#selected)) return false;
        last = at; return true;
      };
      if (!selected()) return err({ kind: "unavailable" });
      const selection = freeze({ key: { accountRef: call.accountSid, providerCallRef: call.callSid }, scope: a.scope,
        clinicNumber: call.clinicNumber, profileRef: this.#selected.profileRef });
      const loaded = await awaitUntilAbort(Promise.resolve().then(() => selected() ? this.#source.read(selection, signal) : err({ kind: "unavailable" as const })), signal);
      if (!loaded?.ok || !selected()) return err({ kind: "unavailable" });
      const approval = freeze(structuredClone(loaded.value));
      const current = () => selected() && approval.terminalObservationBinding === this.#profile &&
        outboundConversationProfileRef(approval) === this.#selected.profileRef && isDeepStrictEqual(approval.policy.scope, a.scope) &&
        this.#source.current(selection, approval) === true;
      if (!current()) return err({ kind: "forbidden" });
      const actionRef = twilioOutboundTerminalActionRef(call.context.sessionActionRef), recordedAt = this.#now();
      if (!actionRef || !instant(recordedAt) || recordedAt < last) return err({ kind: "unavailable" });
      const signed = this.#auth.sign({ actionRef, scope: a.scope, businessId: a.businessId, credentialFingerprint: a.credentialFingerprint, patientId: a.patientId,
        original: { recallRef: call.context.original.recallRef, actionRef: a.actionRef, digest: call.context.attemptDigest },
        accountSid: call.accountSid, callSid: call.callSid, number: call.recipientNumber, sessionActionRef: call.context.sessionActionRef,
        status: "completed", receivedAt: call.receivedAt, recordedAt });
      if (!signed.ok || !current()) return err({ kind: "unavailable" });
      const r = this.#record, records = ClinikoTwilioOutboundTerminalObservationRecords.create(c, this.#auth, {
        allows: async (q, s) => current() && await r.allows(q, s), current: (q, s) => current() && r.current(q, s),
        producerAdmitted: async (q, s) => current() && await r.producerAdmitted(q, s),
      }, this.#effects(c.scope, this.#owner), this.#native);
      if (!records.ok || !current()) return err({ kind: "forbidden" });
      return await records.value.retainObservationOnce(signed.value, call.context, call.accountSid, recordedAt.slice(0, 10), signal);
    } catch { return err({ kind: "unavailable" }); }
    finally { clearTimeout(timer); deadline.abort(); }
  }
}
