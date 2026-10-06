import assert from "node:assert/strict";
import test from "node:test";
import { candidates, plans } from "../../scripts/conversation-evaluation/plans.ts";
import { runCase } from "../../scripts/conversation-evaluation/run-case.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

test("E2E-307 conversation baseline distinguishes trusted spoken selection and missing setups from live model understanding", { timeout: 90_000 }, async () => {
  const corpus = await candidates();
  assert.equal(corpus.length, 45);
  await withDisposablePostgres(async db => {
    const ids = ["CCP-005", "CCP-006", "CCP-017", "CCP-021"];
    const results = await Promise.all(ids.map(async id => {
      const item = corpus.find(candidate => candidate.id === id)!;
      return runCase(db, item, plans[id]!, { mode: "scripted", model: "synthetic-baseline", apiKey: "synthetic-key" });
    }));
    for (const result of results) {
      assert.equal(result.status, "executed"); assert.equal(result.mode, "scripted"); assert.equal(result.requests, 0);
      assert.equal(result.writesAfter, result.writesBefore);
      assert.ok(result.checks.filter(check => check.id !== "conversation-observation").every(check => check.pass));
      assert.equal(result.acceptance, "partial-not-a-release-gate");
      assert.ok(result.unassessedRequiredBehavior.length > 0);
    }
    const spokenTime = results.find(result => result.id === "CCP-005")!;
    assert.equal(spokenTime.context?.lastMenu?.kind, "booking");
    assert.ok(spokenTime.setupSpeech.some(text => /9:00/.test(text)));
    assert.ok(spokenTime.setupSpeech.some(text => /10:30/.test(text)));
    assert.equal(spokenTime.checks.find(check => check.id === "conversation-observation")?.pass, true);
    assert.deepEqual(spokenTime.intents, [{ kind: "bookingChoice", choice: 2 }]);
    const ambiguous = results.find(result => result.id === "CCP-006")!;
    assert.ok(ambiguous.setupSpeech.some(text => /10:30 am/.test(text) && /10:30 pm/.test(text)), "both ambiguous times must actually be offered");
    const staff = results.find(result => result.id === "CCP-017")!;
    assert.equal(staff.setupMatch, false); assert.match(staff.setupGap!, /no saved request was fabricated/);
    assert.equal(staff.checks.find(check => check.id === "conversation-observation")?.pass, false);
    const unknown = results.find(result => result.id === "CCP-021")!;
    assert.equal(unknown.writesBefore, 1); assert.equal(unknown.writesAfter, 1);
    assert.equal(unknown.context?.lastAction?.status, "uncertain"); assert.deepEqual(unknown.actionStatuses, ["uncertain"]);
  });
});
