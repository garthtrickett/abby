import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget, claimClinikoBudget, withClinikoReservation } from "../../src/cliniko/read-budget.ts";
import { financialNativeBudget } from "../../src/standalone/financial-native-budget.ts";

test("financial native observation preserves the underlying reservation and every physical claim", async () => {
  const source = new ClinikoReadBudget(2), pauses: number[] = [];
  const observed = financialNativeBudget(source, ms => pauses.push(ms));
  let invocations = 0;
  const result = await withClinikoReservation(observed, 2, new AbortController().signal, async () => {
    invocations++;
    assert.equal(await claimClinikoBudget(observed), null);
    assert.equal(await claimClinikoBudget(observed), null);
    return "completed once";
  });
  assert.deepEqual(result, { kind: "completed", value: "completed once" });
  assert.equal(invocations, 1); assert.deepEqual(pauses, []);
  assert.equal((await claimClinikoBudget(observed))?.kind, "rateLimited");
  assert.deepEqual(pauses, [60_000]);
  assert.equal(source.checkHeadroom(1)?.kind, "rateLimited", "the observer must not create a second physical budget");
});

test("financial native cooldown preserves longer timing and malformed admission stays closed", async () => {
  const pauses: number[] = [];
  const source = { claim: async () => null, observe429: async () => ({ kind: "rateLimited" as const, retryAfterMs: 120_000 }),
    checkHeadroom: async () => ({ kind: "rateLimited" as const, retryAfterMs: 2_500 }) };
  const observed = financialNativeBudget(source, ms => pauses.push(ms));
  assert.equal((await observed.checkHeadroom!(5))?.kind, "rateLimited");
  assert.equal((await observed.observe429(null)).retryAfterMs, 120_000);
  assert.deepEqual(pauses, [60_000, 120_000]);
  Reflect.set(source, "claim", async () => ({ kind: "rateLimited", retryAfterMs: 0 }));
  assert.deepEqual(await observed.claim(), { kind: "unavailable" });
  Reflect.set(source, "checkHeadroom", async () => undefined);
  assert.deepEqual(await observed.checkHeadroom!(5), { kind: "unavailable" });
  assert.deepEqual(pauses, [60_000, 120_000]);
});
