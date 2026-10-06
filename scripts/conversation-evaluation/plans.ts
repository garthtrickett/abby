import { readFile } from "node:fs/promises";

export type Candidate = Readonly<{ id: string; pattern: string; priority: string; coverage: string;
  setup: string; callerTurns: string[]; requiredBehavior: string[]; forbiddenBehavior: string[] }>;
export type Stage = "initial" | "book" | "menu" | "proposal" | "committed" | "uncertain" |
  "cancel" | "cancelTarget" | "cancelCommitted" | "move" | "moveOffers" | "staff" | "staffUncertain" | "enquiry" | "pendingLookup";
export type Expectation = "clarify" | "cancelProposal" | "spokenChoice" | "revisedProposal" | "revisedDate" |
  "identityDenied" | "requestBoundary" | "bookingHorizon" | "publicInformation" | "staffPurpose" | "presence" | "missedCall" | "outcome" | "notificationOutcome" | "human" | "readOnly" | "constraints" | "publicFacts" | "boundedSearch" | "urgent" | "unsupported";
export type Plan = Readonly<{ stage: Stage; expectation: Expectation; missingSetup?: string }>;

/** These are explicit fixture contracts, not model answers. An absent production
 * capability remains a setup gap even when its fallback safely sends nothing. */
export const plans: Readonly<Record<string, Plan>> = {
  "CCP-001": { stage: "cancelTarget", expectation: "clarify" },
  "CCP-002": { stage: "cancelTarget", expectation: "cancelProposal" },
  "CCP-003": { stage: "proposal", expectation: "revisedProposal" },
  "CCP-004": { stage: "book", expectation: "revisedDate" },
  "CCP-005": { stage: "menu", expectation: "spokenChoice" },
  "CCP-006": { stage: "menu", expectation: "clarify" },
  "CCP-007": { stage: "menu", expectation: "clarify" },
  "CCP-008": { stage: "proposal", expectation: "clarify" },
  "CCP-009": { stage: "initial", expectation: "identityDenied" },
  "CCP-010": { stage: "cancelTarget", expectation: "clarify" },
  "CCP-011": { stage: "book", expectation: "constraints" },
  "CCP-012": { stage: "move", expectation: "requestBoundary" },
  "CCP-013": { stage: "initial", expectation: "requestBoundary" },
  "CCP-014": { stage: "initial", expectation: "unsupported" },
  "CCP-015": { stage: "initial", expectation: "urgent" },
  "CCP-016": { stage: "initial", expectation: "human" },
  "CCP-017": { stage: "staff", expectation: "human" },
  "CCP-018": { stage: "staffUncertain", expectation: "human" },
  "CCP-019": { stage: "enquiry", expectation: "readOnly" },
  "CCP-020": { stage: "cancelCommitted", expectation: "outcome" },
  "CCP-021": { stage: "uncertain", expectation: "outcome" },
  "CCP-022": { stage: "committed", expectation: "notificationOutcome" },
  "CCP-023": { stage: "book", expectation: "human" },
  "CCP-024": { stage: "initial", expectation: "missedCall" },
  "CCP-025": { stage: "book", expectation: "constraints" },
  "CCP-026": { stage: "book", expectation: "boundedSearch" },
  "CCP-027": { stage: "menu", expectation: "constraints" },
  "CCP-028": { stage: "menu", expectation: "boundedSearch" },
  "CCP-029": { stage: "moveOffers", expectation: "bookingHorizon" },
  "CCP-030": { stage: "initial", expectation: "publicInformation" },
  "CCP-031": { stage: "moveOffers", expectation: "unsupported" },
  "CCP-032": { stage: "initial", expectation: "publicFacts" },
  "CCP-033": { stage: "initial", expectation: "publicInformation" },
  "CCP-034": { stage: "initial", expectation: "staffPurpose" },
  "CCP-035": { stage: "initial", expectation: "staffPurpose" },
  "CCP-036": { stage: "cancel", expectation: "cancelProposal" },
  "CCP-037": { stage: "move", expectation: "requestBoundary" },
  "CCP-038": { stage: "cancelTarget", expectation: "unsupported" },
  "CCP-039": { stage: "initial", expectation: "requestBoundary" },
  "CCP-040": { stage: "initial", expectation: "staffPurpose" },
  "CCP-041": { stage: "initial", expectation: "requestBoundary" },
  "CCP-042": { stage: "menu", expectation: "clarify" },
  "CCP-043": { stage: "proposal", expectation: "clarify" },
  "CCP-044": { stage: "pendingLookup", expectation: "presence" },
  "CCP-045": { stage: "committed", expectation: "outcome" },
};

export async function candidates(): Promise<Candidate[]> {
  const corpus = JSON.parse(await readFile(new URL("../../eval/clinic-conversation-candidates-v1.json", import.meta.url), "utf8"));
  if (corpus.status !== "candidate-not-executed" || !Array.isArray(corpus.cases)) throw new Error("invalid candidate corpus");
  const cases = corpus.cases as Candidate[];
  if (cases.length !== 45 || new Set(cases.map(item => item.id)).size !== cases.length ||
      cases.some(item => !plans[item.id] || !item.callerTurns.length || item.callerTurns.some(text => typeof text !== "string" || !text.trim())) ||
      Object.keys(plans).some(id => !cases.some(item => item.id === id))) throw new Error("corpus and fixture plans differ");
  return cases;
}
