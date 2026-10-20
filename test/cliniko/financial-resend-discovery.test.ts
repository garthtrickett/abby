import assert from "node:assert/strict";
import test from "node:test";
import { encodeFinancialResendRequest } from "../../src/cliniko/financial-resend-request.ts";
import { fixture, value, observation, now, base, stop, uuid } from "../support/financial-retention.ts";
import { resendRequestValue } from "../support/financial-resend.ts";
import { resendDiscoveryFixture as setup, resendDiscoveryWindow as window } from "../support/financial-resend-discovery.ts";
test("native prospective request is discovered separately without replacing its original pair or sending", async () => {
  const f = setup(); const result = value(await f.scanner.scan(window, stop()));
  assert.equal(result.work.length, 1); assert.equal(result.work[0]?.kind, "pairedContext"); assert.deepEqual(result.resendRequests?.[0]?.request, f.request);
  assert.equal(result.attempts.length, 0); assert.equal(result.messageAttempts, undefined); assert.equal(f.burned.size, 0);
  assert.equal(f.methods.every(method => method === "GET"), true); assert.equal(JSON.stringify(result).includes("private-native-record-canary"), false);
  const pending = value(await f.pending.scanPending(stop())); assert.deepEqual(pending.resendRequests?.[0]?.request, f.request); assert.equal(pending.work.length, 1);
});
test("closed and archived requests remain in complete history and cannot become pending work", async () => {
  const f = setup(); f.native.recalled = true; f.native.archived_at = now;
  const request = value(await f.scanner.scan(window, stop())).resendRequests?.[0]; assert.equal(request?.recalled, true); assert.equal(request?.archivedAt, now);
  assert.equal(value(await f.pending.scanPending(stop())).resendRequests, undefined); assert.equal(f.methods.includes("POST"), false);
});
for (const key of ["actionRef", "effectRef", "approvalRef"] as const)
  test(`duplicate resend ${key} refuses the whole discovery result`, async () => {
    const f = setup(), next = { ...f.request, actionRef: uuid(103), effectRef: uuid(104), approvalRef: uuid(105), [key]: f.request[key] };
    f.rows.set("34", { ...f.native, id: "34", links: { self: `${base}/recalls/34` }, notes: value(encodeFinancialResendRequest(next)) });
    assert.equal((await f.scanner.scan(window, stop())).ok, false); assert.equal((await f.pending.scanPending(stop())).ok, false); assert.equal(f.burned.size, 0);
  });
for (const patch of [{ observationRecallRef: "cliniko:recall:81" }, { observationActionRef: uuid(111) }, { targetRef: "cliniko:appointment:92" },
  { intentDigest: "f".repeat(64) }, { effectRef: uuid(4) }, { requestedAt: "2026-11-01T10:00:30.001Z" }])
  test(`mismatched prospective request ${Object.keys(patch)[0]} cannot be promoted during discovery`, async () => {
    const f = setup(); f.native.notes = value(encodeFinancialResendRequest({ ...f.request, ...patch }));
    assert.equal((await f.scanner.scan(window, stop())).ok, false); assert.equal((await f.pending.scanPending(stop())).ok, false); assert.equal(f.methods.includes("POST"), false);
  });
test("a separate request read grant is mandatory even when the parent and account are authorized", async () => {
  const f = setup(); f.denyRequest(); assert.equal((await f.scanner.scan(window, stop())).ok, false); assert.equal((await f.pending.scanPending(stop())).ok, false);
});
test("a malformed new family cannot be silently skipped or interpreted as another obligation", async () => {
  const f = setup(); f.native.notes = String(f.native.notes).replace('request v1', 'request v2');
  assert.equal((await f.scanner.scan(window, stop())).ok, false); assert.equal((await f.pending.scanPending(stop())).ok, false);
});
