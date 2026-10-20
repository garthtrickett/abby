import assert from "node:assert/strict";
import test from "node:test";
import { encodeFinancialResendRequest } from "../../src/cliniko/financial-resend-request.ts";
import { encodeFinancialResendAttempt } from "../../src/cliniko/financial-resend-attempt.ts";
import { resendRequestValue, resendAttemptValue } from "../support/financial-resend.ts";
import { resendDiscoveryFixture, resendDiscoveryWindow as window } from "../support/financial-resend-discovery.ts";
import { value, base, now, stop, uuid } from "../support/financial-retention.ts";
function setup(cold = false) {
  const f = resendDiscoveryFixture(); const request = { ...f.request, ...(cold ? { requestedAt: "2026-11-01T09:29:59.000Z" } : {}) };
  f.native.notes = value(encodeFinancialResendRequest(request));
  if (cold) { f.native.created_at = request.requestedAt; f.native.recalled = true; f.native.archived_at = now; }
  const attempt = resendAttemptValue(request), native: Record<string, unknown> = { ...f.source, id: "34", links: { self: `${base}/recalls/34` }, notes: value(encodeFinancialResendAttempt(attempt)) };
  f.rows.set("34", native); return { ...f, exactRequest: request, attempt, possible: native };
}
test("listed request and possible resend share evidence without being counted as a duplicated effect", async () => {
  const f = setup(), result = value(await f.scanner.scan(window, stop()));
  assert.equal(result.resendRequests?.length, 1); assert.equal(result.resendAttempts?.length, 1);
  assert.deepEqual(result.resendAttempts[0]!.attempt, f.attempt); assert.deepEqual(result.resendAttempts[0]!.request.request, f.exactRequest);
  assert.equal(result.messageAttempts, undefined); assert.equal(result.work.length, 1); assert.equal(f.burned.size, 0);
  const pending = value(await f.pending.scanPending(stop())); assert.equal(pending.resendAttempts?.length, 1); assert.equal(f.methods.includes("POST"), false);
});
test("closed request outside the scan window is separately read and keeps its possible-send history", async () => {
  const f = setup(true), result = value(await f.scanner.scan(window, stop()));
  assert.equal(result.resendRequests, undefined); assert.equal(result.resendAttempts?.length, 1);
  assert.equal(result.resendAttempts[0]!.request.recalled, true); assert.equal(result.resendAttempts[0]!.request.archivedAt, now);
  assert.deepEqual(result.resendAttempts[0]!.request.request, f.exactRequest); assert.equal(f.burned.size, 0);
});
test("cold request lookup needs its own exact grant rather than borrowing parent or possible-attempt permission", async () => {
  const f = setup(true); f.denyRequest(); assert.deepEqual(await f.scanner.scan(window, stop()), { ok: false, error: { kind: "forbidden" } });
  assert.equal(f.methods.includes("POST"), false);
});
for (const patch of [{ requestDigest: "b".repeat(64) }, { approvalRef: uuid(201) }, { effectRef: uuid(202) }, { targetRef: "cliniko:appointment:92" }])
  test(`changed possible-resend ${Object.keys(patch)[0]} cannot erase or authorize history`, async () => {
    const f = setup(); f.possible.notes = value(encodeFinancialResendAttempt({ ...f.attempt, ...patch }));
    assert.equal((await f.scanner.scan(window, stop())).ok, false); assert.equal((await f.pending.scanPending(stop())).ok, false);
  });
test("two native possible records for the same send effect refuse the complete result", async () => {
  const f = setup(); f.rows.set("35", { ...f.possible, id: "35", links: { self: `${base}/recalls/35` },
    notes: value(encodeFinancialResendAttempt({ ...f.attempt, actionRef: uuid(201) })) });
  assert.equal((await f.scanner.scan(window, stop())).ok, false); assert.equal(f.burned.size, 0);
});

test("separate historical request reads share the original fifty-lookup bound without partial success", { timeout: 10_000 }, async () => {
  const f = resendDiscoveryFixture(), older = "2026-11-01T09:29:59.000Z";
  for (const ref of ["30", "31", "33"]) f.rows.get(ref)!.created_at = older;
  for (let i = 0; i < 50; i++) {
    const ref = String(1000+i), request = resendRequestValue(f.intent, { actionRef: uuid(1000+i), effectRef: uuid(2000+i),
      approvalRef: uuid(3000+i), requestedAt: older });
    f.rows.set(ref, { ...f.native, id: ref, links: { self: `${base}/recalls/${ref}` }, notes: value(encodeFinancialResendRequest(request)) });
    const id = String(2000+i), attempt = resendAttemptValue(request, `cliniko:recall:${ref}`, { actionRef: uuid(4000+i) });
    f.rows.set(id, { ...f.source, id, links: { self: `${base}/recalls/${id}` }, created_at: now,
      notes: value(encodeFinancialResendAttempt(attempt)) });
  }
  assert.deepEqual(await f.scanner.scan(window, stop()), { ok: false, error: { kind: "unavailable" } });
  assert.equal(f.methods.length, 51, "one complete list and at most fifty combined intent/request lookups");
  assert.equal(f.methods.includes("POST"), false); assert.equal(f.burned.size, 0);
});
