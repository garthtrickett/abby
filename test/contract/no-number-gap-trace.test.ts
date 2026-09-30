import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

type Gap = {
  id: string;
  capability: string;
  priority: string;
  positive: string;
  negative: string;
  failure: string;
  fixture: string;
  gate: string;
};
type Trace = {
  version: string;
  caseIdPattern: string;
  fixtureVersion: string;
  fixtureBase: Record<string, string>;
  gaps: Gap[];
};
type Manifest = { scenarios: Array<{ id: string }> };
type CaseContract = {
  id: string;
  policy: string;
  privacy: string;
  P: string[];
  N: string[];
  F: string[];
};
type EdgeCase = {
  id: string;
  gapId: string;
  scenario: string;
  intent: string;
  input: string;
  composition: string;
  allowedCallerClaim: string;
  hostEffect: string;
  fallback: string;
  privacy: string;
};
type CaseContracts = {
  version: string;
  columns: string[];
  callerIntents: Record<string, string>;
  edgeCases: EdgeCase[];
  contracts: CaseContract[];
};

const root = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");

function comparisonRows(section: string, source: string): Array<{ capability: string; priority: string }> {
  const text = source.split(`## ${section}\n`, 2)[1]?.split("\n## ", 1)[0];
  assert.ok(text, `missing ${section}`);
  return text.split("\n").filter(line => line.startsWith("| ")).map(line => {
    const cells = line.slice(1, -1).split("|").map(cell => cell.trim());
    return { capability: cells[0]!, priority: cells.at(-1)! };
  }).filter(row => /^P[01]\b/.test(row.priority));
}

test("every P0/P1 comparison gap has versioned case inputs, outcomes, and scenario targets", () => {
  const trace = JSON.parse(read("phase-0/NO_NUMBER_GAP_TRACE.json")) as Trace;
  const expectations = JSON.parse(read("phase-0/NO_NUMBER_CASE_CONTRACTS.json")) as CaseContracts;
  const manifest = JSON.parse(read("phase-0/SCENARIO_MANIFEST.json")) as Manifest;
  const comparisonFile = readdirSync(root).filter(name => name.endsWith("_CORE_CLINIKO_GAP_ANALYSIS.md"));
  assert.equal(comparisonFile.length, 1);
  const comparison = read(comparisonFile[0]!);
  const expected = [
    ...comparisonRows("Core receptionist gap", comparison).map((row, index) => ({
      ...row, id: `CORE-${String(index + 1).padStart(2, "0")}`
    })),
    ...comparisonRows("Cliniko integration gap", comparison).map((row, index) => ({
      ...row, id: `CLINIKO-${String(index + 1).padStart(2, "0")}`
    }))
  ];
  assert.equal(trace.version, "1.0");
  assert.equal(trace.caseIdPattern, "NN-{gap id}-{P|N|F}");
  assert.match(trace.fixtureVersion, /^no-number-\d{4}-\d{2}-\d{2}$/);
  for (const field of ["tenant", "clinic", "location", "caller", "policy", "privacy"]) {
    assert.ok(trace.fixtureBase[field]?.length, `missing base fixture ${field}`);
  }
  assert.equal(expected.length, 28);
  assert.deepEqual(trace.gaps.map(({ id, capability, priority }) => ({ id, capability, priority })), expected);
  assert.equal(expectations.version, "1.0");
  assert.deepEqual(expectations.columns, ["composition", "allowedCallerClaim", "hostEffect", "fallback"]);
  assert.deepEqual(Object.keys(expectations.callerIntents), trace.gaps.map(gap => gap.id));
  assert.deepEqual(expectations.contracts.map(contract => contract.id), trace.gaps.map(gap => gap.id));
  const scenarioIds = new Set(manifest.scenarios.map(scenario => scenario.id));
  const caseIds = new Set<string>();
  for (const [gapIndex, gap] of trace.gaps.entries()) {
    assert.ok(gap.gate.length > 35, `missing gate for ${gap.id}`);
    const contract = expectations.contracts[gapIndex]!;
    assert.ok(expectations.callerIntents[gap.id]!.length > 20, `missing caller intent for ${gap.id}`);
    assert.ok(contract.policy.length > 20, `missing setting policy for ${gap.id}`);
    assert.ok(contract.privacy.length > 20, `missing privacy assertion for ${gap.id}`);
    const fixtures = gap.fixture.split("; ");
    assert.equal(fixtures.length, 3, `expected three fixture inputs for ${gap.id}`);
    for (const [index, [kind, suffix]] of ([
      ["positive", "P"], ["negative", "N"], ["failure", "F"]
    ] as const).entries()) {
      const caseId = `NN-${gap.id}-${suffix}`;
      assert.ok(!caseIds.has(caseId));
      caseIds.add(caseId);
      assert.ok(fixtures[index]!.length > 8, `missing input for ${caseId}`);
      assert.ok(scenarioIds.has(gap[kind]), `unknown scenario for ${caseId}: ${gap[kind]}`);
      const claims = contract[suffix];
      assert.equal(claims.length, 4, `incomplete expected output for ${caseId}`);
      assert.ok(["standalone", "embedded", "both"].includes(claims[0]!), `invalid composition for ${caseId}`);
      for (const expectation of claims.slice(1)) {
        assert.ok(expectation.length > 20, `missing expected claim, effect, or fallback for ${caseId}`);
      }
    }
  }
  assert.equal(caseIds.size, 84);
  assert.deepEqual(expectations.edgeCases.map(edge => edge.id),
    Array.from({ length: 8 }, (_, index) => `NN-EDGE-${String(index + 1).padStart(2, "0")}`));
  for (const edge of expectations.edgeCases) {
    assert.ok(!caseIds.has(edge.id));
    assert.ok(trace.gaps.some(gap => gap.id === edge.gapId), `unknown gap for ${edge.id}`);
    assert.ok(scenarioIds.has(edge.scenario), `unknown edge scenario for ${edge.id}`);
    assert.ok(["standalone", "embedded", "both"].includes(edge.composition));
    for (const field of ["intent", "input", "allowedCallerClaim", "hostEffect", "fallback", "privacy"] as const) {
      assert.ok(edge[field].length > 20, `missing ${field} for ${edge.id}`);
    }
  }
});
