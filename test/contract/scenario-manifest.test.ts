import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { capabilityCatalogue } from "../../src/reference/capability-catalogue.ts";

type Evidence = { status: "planned" | "passed"; testFiles: string[] };
type Scenario = {
  id: string;
  requirements: string[];
  fixtureFamily: string;
  fixtureState: "planned" | "textImplemented" | "syntheticImplemented" | "fullImplemented";
  intendedCompositions: string[];
  earliestPhase: number;
  providerProfile: string;
  fullCallEvidence: Evidence;
  textEvidence?: Evidence;
  syntheticVoiceEvidence?: Evidence;
  observableAssertions?: Readonly<{ caller: string; fault: string; privacy: string }>;
};
type Manifest = {
  version: string;
  source: string;
  fixtureIdPattern: string;
  capabilityMappings: Record<string, string[]>;
  settingMappings: Record<string, string[]>;
  scenarios: Scenario[];
};

const root = new URL("../../", import.meta.url);
function read(path: string): string { return readFileSync(new URL(path, root), "utf8"); }

test("scenario manifest tracks every designed E2E and never promotes a planned fixture to full-call evidence", () => {
  const manifest = JSON.parse(read("phase-0/SCENARIO_MANIFEST.json")) as Manifest;
  const design = read("TECHNICAL_DESIGN.md");
  const rows = [...design.matchAll(/^\| `(E2E-\d{3})` \| (.*?) \| (FR-\d{2}(?:, FR-\d{2})*) \|$/gm)];
  assert.equal(manifest.version, "1.48");
  assert.equal(manifest.source, "TECHNICAL_DESIGN.md Section 11");
  assert.equal(manifest.fixtureIdPattern, "fixture-{lowercase scenario id}");
  assert.equal(rows.length, 238);
  assert.deepEqual(manifest.scenarios.map(scenario => scenario.id),
    Array.from({ length: 238 }, (_, index) => `E2E-${String(index + 1).padStart(3, "0")}`));
  const ids = new Set(manifest.scenarios.map(scenario => scenario.id));
  for (const [index, scenario] of manifest.scenarios.entries()) {
    const row = rows[index]!;
    assert.equal(scenario.id, row[1]);
    assert.ok(row[2]!.length > 20);
    assert.deepEqual(scenario.requirements, row[3]!.split(", "));
    assert.match(scenario.fixtureFamily, /^[a-z][a-z-]+$/);
    assert.ok([1, 2, 3, 4, 5].includes(scenario.earliestPhase));
    assert.ok(scenario.intendedCompositions.length > 0);
    assert.ok(scenario.intendedCompositions.every(composition =>
      ["standalone", "embedded", "cutover"].includes(composition)));
    assert.equal(new Set(scenario.intendedCompositions).size, scenario.intendedCompositions.length);
    assert.ok(["reference", "cliniko"].includes(scenario.providerProfile));
    if (index >= 170) {
      assert.ok(scenario.observableAssertions);
      for (const observation of Object.values(scenario.observableAssertions)) {
        assert.ok(typeof observation === "string" && observation.length > 20);
      }
    }
    for (const evidence of [scenario.fullCallEvidence, scenario.textEvidence,
      scenario.syntheticVoiceEvidence].filter(Boolean) as Evidence[]) {
      assert.ok(["planned", "passed"].includes(evidence.status));
      assert.equal(evidence.status === "planned", evidence.testFiles.length === 0);
      for (const path of evidence.testFiles) {
        assert.match(path, /^test\/[a-z-]+\/[a-z0-9-]+\.(?:test|spec)\.ts$/);
        if (path.endsWith(".spec.ts")) assert.ok(path.startsWith("test/browser/"));
        assert.match(read(path), new RegExp(scenario.id));
      }
    }
    if (scenario.fullCallEvidence.status === "passed") {
      assert.equal(scenario.fixtureState, "fullImplemented");
      assert.ok(scenario.fullCallEvidence.testFiles.every(path => path.startsWith("test/e2e/")));
    } else if (scenario.syntheticVoiceEvidence?.status === "passed") {
      assert.equal(scenario.fixtureState, "syntheticImplemented");
    } else if (scenario.textEvidence?.status === "passed") {
      assert.equal(scenario.fixtureState, "textImplemented");
    } else assert.equal(scenario.fixtureState, "planned");
  }
  for (let number = 1; number <= 22; number += 1) {
    const requirement = `FR-${String(number).padStart(2, "0")}`;
    assert.ok(manifest.scenarios.some(scenario => scenario.requirements.includes(requirement)), requirement);
  }
  assert.deepEqual(Object.keys(manifest.capabilityMappings).sort(), Object.keys(capabilityCatalogue).sort());
  assert.deepEqual(Object.keys(manifest.settingMappings).sort(),
    ["appointments.booking.enabled", "automation.enabled", "availability.sevenDay.enabled", "calls.writes.stop",
      "clinic.availability.approval", "knowledge.approval", "routing.afterHoursMode", "routing.urgentResponse"].sort());
  for (const mappings of [manifest.capabilityMappings, manifest.settingMappings]) {
    for (const scenarios of Object.values(mappings)) {
      assert.ok(scenarios.length > 0);
      assert.equal(new Set(scenarios).size, scenarios.length);
      assert.ok(scenarios.every(id => ids.has(id)));
    }
  }
  const hasExecutableEvidence = (id: string): boolean => {
    const scenario = manifest.scenarios.find(item => item.id === id);
    return !!scenario && [scenario.fullCallEvidence, scenario.textEvidence, scenario.syntheticVoiceEvidence]
      .some(evidence => evidence?.status === "passed" && evidence.testFiles.length > 0);
  };
  for (const [id, descriptor] of Object.entries(capabilityCatalogue)) {
    if (descriptor.effect !== "policyChange") continue;
    assert.ok(manifest.capabilityMappings[id]?.some(hasExecutableEvidence),
      `${id} must map to a passing executable scenario before publication`);
  }
  for (const [setting, scenarios] of Object.entries(manifest.settingMappings)) {
    assert.ok(scenarios.some(hasExecutableEvidence),
      `${setting} must have a passing text, browser, voice or full-call scenario`);
  }
});
