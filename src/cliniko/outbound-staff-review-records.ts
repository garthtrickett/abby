import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { NativeOutboundRecords } from "./internal/outbound-native-record.ts";
import type { NativeOutboundContext, NativeOutboundFailure, NativeOutboundReadAuthority, NativeOutboundReadBinding, NativeOutboundRetention } from "./internal/outbound-native-record.ts";
import { outboundConfigShard } from "./internal/outbound-record-context.ts";
import { clinikoCredentialFingerprint } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { decodeOutboundStaffReviewRequest, encodeOutboundStaffReviewRequest, outboundStaffReviewRequestDigest } from "./outbound-staff-review-request.ts";
import type { OutboundStaffReviewRequest } from "./outbound-staff-review-request.ts";

export type OutboundStaffReviewConfig = Readonly<{
  scope: LocationScope; businessId: string; apiKey: string; contactEmail: string;
  outboundStaffReviewRecallTypeId: string; staffReviewPolicyDigest: string;
  rateBudget: ClinikoRequestBudget; clock?: () => string; deadlineMs?: number;
}>;
export type OutboundStaffReviewSelection = Readonly<{
  scope: LocationScope; businessId: string; credentialFingerprint: string;
  outboundStaffReviewRecallTypeId: string; staffReviewPolicyDigest: string;
}>;
export type OutboundStaffReviewQuery = OutboundStaffReviewSelection & Readonly<{
  ownerBinding: string; operation: "retainStaffReview" | "readStaffReview";
  actionRef: string; patientId: string; recallRef?: string; recallAt?: string; includeArchived?: true;
  request?: OutboundStaffReviewRequest; requestDigest?: string;
}>;
export type OutboundStaffReviewReadAuthority = NativeOutboundReadAuthority<OutboundStaffReviewQuery>;
export type OutboundStaffReviewWriteAuthority = OutboundStaffReviewReadAuthority & Readonly<{
  /** The producer independently establishes exact original/notification source
   * grants. A pending request supplies neither authentication nor contact truth. */
  producerAdmitted(query: OutboundStaffReviewQuery, signal: AbortSignal): Promise<boolean>;
}>;
export function outboundStaffReviewSelection(c: OutboundStaffReviewConfig): OutboundStaffReviewSelection {
  return Object.freeze({ scope: Object.freeze({ ...c.scope }), businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey),
    outboundStaffReviewRecallTypeId: c.outboundStaffReviewRecallTypeId, staffReviewPolicyDigest: c.staffReviewPolicyDigest });
}
function shard(c: OutboundStaffReviewConfig, port: typeof fetch): string | undefined {
  return outboundConfigShard({ ...c, outboundRecallTypeId: c.outboundStaffReviewRecallTypeId, recordPolicyDigest: c.staffReviewPolicyDigest }, port);
}
export function outboundStaffReviewRecordBinding(c: OutboundStaffReviewConfig): string | undefined {
  try {
    if (!shard(c, fetch)) return undefined;
    const s = outboundStaffReviewSelection(c);
    return createHash("sha256").update(JSON.stringify(["abby.outbound-staff-review-record.v1", s.scope.tenantId, s.scope.clinicId, s.scope.locationId,
      s.businessId, s.credentialFingerprint, s.outboundStaffReviewRecallTypeId, s.staffReviewPolicyDigest])).digest("hex");
  } catch { return undefined; }
}
/** Clinic-owned pending work only. The shared native owner handles exact ACK,
 * permanent one-use exclusion, bounded transport and current grants. There is
 * deliberately no contact settlement, task resolution or hold-release method. */
export class ClinikoOutboundStaffReviewRecords {
  readonly #records: NativeOutboundRecords<OutboundStaffReviewRequest, OutboundStaffReviewQuery>;
  private constructor(c: OutboundStaffReviewConfig, sourceShard: string, owner: string, authority: OutboundStaffReviewReadAuthority, port: typeof fetch,
    write?: Readonly<{ authority: OutboundStaffReviewWriteAuthority; effects: OutboundEffectBarrier }>) {
    const s = outboundStaffReviewSelection(c);
    this.#records = new NativeOutboundRecords({ ...c, scope: s.scope, credentialFingerprint: s.credentialFingerprint, typeId: s.outboundStaffReviewRecallTypeId },
      sourceShard, owner, authority, port,
      { encode: encodeOutboundStaffReviewRequest, decode: decodeOutboundStaffReviewRequest, recordedAt: v => v.recordedAt, expiresAt: () => "9999-12-31T23:59:59.999Z" },
      q => Object.freeze({ ...s, ownerBinding: owner, operation: q.method === "POST" ? "retainStaffReview" : "readStaffReview",
        actionRef: q.actionRef, patientId: q.patientId, ...(q.method === "GET" ? { includeArchived: true as const } : {}),
        ...(q.recallRef ? { recallRef: q.recallRef } : {}), ...(q.recallAt ? { recallAt: q.recallAt } : {}),
        ...(q.record ? { request: q.record, requestDigest: outboundStaffReviewRequestDigest(q.record)! } : {}) }),
      write ? { barrier: write.effects, producer: write.authority.producerAdmitted.bind(write.authority) } : undefined);
  }
  static create(c: OutboundStaffReviewConfig, authority: OutboundStaffReviewWriteAuthority, effects: OutboundEffectBarrier,
    port: typeof fetch = fetch): Result<ClinikoOutboundStaffReviewRecords, NativeOutboundFailure> {
    try {
      const sourceShard = shard(c, port), owner = outboundStaffReviewRecordBinding(c);
      if (!sourceShard || !owner || [authority?.allows, authority?.current, authority?.producerAdmitted, effects?.matches, effects?.claimOnce].some(f => typeof f !== "function") ||
          effects.matches(c.scope, owner) !== true) return err({ kind: "invalidConfig" });
      return ok(new ClinikoOutboundStaffReviewRecords(c, sourceShard, owner, authority, port, { authority, effects }));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  static createReadOnly(c: OutboundStaffReviewConfig, authority: OutboundStaffReviewReadAuthority,
    port: typeof fetch = fetch): Result<Pick<ClinikoOutboundStaffReviewRecords, "readRequest">, NativeOutboundFailure> {
    try {
      const sourceShard = shard(c, port), owner = outboundStaffReviewRecordBinding(c);
      if (!sourceShard || !owner || [authority?.allows, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      const records = new ClinikoOutboundStaffReviewRecords(c, sourceShard, owner, authority, port);
      return ok(Object.freeze({ readRequest: records.readRequest.bind(records) }));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  retainRequestOnce(request: OutboundStaffReviewRequest, recallAt: string, signal: AbortSignal): Promise<Result<NativeOutboundRetention, NativeOutboundFailure>> {
    return this.#records.retain(request, recallAt, signal);
  }
  readRequest(binding: NativeOutboundReadBinding, signal: AbortSignal): Promise<Result<NativeOutboundContext<OutboundStaffReviewRequest>, NativeOutboundFailure>> {
    return this.#records.read(binding, signal);
  }
}
