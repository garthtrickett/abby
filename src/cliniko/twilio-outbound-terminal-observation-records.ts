import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { NativeOutboundRecords } from "./internal/outbound-native-record.ts";
import type { NativeOutboundContext, NativeOutboundFailure, NativeOutboundReadAuthority, NativeOutboundReadBinding, NativeOutboundRetention } from "./internal/outbound-native-record.ts";
import { outboundConfigShard } from "./internal/outbound-record-context.ts";
import { clinikoCredentialFingerprint } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { decodeTwilioOutboundTerminalObservation, encodeTwilioOutboundTerminalObservation, twilioOutboundTerminalObservationDigest, TwilioOutboundTerminalObservationAuthentication } from "./twilio-outbound-terminal-observation.ts";
import type { TwilioOutboundTerminalObservation } from "./twilio-outbound-terminal-observation.ts";
import type { TwilioOriginalCall } from "../voice/twilio-outbound-context.ts";

export type TwilioOutboundTerminalObservationConfig = Readonly<{
  scope: LocationScope; businessId: string; apiKey: string; contactEmail: string;
  outboundTerminalObservationRecallTypeId: string; terminalObservationPolicyDigest: string;
  rateBudget: ClinikoRequestBudget; clock?: () => string; deadlineMs?: number;
}>;
type Selection = Readonly<{
  scope: LocationScope; businessId: string; credentialFingerprint: string;
  outboundTerminalObservationRecallTypeId: string; terminalObservationPolicyDigest: string;
  provider: ReturnType<TwilioOutboundTerminalObservationAuthentication["binding"]>;
  authenticationBinding: string;
}>;
export type TwilioOutboundTerminalObservationQuery = Selection & Readonly<{
  ownerBinding: string; operation: "retainTerminalObservation" | "readTerminalObservation";
  actionRef: string; patientId: string; recallRef?: string; recallAt?: string; includeArchived?: true;
  observation?: TwilioOutboundTerminalObservation; observationDigest?: string;
}>;
export type TwilioOutboundTerminalObservationReadAuthority = NativeOutboundReadAuthority<TwilioOutboundTerminalObservationQuery>;
export type TwilioOutboundTerminalObservationWriteAuthority = TwilioOutboundTerminalObservationReadAuthority & Readonly<{
  producerAdmitted(query: TwilioOutboundTerminalObservationQuery, signal: AbortSignal): Promise<boolean>;
}>;
function selection(c: TwilioOutboundTerminalObservationConfig, auth: TwilioOutboundTerminalObservationAuthentication): Selection {
  return Object.freeze({ scope: Object.freeze({ ...c.scope }), businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey),
    outboundTerminalObservationRecallTypeId: c.outboundTerminalObservationRecallTypeId, terminalObservationPolicyDigest: c.terminalObservationPolicyDigest,
    provider: auth.binding(), authenticationBinding: auth.authenticationBinding() });
}
function shard(c: TwilioOutboundTerminalObservationConfig, port: typeof fetch): string | undefined {
  return outboundConfigShard({ ...c, outboundRecallTypeId: c.outboundTerminalObservationRecallTypeId, recordPolicyDigest: c.terminalObservationPolicyDigest }, port);
}
export function twilioOutboundTerminalObservationRecordBinding(c: TwilioOutboundTerminalObservationConfig, auth: TwilioOutboundTerminalObservationAuthentication): string | undefined {
  try {
    if (!(auth instanceof TwilioOutboundTerminalObservationAuthentication) || !shard(c, fetch)) return;
    const s = selection(c, auth);
    // Key selection is independently authorized in every query. It must not
    // partition the permanent action: changing a verifier cannot reset a claim.
    return createHash("sha256").update(JSON.stringify(["abby.twilio-terminal-observation-record.v1", s.scope.tenantId, s.scope.clinicId, s.scope.locationId,
      s.businessId, s.credentialFingerprint, s.outboundTerminalObservationRecallTypeId, s.terminalObservationPolicyDigest, s.provider.ref, s.provider.bindingDigest])).digest("hex");
  } catch { return; }
}
/** Separate clinic-owned notification family. This reuses bounded native
 * transport and permanent global effect exclusion; it does not implement a
 * provider/contact finalizer. The actual producer must authenticate the status
 * request and require explicit original-profile/source/restore grants. */
