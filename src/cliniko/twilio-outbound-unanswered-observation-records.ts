import type { PatientRecallSnapshot } from "./internal/patient-recall-snapshot.ts";
import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { NativeOutboundRecords } from "./internal/outbound-native-record.ts";
import type { NativeOutboundContext, NativeOutboundFailure, NativeOutboundReadAuthority, NativeOutboundReadBinding, NativeOutboundRetention } from "./internal/outbound-native-record.ts";
import { outboundConfigShard } from "./internal/outbound-record-context.ts";
import { clinikoCredentialFingerprint } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { decodeTwilioOutboundUnansweredObservation, encodeTwilioOutboundUnansweredObservation, twilioOutboundUnansweredObservationDigest, TwilioOutboundUnansweredObservationAuthentication } from "./twilio-outbound-unanswered-observation.ts";
import type { TwilioOutboundUnansweredObservation } from "./twilio-outbound-unanswered-observation.ts";
import type { TwilioOriginalCall } from "../voice/twilio-outbound-context.ts";

export type TwilioOutboundUnansweredObservationConfig = Readonly<{
  scope: LocationScope; businessId: string; apiKey: string; contactEmail: string;
  outboundUnansweredObservationRecallTypeId: string; unansweredObservationPolicyDigest: string;
  rateBudget: ClinikoRequestBudget; clock?: () => string; deadlineMs?: number;
}>;
type Selection = Readonly<{
  scope: LocationScope; businessId: string; credentialFingerprint: string;
  outboundUnansweredObservationRecallTypeId: string; unansweredObservationPolicyDigest: string;
  provider: ReturnType<TwilioOutboundUnansweredObservationAuthentication["binding"]>;
  authenticationBinding: string;
}>;
export type TwilioOutboundUnansweredObservationQuery = Selection & Readonly<{
  ownerBinding: string; operation: "retainUnansweredObservation" | "readUnansweredObservation";
  actionRef: string; patientId: string; recallRef?: string; recallAt?: string; includeArchived?: true;
  observation?: TwilioOutboundUnansweredObservation; observationDigest?: string;
}>;
export type TwilioOutboundUnansweredObservationReadAuthority = NativeOutboundReadAuthority<TwilioOutboundUnansweredObservationQuery>;
export type TwilioOutboundUnansweredObservationWriteAuthority = TwilioOutboundUnansweredObservationReadAuthority & Readonly<{
  producerAdmitted(query: TwilioOutboundUnansweredObservationQuery, signal: AbortSignal): Promise<boolean>;
}>;
function selection(c: TwilioOutboundUnansweredObservationConfig, auth: TwilioOutboundUnansweredObservationAuthentication): Selection {
  return Object.freeze({ scope: Object.freeze({ ...c.scope }), businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey),
    outboundUnansweredObservationRecallTypeId: c.outboundUnansweredObservationRecallTypeId, unansweredObservationPolicyDigest: c.unansweredObservationPolicyDigest,
    provider: auth.binding(), authenticationBinding: auth.authenticationBinding() });
}
function shard(c: TwilioOutboundUnansweredObservationConfig, port: typeof fetch): string | undefined {
  return outboundConfigShard({ ...c, outboundRecallTypeId: c.outboundUnansweredObservationRecallTypeId, recordPolicyDigest: c.unansweredObservationPolicyDigest }, port);
}
export function twilioOutboundUnansweredObservationRecordBinding(c: TwilioOutboundUnansweredObservationConfig, auth: TwilioOutboundUnansweredObservationAuthentication): string | undefined {
  try {
    if (!(auth instanceof TwilioOutboundUnansweredObservationAuthentication) || !shard(c, fetch)) return;
    const s = selection(c, auth);
    // Key selection is independently authorized in every query. It must not
    // partition the permanent action: changing a verifier cannot reset a claim.
    return createHash("sha256").update(JSON.stringify(["abby.twilio-unanswered-observation-record.v1", s.scope.tenantId, s.scope.clinicId, s.scope.locationId,
      s.businessId, s.credentialFingerprint, s.outboundUnansweredObservationRecallTypeId, s.unansweredObservationPolicyDigest, s.provider.ref, s.provider.bindingDigest])).digest("hex");
  } catch { return; }
}
/** Separate clinic-owned notification family. This reuses bounded native
 * transport and permanent global effect exclusion; it does not implement a
 * provider/contact finalizer. The actual producer must authenticate the status
 * request and require explicit original-profile/source/restore grants. */
