import { createHash } from "node:crypto";
import type { ClassApproval } from "./owner-file-class-policy.ts";
import { OwnerFileClassMovePolicy } from "./owner-file-class-move-policy.ts";
import type { ClassMoveApproval } from "./owner-file-class-move-policy.ts";
import type { ClassMovementPass } from "../cliniko/review-request.ts";

const signature = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Exact captured policy identity shared by live consent and cold staff review.
 * This describes a contract; it supplies no patient or mutation permission. */
export function classMovePolicyVersion(source: ClassApproval, destination: ClassApproval, move: ClassMoveApproval): string {
  return signature([source, destination, move]);
}

export function classMoveContract(source: ClassApproval, destination: ClassApproval, move: ClassMoveApproval,
  startsAt: string, at: string, pass?: ClassMovementPass): Readonly<{ version: string; approvedText: string }> | undefined {
  const fee = OwnerFileClassMovePolicy.termsFor(move, startsAt, at);
  if (!fee || (move.membership === "nativeCaseSessions") !== !!pass) return undefined;
  const passTerms = pass ? OwnerFileClassMovePolicy.passTermsFor(move, pass) : undefined;
  if (pass && !passTerms) return undefined;
  const approvedText = "Move only your " + source.className + " attendance. " + fee.approvedText + " " +
    (passTerms ? passTerms.approvedText + " " : "") + move.recoveryTerms.approvedText;
  return approvedText.length <= 500 ? {
    version: "class-move:" + signature([classMovePolicyVersion(source, destination, move), fee.version,
      ...(pass ? [passTerms!.version, pass] : [])]), approvedText,
  } : undefined;
}
