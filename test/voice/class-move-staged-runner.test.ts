// E2E-419: actual compiled signed voice, separate native phases and private renewal.
import test from "node:test";
import { stagedMoveJourney } from "../support/staged-class-move-journey.ts";
import type { StagedMoveScenario } from "../support/staged-class-move-journey.ts";

const scenarios: readonly (StagedMoveScenario & { label: string })[] = [
  { label: "ordinary", waits: 2 },
  { label: "maximum-history cross-case pass", pass: "transfer", different: true, maximum: true, waits: 5 },
];
for (const scenario of scenarios) test(`E2E-419 compiled signed ${scenario.label} move requires every played phase`, {
  // Original ordinary180s and maximum-history360s deadlines remain unchanged.
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: scenario.waits * 60000 + 60000,
}, () => stagedMoveJourney(scenario));