export class ClinikoTwilioOutboundTerminalObservationRecords {
  readonly #records: NativeOutboundRecords<TwilioOutboundTerminalObservation, TwilioOutboundTerminalObservationQuery>;
  readonly #matchesOriginal: TwilioOutboundTerminalObservationAuthentication["matchesOriginal"];
  private constructor(c: TwilioOutboundTerminalObservationConfig, auth: TwilioOutboundTerminalObservationAuthentication, sourceShard: string, owner: string,
    authority: TwilioOutboundTerminalObservationReadAuthority, port: typeof fetch,
    write?: Readonly<{ authority: TwilioOutboundTerminalObservationWriteAuthority; effects: OutboundEffectBarrier }>) {
    const s = selection(c, auth), verify = auth.verify.bind(auth);
    this.#matchesOriginal = auth.matchesOriginal.bind(auth);
    this.#records = new NativeOutboundRecords({ ...c, scope: s.scope, credentialFingerprint: s.credentialFingerprint, typeId: s.outboundTerminalObservationRecallTypeId },
      sourceShard, owner, authority, port, {
        encode: v => verify(v) ? encodeTwilioOutboundTerminalObservation(v) : err({ kind: "invalidTwilioTerminalObservation" }),
        decode: notes => { const v = decodeTwilioOutboundTerminalObservation(notes); return v.ok && verify(v.value) ? v : err({ kind: "invalidTwilioTerminalObservation" }); },
        recordedAt: v => v.recordedAt, expiresAt: () => "9999-12-31T23:59:59.999Z",
      }, q => Object.freeze({ ...s, ownerBinding: owner, operation: q.method === "POST" ? "retainTerminalObservation" : "readTerminalObservation",
        actionRef: q.actionRef, patientId: q.patientId, ...(q.method === "GET" ? { includeArchived: true as const } : {}),
        ...(q.recallRef ? { recallRef: q.recallRef } : {}), ...(q.recallAt ? { recallAt: q.recallAt } : {}),
        ...(q.record ? { observation: q.record, observationDigest: twilioOutboundTerminalObservationDigest(q.record)! } : {}) }),
      write ? { barrier: write.effects, producer: write.authority.producerAdmitted.bind(write.authority) } : undefined);
  }
  static create(c: TwilioOutboundTerminalObservationConfig, auth: TwilioOutboundTerminalObservationAuthentication, authority: TwilioOutboundTerminalObservationWriteAuthority,
    effects: OutboundEffectBarrier, port: typeof fetch = fetch): Result<ClinikoTwilioOutboundTerminalObservationRecords, NativeOutboundFailure> {
    try {
      const sourceShard = shard(c, port), owner = twilioOutboundTerminalObservationRecordBinding(c, auth);
      if (!sourceShard || !owner || [authority?.allows, authority?.current, authority?.producerAdmitted, effects?.matches, effects?.claimOnce].some(f => typeof f !== "function") ||
          effects.matches(c.scope, owner) !== true) return err({ kind: "invalidConfig" });
      return ok(new ClinikoTwilioOutboundTerminalObservationRecords(c, auth, sourceShard, owner, authority, port, { authority, effects }));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  static createReadOnly(c: TwilioOutboundTerminalObservationConfig, auth: TwilioOutboundTerminalObservationAuthentication, authority: TwilioOutboundTerminalObservationReadAuthority,
    port: typeof fetch = fetch): Result<Pick<ClinikoTwilioOutboundTerminalObservationRecords, "readObservation">, NativeOutboundFailure> {
    try {
      const sourceShard = shard(c, port), owner = twilioOutboundTerminalObservationRecordBinding(c, auth);
      if (!sourceShard || !owner || [authority?.allows, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      const records = new ClinikoTwilioOutboundTerminalObservationRecords(c, auth, sourceShard, owner, authority, port);
      return ok(Object.freeze({ readObservation: records.readObservation.bind(records) }));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  retainObservationOnce(observation: TwilioOutboundTerminalObservation, original: TwilioOriginalCall, accountSid: string, recallAt: string,
    signal: AbortSignal): Promise<Result<NativeOutboundRetention, NativeOutboundFailure>> {
    if (!this.#matchesOriginal(observation, original, accountSid)) return Promise.resolve(err({ kind: "invalidQuery" }));
    return this.#records.retain(observation, recallAt, signal);
  }
  readObservation(binding: NativeOutboundReadBinding, signal: AbortSignal): Promise<Result<NativeOutboundContext<TwilioOutboundTerminalObservation>, NativeOutboundFailure>> {
    return this.#records.read(binding, signal);
  }
}
