/** Public observations only. Native identifiers, proof references and stage
 * capabilities stay with the live host owner. None of these observations is
 * permission to perform another operation or evidence of a completed move. */
export type ClassMovementMutationState = "notSent" | "uncertain" | "inspectedActive" | "inspectedCancelled";
export type ClassMovementAssociationState = "notApplicable" | "notSent" | "unlinked" | "uncertain" | "inspectedLinked";
export type ClassMovementStage = "replacement" | "original" | "association" | "associationInspection" | "compensation" | "compensationInspection";
export type ClassMovementProgress = Readonly<{
  original: ClassMovementMutationState;
  replacement: ClassMovementMutationState;
  caseAssociation: ClassMovementAssociationState;
}>;

const mutations: readonly unknown[] = ["notSent", "uncertain", "inspectedActive", "inspectedCancelled"];
const associations: readonly unknown[] = ["notApplicable", "notSent", "unlinked", "uncertain", "inspectedLinked"];

/** Copy fixed observations into a public record. Accept facts even when they
 * need review; do not assume external actors could not have changed them.
 * Accessors, hidden properties and native private fields are never copied. */
export function readClassMovementProgress(value: unknown): ClassMovementProgress | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
    if (keys.length !== 3 || keys.some(key => typeof key !== "string") ||
        keys.sort().join(",") !== "caseAssociation,original,replacement") return undefined;
    for (const key of keys) {
      const field = fields[key as string]!;
      if (!Object.hasOwn(field, "value") || field.enumerable !== true) return undefined;
    }
    const original: unknown = fields.original!.value, replacement: unknown = fields.replacement!.value,
      caseAssociation: unknown = fields.caseAssociation!.value;
    return mutations.includes(original) && mutations.includes(replacement) && associations.includes(caseAssociation)
      ? Object.freeze({ original: original as ClassMovementMutationState, replacement: replacement as ClassMovementMutationState,
        caseAssociation: caseAssociation as ClassMovementAssociationState }) : undefined;
  } catch { return undefined; }
}

/** A necessary safety check, never stage authority. The exact next stage also
 * needs its private live-owner capability, current permission and separately
 * played confirmation. In particular, an uncertain write cannot authorize a
 * replay or compensation. Inspection is distinct from another mutation. */
export function classMovementCanContinue(progress: unknown, stage: ClassMovementStage): boolean {
  const observed = readClassMovementProgress(progress);
  if (!observed) return false;
  switch (stage) {
    case "replacement":
      return observed.original === "notSent" && observed.replacement === "notSent" && (observed.caseAssociation === "notSent" || observed.caseAssociation === "notApplicable");
    case "original":
    case "compensation":
      return observed.original === "notSent" && observed.replacement === "inspectedActive" && (observed.caseAssociation === "unlinked" || observed.caseAssociation === "notApplicable");
    case "association":
      return observed.original === "inspectedCancelled" && observed.replacement === "inspectedActive" && observed.caseAssociation === "unlinked";
    case "associationInspection":
      return observed.original === "inspectedCancelled" && observed.replacement === "inspectedActive" && observed.caseAssociation === "uncertain";
    case "compensationInspection":
      return observed.original === "notSent" && observed.replacement === "uncertain" && (observed.caseAssociation === "unlinked" || observed.caseAssociation === "notApplicable");
    default: return false;
  }
}

const originalText: Readonly<Record<ClassMovementMutationState, string>> = {
  notSent: "I have not sent a cancellation for the original attendance.",
  uncertain: "I cannot confirm whether the original attendance was cancelled.",
  inspectedActive: "The original attendance was last inspected as active.",
  inspectedCancelled: "The original attendance was last inspected as cancelled.",
};
const replacementText: Readonly<Record<ClassMovementMutationState, string>> = {
  notSent: "I have not sent the replacement attendance.",
  uncertain: "I cannot confirm the replacement attendance status.",
  inspectedActive: "The replacement attendance was last inspected as active.",
  inspectedCancelled: "The replacement attendance was last inspected as cancelled.",
};
const associationText: Readonly<Record<ClassMovementAssociationState, string>> = {
  notApplicable: "This move has no membership case association stage.",
  notSent: "The membership association is not confirmed.",
  unlinked: "The replacement was last inspected without its new membership association.",
  uncertain: "I cannot confirm whether the membership association was changed.",
  inspectedLinked: "The membership association was inspected.",
};

/** A partial receipt never says the complete move succeeded, failed without a
 * change, charged money, or reached a member of staff. Inspection wording is
 * historical: it does not promise that native state stayed unchanged. */
export function classMovementProgressText(progress: unknown): string {
  const observed = readClassMovementProgress(progress);
  if (!observed) return "I cannot confirm the class move or its current attendance status. The clinic needs to review it before any further change.";
  return ["The overall class move is not confirmed.", originalText[observed.original],
    replacementText[observed.replacement], associationText[observed.caseAssociation]].join(" ");
}
