import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { financialConsumerFixture } from "../support/financial-consumer.ts";
import { value, stop } from "../support/financial-retention.ts";

for (const permissionChanged of [false, true])
test(`native discovery quota recovery is quiet and rereads current permission (${permissionChanged})`, { timeout: 8_000 }, async t => {
  let limited = false, claims = 0;
  const budget = {
    async claim() { claims++; return limited ? { kind: "rateLimited" as const, retryAfterMs: 2_500 } : null; },
    async checkHeadroom() { return null; },
    async observe429() { return { kind: "rateLimited" as const, retryAfterMs: 2_500 }; },
  };
  const f = await financialConsumerFixture({ checkout: { native: { config: { rateBudget: budget } } } });
  t.after(() => f.consumer.close());
  limited = true;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = f.cycle(); value(f.consumer.start(stop()));
  assert.equal((await first).kind, "unavailable");
  const deniedClaims = claims;
  if (permissionChanged) f.denyPending();
  limited = false;
  t.mock.timers.tick(59_999); await setImmediate();
  assert.equal(claims, deniedClaims, "periodic discovery must leave the complete recovering native window quiet");
  assert.equal(f.sessions.length, 0); assert.equal(f.messages.length, 0);
  const next = f.cycle(); t.mock.timers.tick(1);
  const resumed = await next;
  assert.equal(resumed.creationAcknowledged, permissionChanged ? 0 : 1);
  assert.equal(f.sessions.length, permissionChanged ? 0 : 1);
  if (permissionChanged) assert.equal(claims, deniedClaims, "withdrawn pending permission must refuse before any protected native read");
});
