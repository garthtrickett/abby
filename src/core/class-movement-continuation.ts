import { classMovementCanContinue, classMovementProgressText, readClassMovementProgress } from "./class-movement-progress.ts";
import type { ClassMovementProgress, ClassMovementStage } from "./class-movement-progress.ts";

/** An opaque reference to one live host owner, not a serialized checkpoint or
 * permission to send. Consent evidence and private verification are separate. */
export type PendingClassMovementStage = Readonly<{
  ref: string; contractVersion: string; ordinal: number; stage: ClassMovementStage;
}>;
export type ClassMovementState = Readonly<{ progress: ClassMovementProgress }> & (
  | Readonly<{ outcome: "pending"; continuation: PendingClassMovementStage }>
  | Readonly<{ outcome: "moved" | "restored" }>
  | Readonly<{ outcome: "needsReview"; interruptedStage?: ClassMovementStage }>
);
export type ClassMovementReceipt = Readonly<{ kind: "classMovement"; actionKey: string; progress: ClassMovementProgress }> & (
  | Readonly<{ outcome: "pending"; continuation: PendingClassMovementStage }>
  | Readonly<{ outcome: "moved"; hostRef: string }>
  | Readonly<{ outcome: "restored" | "needsReview" }>
);
export type ClassMovementReceiptRecord = Readonly<{ movement: ClassMovementState; hostRef?: string }>;
export type ClassMovementSummary = Readonly<{ outcome: ClassMovementState["outcome"]; progress: ClassMovementProgress }>;

const following: Readonly<Record<ClassMovementStage, readonly ClassMovementStage[]>> = {
  replacement: ["replacement", "original"],
  original: ["original", "association", "compensation"],
  association: ["association"],
  compensation: ["compensation", "compensationInspection"],
  compensationInspection: ["compensationInspection"],
};
const reference = /^class-move-stage:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const version = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function dataRecord(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== "string" || !allowed.includes(key)) || required.some(key => !Object.hasOwn(descriptors, key))) return undefined;
    const record: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key as string]!;
      if (!Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) return undefined;
      record[key as string] = descriptor.value;
    }
    return record;
  } catch { return undefined; }
}

/** Fixed observations for result readers. Resume references, consent and
 * private owner state never cross this projection. */
export function classMovementSummary(value: unknown): ClassMovementSummary | undefined {
  const read = dataRecord(value, ["outcome", "progress", "continuation", "interruptedStage"], ["outcome", "progress"]);
  if (!read || typeof read.outcome !== "string" || !["pending", "moved", "restored", "needsReview"].includes(read.outcome)) return undefined;
  const progress = readClassMovementProgress(read.progress);
  if (!progress) return undefined;
  if (read.outcome === "moved" && (progress.original !== "inspectedCancelled" || progress.replacement !== "inspectedActive" ||
      progress.caseAssociation !== "inspectedLinked" && progress.caseAssociation !== "notApplicable")) return undefined;
  if (read.outcome === "restored" && (progress.original !== "notSent" && progress.original !== "inspectedActive" ||
      progress.replacement !== "inspectedCancelled" || progress.caseAssociation !== "unlinked" && progress.caseAssociation !== "notApplicable")) return undefined;
  return Object.freeze({ outcome: read.outcome as ClassMovementState["outcome"], progress });
}

function pendingStage(value: unknown, progress: ClassMovementProgress, previous?: ClassMovementState): PendingClassMovementStage | undefined {
  const fields = ["ref", "contractVersion", "ordinal", "stage"];
  const read = dataRecord(value, fields, fields);
  if (!read || typeof read.ref !== "string" || !reference.test(read.ref) || typeof read.contractVersion !== "string" || !version.test(read.contractVersion) ||
      typeof read.ordinal !== "number" || !Number.isSafeInteger(read.ordinal) || read.ordinal < 1 || read.ordinal > 20 ||
      typeof read.stage !== "string" || !Object.hasOwn(following, read.stage)) return undefined;
  const stage = read.stage as ClassMovementStage;
  if (!classMovementCanContinue(progress, stage)) return undefined;
  if (previous) {
    if (previous.outcome !== "pending" || read.ref === previous.continuation.ref || read.contractVersion !== previous.continuation.contractVersion ||
        read.ordinal !== previous.continuation.ordinal + 1 || !following[previous.continuation.stage].includes(stage) ||
        (previous.progress.caseAssociation === "notApplicable") !== (progress.caseAssociation === "notApplicable")) return undefined;
  } else if (read.ordinal !== 1 || stage !== "replacement" && stage !== "original") return undefined;
  return Object.freeze({ ref: read.ref, contractVersion: read.contractVersion, ordinal: read.ordinal, stage });
}

