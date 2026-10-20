// New E2E-419 correction cohorts; source preparation is not execution evidence.
import test from "node:test";
import { stagedMoveJourney } from "../support/staged-class-move-journey.ts";
import type { StagedMoveScenario } from "../support/staged-class-move-journey.ts";

const scenarios: readonly (StagedMoveScenario & { label: string })[] = [
  { label: "ordinal corrected cross-service ordinary", correction: "ordinal", different: true, waits: 3 },
  { label: "date corrected same-case pass", pass: "full", correction: "date", waits: 6 },
  { label: "date corrected cross-case cross-service pass", pass: "transfer", correction: "date", different: true, waits: 6 },
];
for (const scenario of scenarios) test(`E2E-419 compiled signed ${scenario.label} move requires every played phase`, {
  // One new bounded preparation window for correction, plus the ordinary or
  // pass protocol budget. An independent wait-count assertion rejects excess.
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: scenario.waits * 60000 + 60000,
}, () => stagedMoveJourney(scenario));
