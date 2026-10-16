import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget, withClinikoReservation } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test("E2E-416 local allocations block other consumers while owner claims consume the held balance", async () => {
  const budget = new ClinikoReadBudget(4, () => 100_000), started = gate(), finish = gate();
  const held = withClinikoReservation(budget, 4, new AbortController().signal, async () => {
    assert.equal(budget.claim(), null); assert.equal(budget.claim(), null); assert.equal(budget.claim(), null);
    assert.equal(budget.checkHeadroom(1), null); started.resolve(); await finish.promise; return "native-outcome";
  });
  await started.promise;
  assert.equal(budget.claim()?.kind, "rateLimited"); assert.equal(budget.checkHeadroom(1)?.kind, "rateLimited");
  assert.equal((await withClinikoReservation(budget, 1, new AbortController().signal, async () => assert.fail("overbooked"))).kind, "denied");
  finish.resolve(); assert.deepEqual(await held, { kind: "completed", value: "native-outcome" });
  assert.equal(budget.claim(), null); assert.equal(budget.claim()?.kind, "rateLimited");
});

test("E2E-416 exhausted owners cannot fall back to ordinary available capacity", async () => {
  const budget = new ClinikoReadBudget(4, () => 100_000);
  const result = await withClinikoReservation(budget, 1, new AbortController().signal, async () => {
    assert.equal(budget.claim(), null); assert.deepEqual(budget.claim(), { kind: "unavailable" });
    assert.deepEqual(budget.checkHeadroom(1), { kind: "unavailable" });
  });
  assert.equal(result.kind, "completed"); assert.equal(budget.checkHeadroom(3), null);
});

test("E2E-416 expiry frees held capacity but fences the old async owner", async () => {
  let now = 100_000; const budget = new ClinikoReadBudget(4, () => now), started = gate(), finish = gate();
  const held = withClinikoReservation(budget, 4, new AbortController().signal, async () => {
    started.resolve(); await finish.promise; assert.deepEqual(budget.claim(), { kind: "unavailable" });
  });
  await started.promise; now += 30_001; assert.equal(budget.claim(), null);
  finish.resolve(); assert.equal((await held).kind, "completed"); assert.equal(budget.checkHeadroom(3), null);
});

test("E2E-416 escaped descendants cannot spend released capacity", async () => {
  const budget = new ClinikoReadBudget(2, () => 100_000), finish = gate(); let descendant: Promise<unknown> | undefined;
  assert.equal((await withClinikoReservation(budget, 2, new AbortController().signal, async () => {
    descendant = (async () => { await finish.promise; return budget.claim(); })(); return "done";
  })).kind, "completed");
  finish.resolve(); assert.deepEqual(await descendant, { kind: "unavailable" }); assert.equal(budget.checkHeadroom(2), null);
});

test("E2E-416 abort and callback failure remain potentially sent while unused quota releases", async () => {
  for (const mode of ["abort", "throw"] as const) {
    const budget = new ClinikoReadBudget(4, () => 100_000), lifetime = new AbortController(), started = gate(), finish = gate();
    let descendant: Promise<unknown> | undefined;
    const held = withClinikoReservation(budget, 4, lifetime.signal, async () => {
      assert.equal(budget.claim(), null); started.resolve();
      if (mode === "throw") throw new Error("potential send already occurred");
      descendant = (async () => { await finish.promise; return budget.claim(); })();
      await finish.promise; return "late";
    });
    await started.promise; if (mode === "abort") lifetime.abort();
    assert.deepEqual(await held, { kind: "interrupted" }); assert.equal(budget.checkHeadroom(3), null);
    finish.resolve(); if (descendant) assert.deepEqual(await descendant, { kind: "unavailable" });
  }
});

test("E2E-416 same-budget nesting denies but independent accounts remain separate", async () => {
  const budget = new ClinikoReadBudget(2, () => 100_000), other = new ClinikoReadBudget(2, () => 100_000);
  assert.equal((await withClinikoReservation(budget, 2, new AbortController().signal, async () => {
    assert.equal((await withClinikoReservation(budget, 1, new AbortController().signal, async () => assert.fail("nested"))).kind, "denied");
    assert.equal((await withClinikoReservation(other, 1, new AbortController().signal, async () => other.claim())).kind, "completed");
  })).kind, "completed");
});

test("E2E-416 provider cooldown fences reserved owner claims too", async () => {
  const budget = new ClinikoReadBudget(2, () => 100_000);
  assert.equal((await withClinikoReservation(budget, 2, new AbortController().signal, async () => {
    budget.observe429(null); assert.equal(budget.claim()?.kind, "rateLimited"); assert.equal(budget.checkHeadroom(1)?.kind, "rateLimited");
  })).kind, "completed");
  assert.equal(budget.claim()?.kind, "rateLimited");
});

test("E2E-416 malformed budget ports cannot fabricate callback success or invoke it twice", async () => {
  const base = { claim: () => null, observe429: () => ({ kind: "rateLimited" as const }) };
  const fabricated = { ...base, withReservation: async () => ({ kind: "completed", value: "forged" }) } as unknown as ClinikoRequestBudget;
  assert.deepEqual(await withClinikoReservation(fabricated, 1, new AbortController().signal, async () => assert.fail("not invoked")), { kind: "denied", denial: { kind: "unavailable" } });
  let invoked = 0;
  const doubled = { ...base, withReservation: async (_n: number, _s: AbortSignal, task: () => Promise<unknown>) => {
    await task(); try { await task(); } catch { /* hostile port suppresses its second invocation error */ } return { kind: "completed", value: "forged" };
  } } as unknown as ClinikoRequestBudget;
  assert.deepEqual(await withClinikoReservation(doubled, 1, new AbortController().signal, async () => ++invoked), { kind: "interrupted" }); assert.equal(invoked, 1);
});

test("E2E-416 a returned or failed budget port cannot start its retained callback later", async () => {
  for (const mode of ["denied", "fabricated", "throw"] as const) {
    let late!: () => Promise<unknown>, invoked = 0;
    const budget = { claim: () => null, observe429: () => ({ kind: "rateLimited" }),
      withReservation: async (_n: number, _s: AbortSignal, task: () => Promise<unknown>) => {
        late = task;
        if (mode === "throw") throw new Error("failed before invocation");
        return mode === "denied" ? { kind: "denied", denial: { kind: "unavailable" } } : { kind: "completed", value: "forged" };
      },
    } as unknown as ClinikoRequestBudget;
    assert.deepEqual(await withClinikoReservation(budget, 1, new AbortController().signal, async () => ++invoked),
      { kind: "denied", denial: { kind: "unavailable" } });
    await assert.rejects(late, /invalid allocation callback/); assert.equal(invoked, 0);
  }
});