export class ClinikoTwilioOutboundUnansweredObservationRecords {
  readonly #records: NativeOutboundRecords<TwilioOutboundUnansweredObservation, TwilioOutboundUnansweredObservationQuery>;
  readonly #matchesOriginal: TwilioOutboundUnansweredObservationAuthentication["matchesOriginal"];
  private constructor(c: TwilioOutboundUnansweredObservationConfig, auth: TwilioOutboundUnansweredObservationAuthentication, sourceShard: string, owner: string,
    authority: TwilioOutboundUnansweredObservationReadAuthority, port: typeof fetch,
    write?: Readonly<{ authority: TwilioOutboundUnansweredObservationWriteAuthority; effects: OutboundEffectBarrier }>) {
    const s = selection(c, auth), verify = auth.verify.bind(auth);
    this.#matchesOriginal = auth.matchesOriginal.bind(auth);
    this.#records = new NativeOutboundRecords({ ...c, scope: s.scope, credentialFingerprint: s.credentialFingerprint, typeId: s.outboundUnansweredObservationRecallTypeId },
      sourceShard, owner, authority, port, {
        encode: v => verify(v) ? encodeTwilioOutboundUnansweredObservation(v) : err({ kind: "invalidTwilioUnansweredObservation" }),
        decode: notes => { const v = decodeTwilioOutboundUnansweredObservation(notes); return v.ok && verify(v.value) ? v : err({ kind: "invalidTwilioUnansweredObservation" }); },
        recordedAt: v => v.recordedAt, expiresAt: () => "9999-12-31T23:59:59.999Z",
      }, q => Object.freeze({ ...s, ownerBinding: owner, operation: q.method === "POST" ? "retainUnansweredObservation" : "readUnansweredObservation",
        actionRef: q.actionRef, patientId: q.patientId, ...(q.method === "GET" ? { includeArchived: true as const } : {}),
        ...(q.recallRef ? { recallRef: q.recallRef } : {}), ...(q.recallAt ? { recallAt: q.recallAt } : {}),
        ...(q.record ? { observation: q.record, observationDigest: twilioOutboundUnansweredObservationDigest(q.record)! } : {}) }),
      write ? { barrier: write.effects, producer: write.authority.producerAdmitted.bind(write.authority) } : undefined);
  }
  static create(c: TwilioOutboundUnansweredObservationConfig, auth: TwilioOutboundUnansweredObservationAuthentication, authority: TwilioOutboundUnansweredObservationWriteAuthority,
    effects: OutboundEffectBarrier, port: typeof fetch = fetch): Result<ClinikoTwilioOutboundUnansweredObservationRecords, NativeOutboundFailure> {
    try {
      const sourceShard = shard(c, port), owner = twilioOutboundUnansweredObservationRecordBinding(c, auth);
      if (!sourceShard || !owner || [authority?.allows, authority?.current, authority?.producerAdmitted, effects?.matches, effects?.claimOnce].some(f => typeof f !== "function") ||
          effects.matches(c.scope, owner) !== true) return err({ kind: "invalidConfig" });
      return ok(new ClinikoTwilioOutboundUnansweredObservationRecords(c, auth, sourceShard, owner, authority, port, { authority, effects }));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  static createReadOnly(c: TwilioOutboundUnansweredObservationConfig, auth: TwilioOutboundUnansweredObservationAuthentication, authority: TwilioOutboundUnansweredObservationReadAuthority,
    port: typeof fetch = fetch): Result<Pick<ClinikoTwilioOutboundUnansweredObservationRecords, "readObservation">, NativeOutboundFailure> {
    try {
      const sourceShard = shard(c, port), owner = twilioOutboundUnansweredObservationRecordBinding(c, auth);
      if (!sourceShard || !owner || [authority?.allows, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      const records = new ClinikoTwilioOutboundUnansweredObservationRecords(c, auth, sourceShard, owner, authority, port);
      return ok(Object.freeze({ readObservation: records.readObservation.bind(records) }));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  retainObservationOnce(observation: TwilioOutboundUnansweredObservation, original: TwilioOriginalCall, accountSid: string, recallAt: string,
    signal: AbortSignal): Promise<Result<NativeOutboundRetention, NativeOutboundFailure>> {
    if (!this.#matchesOriginal(observation, original, accountSid)) return Promise.resolve(err({ kind: "invalidQuery" }));
    return this.#records.retain(observation, recallAt, signal);
  }
  readObservation(binding: NativeOutboundReadBinding, signal: AbortSignal, history?: PatientRecallSnapshot): Promise<Result<NativeOutboundContext<TwilioOutboundUnansweredObservation>, NativeOutboundFailure>> {
    return this.#records.read(binding, signal, history);
  }
}
