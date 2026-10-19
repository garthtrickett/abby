import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { NativeOutboundRecords } from "./internal/outbound-native-record.ts";
import type { NativeOutboundFailure, NativeOutboundReadBinding, NativeOutboundRetention } from "./internal/outbound-native-record.ts";
import { contactSourceBinding, contactSourceSelection, contactSourceShard } from "./internal/outbound-contact-source-context.ts";
import type { OutboundContactSourceConfig, OutboundContactSourceSelection } from "./internal/outbound-contact-source-context.ts";
import { decodeOutboundContactReview, encodeOutboundContactReview, outboundContactReviewDigest } from "./outbound-contact-review.ts";
import type { OutboundContactReview } from "./outbound-contact-review.ts";
import type { OutboundContactDefinition } from "./outbound-contact-source.ts";

export type OutboundDncRecordConfig = Readonly<{ source: OutboundContactSourceConfig; automationPrincipalRef: string }>;
export type OutboundDncRecordQuery = OutboundContactSourceSelection & Readonly<{
  ownerBinding: string; automationPrincipalRef: string; operation: "retainDncDecision" | "readDncDecision";
  actionRef: string; patientId: string; recallRef?: string; recallAt?: string; includeArchived?: true;
  review?: OutboundContactReview; reviewDigest?: string;
}>;
export type OutboundDncReadAuthority = Readonly<{
  allows(query: OutboundDncRecordQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundDncRecordQuery, signal: AbortSignal): boolean;
}>;
export type OutboundDncWriteAuthority = OutboundDncReadAuthority & Readonly<{
  producerAdmitted(query: OutboundDncRecordQuery, signal: AbortSignal): Promise<boolean>;
}>;

export function outboundDncRecordBinding(config: OutboundDncRecordConfig): string | undefined {
  try {
    if (typeof config.automationPrincipalRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(config.automationPrincipalRef)) return undefined;
    return createHash("sha256").update(JSON.stringify(["abby.outbound-dnc-record.v1",
      contactSourceBinding(contactSourceSelection(config.source)), config.automationPrincipalRef])).digest("hex");
  } catch { return undefined; }
}

/** Number-stop retention records unknown patient consent and blocked DNC.
 * An unverified participant cannot withdraw the patient's personal consent. This does not authenticate a provider report,
 * select a current lineage head, suppress a shared number or authorize reconsent.
 * The owning integration must independently establish all of those decisions.
 * Exact ACK means this decision was retained, never that a call was prevented. */
export class ClinikoOutboundDncRecords {
  readonly #records: NativeOutboundRecords<OutboundContactReview, OutboundDncRecordQuery>;
  readonly #config: OutboundDncRecordConfig;
  private constructor(config: OutboundDncRecordConfig, shard: string, owner: string, definition: OutboundContactDefinition,
    authority: OutboundDncReadAuthority, port: typeof fetch,
    write?: Readonly<{ authority: OutboundDncWriteAuthority; barrier: OutboundEffectBarrier }>) {
    const selection = contactSourceSelection(config.source), automationPrincipalRef = config.automationPrincipalRef;
    this.#config = Object.freeze({ source: Object.freeze({ ...config.source, scope: selection.scope }), automationPrincipalRef });
    const sourceCurrent = definition.currentFor.bind(definition), allows = authority.allows.bind(authority), current = authority.current.bind(authority);
    const producer = write?.authority.producerAdmitted.bind(write.authority);
    const selected = async (signal: AbortSignal) => { const result = await sourceCurrent(selection, signal); return result.ok && result.value === true; };
    this.#records = new NativeOutboundRecords({ ...config.source, scope: selection.scope,
      credentialFingerprint: selection.credentialFingerprint, typeId: selection.contactReviewRecallTypeId }, shard, owner,
    { allows: async (q, signal) => await selected(signal) && await allows(q, signal), current }, port,
    { encode: encodeOutboundContactReview, decode: decodeOutboundContactReview, recordedAt: r => r.reviewedAt, expiresAt: r => r.effectiveUntil },
    q => Object.freeze({ ...selection, ownerBinding: owner, automationPrincipalRef,
      operation: q.method === "POST" ? "retainDncDecision" : "readDncDecision", actionRef: q.actionRef, patientId: q.patientId,
      ...(q.method === "GET" ? { includeArchived: true as const } : {}), ...(q.recallRef ? { recallRef: q.recallRef } : {}),
      ...(q.recallAt ? { recallAt: q.recallAt } : {}), ...(q.record ? { review: q.record, reviewDigest: outboundContactReviewDigest(q.record)! } : {}) }),
    write ? { barrier: write.barrier, producer: async (q, signal) => await selected(signal) && await producer!(q, signal) } : undefined);
  }
  static create(config: OutboundDncRecordConfig, definition: OutboundContactDefinition, authority: OutboundDncWriteAuthority,
    barrier: OutboundEffectBarrier, port: typeof fetch = fetch): Result<ClinikoOutboundDncRecords, NativeOutboundFailure> {
    try {
      const shard = contactSourceShard(config.source, port), owner = outboundDncRecordBinding(config);
      if (!shard || !owner || [definition?.currentFor, authority?.allows, authority?.current, authority?.producerAdmitted,
        barrier?.matches, barrier?.claimOnce].some(f => typeof f !== "function") || barrier.matches(config.source.scope, owner) !== true) return err({ kind: "invalidConfig" });
      return ok(new ClinikoOutboundDncRecords(config, shard, owner, definition, authority, port, { authority, barrier }));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  static createReadOnly(config: OutboundDncRecordConfig, definition: OutboundContactDefinition, authority: OutboundDncReadAuthority,
    port: typeof fetch = fetch): Result<Pick<ClinikoOutboundDncRecords, "readDecision">, NativeOutboundFailure> {
    try {
      const shard = contactSourceShard(config.source, port), owner = outboundDncRecordBinding(config);
      if (!shard || !owner || [definition?.currentFor, authority?.allows, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      return ok(new ClinikoOutboundDncRecords(config, shard, owner, definition, authority, port));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #blocked(review: OutboundContactReview): boolean {
    const s = contactSourceSelection(this.#config.source);
    return review.consent === "unknown" && review.doNotCall === "blocked" && review.reconsentApprovalRef === null &&
      review.reviewerRef === this.#config.automationPrincipalRef && review.contactRecallTypeId === s.contactReviewRecallTypeId &&
      review.policy.version === s.contactPolicyVersion && review.policy.digest === s.contactPolicyDigest;
  }
  async retainDecisionOnce(review: OutboundContactReview, recallAt: string, signal: AbortSignal): Promise<Result<NativeOutboundRetention, NativeOutboundFailure>> {
    try {
      const encoded = encodeOutboundContactReview(review); if (!encoded.ok) return err({ kind: "invalidQuery" });
      const decoded = decodeOutboundContactReview(encoded.value); if (!decoded.ok || !this.#blocked(decoded.value)) return err({ kind: "invalidQuery" });
      return await this.#records.retain(decoded.value, recallAt, signal);
    } catch { return err({ kind: "unavailable" }); }
  }
  async readDecision(binding: NativeOutboundReadBinding, signal: AbortSignal) {
    const found = await this.#records.read(binding, signal);
    if (!found.ok) return found;
    return this.#blocked(found.value.record) ? found : err({ kind: "mismatched" as const });
  }
}
