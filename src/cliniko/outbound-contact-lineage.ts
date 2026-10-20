import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { contactReviewInstant, decodeOutboundContactReview, encodeOutboundContactReview, outboundContactReviewDigest } from "./outbound-contact-review.ts";
import type { OutboundContactReview } from "./outbound-contact-review.ts";

export type OutboundContactHead = Readonly<{ actionRef: string; digest: string }>;
type Evidence = Readonly<{ head: OutboundContactReview; reconsentApprovals: readonly string[]; disposition: "eligibleEvidence" | "blocked" }>;
type Failure = Readonly<{ kind: "invalidContactHistory" }>;
const invalid = () => err({ kind: "invalidContactHistory" as const });
const eligible = (r: OutboundContactReview) => r.consent === "granted" && r.doNotCall === "clear";
const subject = (r: OutboundContactReview) => JSON.stringify([r.scope.tenantId, r.scope.clinicId, r.scope.locationId, r.businessId,
  r.credentialFingerprint, r.contactRecallTypeId, r.policy.version, r.policy.digest, r.patientId]);

/** Evaluate a complete, independently selected patient history. Caller must first
 * establish current source completeness, exact head selection, read grants and
 * each reported reconsent approval. This pure evidence is never launch authority.
 * Unordered native rows are accepted; timestamps/native IDs never choose a head. */
export function evaluateOutboundContactHistory(input: readonly OutboundContactReview[], selected: OutboundContactHead, at: string): Result<Evidence, Failure> {
  try {
    if (!Array.isArray(input) || input.length < 1 || input.length > 50 || !contactReviewInstant(at) ||
      !selected || Object.keys(selected).sort().join(",") !== "actionRef,digest") return invalid();
    const reviews: OutboundContactReview[] = [];
    for (const item of input) {
      const encoded = encodeOutboundContactReview(item); if (!encoded.ok) return invalid();
      const decoded = decodeOutboundContactReview(encoded.value); if (!decoded.ok) return invalid(); reviews.push(decoded.value);
    }
    const head = reviews.find(r => r.actionRef === selected.actionRef);
    if (!head || outboundContactReviewDigest(head) !== selected.digest || reviews.length !== head.revision) return invalid();
    reviews.sort((a, b) => a.revision - b.revision);
    const ids = new Set<string>(), reconsentApprovals: string[] = [];
    for (let i = 0; i < reviews.length; i++) {
      const r = reviews[i]!, previous = reviews[i - 1];
      if (r.revision !== i + 1 || subject(r) !== subject(head)) return invalid();
      for (const ref of [r.actionRef, r.approvalRef, ...(r.reconsentApprovalRef ? [r.reconsentApprovalRef] : [])]) {
        if (ids.has(ref)) return invalid(); ids.add(ref);
      }
      if (previous) {
        if (r.predecessor?.actionRef !== previous.actionRef || r.predecessor.digest !== outboundContactReviewDigest(previous) ||
          r.reviewedAt < previous.reviewedAt || r.effectiveFrom < previous.effectiveFrom) return invalid();
        const needsReconsent = eligible(r) && (!eligible(previous) || r.recipient.number !== previous.recipient.number ||
          r.purposes.join(",") !== previous.purposes.join(","));
        if (needsReconsent && !r.reconsentApprovalRef || r.reconsentApprovalRef && !needsReconsent) return invalid();
      }
      if (r.reconsentApprovalRef) reconsentApprovals.push(r.reconsentApprovalRef);
    }
    if (reviews.at(-1)!.actionRef !== head.actionRef) return invalid();
    const current = head.effectiveFrom <= at && at < head.effectiveUntil;
    return ok(Object.freeze({ head, reconsentApprovals: Object.freeze(reconsentApprovals),
      disposition: current && eligible(head) ? "eligibleEvidence" : "blocked" }));
  } catch { return invalid(); }
}