/** Keep observed native facts if control metadata is invalid; retire the next
 * stage and require review instead of discarding the observations or granting
 * another send. No provider effect can be reconstructed from this record. */
export function readClassMovementReceipt(value: unknown, previous?: ClassMovementState, allowContinuation = true): ClassMovementReceiptRecord | undefined {
  const read = dataRecord(value, ["kind", "actionKey", "progress", "outcome", "continuation", "hostRef"], ["kind", "actionKey", "progress", "outcome"]);
  if (!read || read.kind !== "classMovement" || typeof read.actionKey !== "string" || !read.actionKey || read.actionKey.length > 512 || /[\u0000-\u001f\u007f]/.test(read.actionKey)) return undefined;
  const progress = readClassMovementProgress(read.progress);
  if (!progress) return undefined;
  const review = (): ClassMovementReceiptRecord => ({ movement: Object.freeze({ progress, outcome: "needsReview" }) });
  if (read.outcome === "pending" && allowContinuation && !Object.hasOwn(read, "hostRef")) {
    const continuation = pendingStage(read.continuation, progress, previous);
    return continuation ? { movement: Object.freeze({ progress, outcome: "pending", continuation }) } : review();
  }
  const completedStage = previous?.outcome === "pending" && (
    previous.continuation.stage === "association" && previous.progress.caseAssociation === "unlinked" && progress.caseAssociation === "inspectedLinked" ||
    previous.continuation.stage === "original" && previous.progress.caseAssociation === "notApplicable" && progress.caseAssociation === "notApplicable"
  );
  if (read.outcome === "moved" && completedStage &&
      !Object.hasOwn(read, "continuation") && progress.original === "inspectedCancelled" && progress.replacement === "inspectedActive" &&
      typeof read.hostRef === "string" && read.hostRef.trim() === read.hostRef &&
      read.hostRef.length > 0 && read.hostRef.length <= 256 && !/[\u0000-\u001f\u007f]/.test(read.hostRef))
    return { movement: Object.freeze({ progress, outcome: "moved" }), hostRef: read.hostRef };
  if (read.outcome === "restored" && previous?.outcome === "pending" && previous.continuation.stage === "compensationInspection" &&
      !Object.hasOwn(read, "continuation") && !Object.hasOwn(read, "hostRef") &&
      (progress.original === "notSent" || progress.original === "inspectedActive") && progress.replacement === "inspectedCancelled" &&
      (progress.caseAssociation === "unlinked" && previous.progress.caseAssociation === "unlinked" ||
        progress.caseAssociation === "notApplicable" && previous.progress.caseAssociation === "notApplicable"))
    return { movement: Object.freeze({ progress, outcome: "restored" }) };
  return review();
}

/** Ending, revocation or an untyped leg acknowledgement must retire pending
 * stage metadata while retaining already observed native effects. */
export function stopClassMovement(movement: ClassMovementState): ClassMovementState {
  return movement.outcome === "pending" ? Object.freeze({ progress: movement.progress, outcome: "needsReview", interruptedStage: movement.continuation.stage }) : movement;
}

/** Call only after an effect may have sent. A prior inspection is not proof
 * that the affected leg stayed unchanged during an unacknowledged stage. A
 * retired stage name preserves this fact without retaining a resume reference. */
export function uncertainClassMovement(movement: ClassMovementState): ClassMovementState {
  if (movement.outcome !== "pending" && movement.outcome !== "needsReview") return movement;
  const stage = movement.outcome === "pending" ? movement.continuation.stage : movement.interruptedStage;
  let progress = movement.progress;
  if (stage === "replacement") progress = Object.freeze({ ...progress, replacement: "uncertain",
    caseAssociation: progress.caseAssociation === "notApplicable" ? "notApplicable" : "uncertain" });
  if (stage === "original") progress = Object.freeze({ ...progress, original: "uncertain" });
  if (stage === "association") progress = Object.freeze({ ...progress, caseAssociation: "uncertain" });
  if (stage === "compensation") progress = Object.freeze({ ...progress, replacement: "uncertain" });
  return Object.freeze({ progress, outcome: "needsReview", ...(stage ? { interruptedStage: stage } : {}) });
}

export function classMovementOutcomeText(movement: ClassMovementState): string {
  if (movement.outcome === "moved") return "Your class move is confirmed.";
  if (movement.outcome === "restored") return "The class move was not completed. The original attendance was inspected as active and the replacement attendance as cancelled.";
  const progress = classMovementProgressText(movement.progress);
  return movement.outcome === "pending" ? `${progress} I still need a fresh, separate confirmation for the next stage.`
    : `${progress} The clinic needs to review this before any further change.`;
}
