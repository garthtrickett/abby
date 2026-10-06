import assert from "node:assert/strict";
import test from "node:test";
import { candidates, plans } from "../../scripts/conversation-evaluation/plans.ts";
import { runCase } from "../../scripts/conversation-evaluation/run-case.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

test("E2E-307 conversation baseline distinguishes trusted spoken selection and missing setups from live model understanding", { timeout: 90_000 }, async () => {
  const corpus = await candidates();
  assert.equal(corpus.length, 45);
  await withDisposablePostgres(async db => {
    const ids = ["CCP-005", "CCP-006", "CCP-009", "CCP-012", "CCP-013", "CCP-015", "CCP-017", "CCP-021", "CCP-022", "CCP-029", "CCP-037", "CCP-039", "CCP-041"];
    let next = 0;
    const evaluated: Awaited<ReturnType<typeof runCase>>[] = [];
    const settled = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) {
      const id = ids[next++]; if (!id) return;
      const item = corpus.find(candidate => candidate.id === id)!;
      evaluated.push(await runCase(db, item, plans[id]!, { mode: "scripted", model: "synthetic-baseline", apiKey: "synthetic-key" }));
    }
    }));
    const failure = settled.find(item => item.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
    const results = evaluated;
    assert.equal(results.length, ids.length);
    for (const id of ["CCP-012", "CCP-013", "CCP-037", "CCP-039", "CCP-041"]) {
      const result = results.find(result => result.id === id)!;
      assert.equal(result.intents.at(-1)?.kind, "requestBoundary");
      assert.equal(result.checks.find(check => check.id === "conversation-observation")?.pass, true, id);
    }
    const horizon = results.find(result => result.id === "CCP-029")!;
    assert.deepEqual(horizon.intents, [{ kind: "bookingHorizon" }]);
    assert.equal(horizon.checks.find(check => check.id === "conversation-observation")?.pass, true);
    const denial = results.find(result => result.id === "CCP-009")!;
    assert.deepEqual(denial.intents, [{ kind: "callerIdentityDenied", reason: "identityDisagreement" }]);
    assert.equal(denial.checks.find(check => check.id === "conversation-observation")?.pass, true);
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
    const urgent = results.find(result => result.id === "CCP-015")!;
    assert.equal(urgent.setupMatch, true); assert.equal(urgent.setupGap, null);
    assert.deepEqual(urgent.intents, [{ kind: "handoff", reason: "potentiallyUrgent" }]);
    assert.equal(urgent.checks.find(check => check.id === "conversation-observation")?.pass, true);
    const staff = results.find(result => result.id === "CCP-017")!;
    assert.equal(staff.setupMatch, true); assert.equal(staff.setupGap, null);
    assert.equal(staff.checks.find(check => check.id === "conversation-observation")?.pass, true);
    assert.ok(staff.speech.some(text => /staff request.*was saved.*can't confirm.*read/.test(text)));
    const unknown = results.find(result => result.id === "CCP-021")!;
    assert.equal(unknown.writesBefore, 1); assert.equal(unknown.writesAfter, 1);
    assert.equal(unknown.context?.lastAction?.status, "uncertain"); assert.deepEqual(unknown.actionStatuses, ["uncertain"]);
    const email = results.find(result => result.id === "CCP-022")!;
    assert.equal(email.checks.find(check => check.id === "conversation-observation")?.pass, true);
    assert.deepEqual(email.intents, [{ kind: "notificationOutcome" }]);
    assert.deepEqual(email.actionStatuses, ["committed"]); assert.equal(email.writesBefore, 1); assert.equal(email.writesAfter, 1);
  });
});
