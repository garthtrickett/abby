import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoFinancialWorkDiscovery } from "../../src/cliniko/financial-work-discovery.ts";
import { ClinikoFinancialPendingDiscovery } from "../../src/cliniko/financial-pending-discovery.ts";
import { encodeFinancialResendRequest } from "../../src/cliniko/financial-resend-request.ts";
import { fixture, value, observation, now, base, stop, uuid } from "../support/financial-retention.ts";
import { resendRequestValue } from "../support/financial-resend.ts";
const window = { createdFrom: "2026-11-01T09:30:00.000Z", createdThrough: now };
function setup() {
  const f = fixture(); f.seedIntent(); const source = f.rows.get("30")!;
  const obs = { ...source, id: "31", links: { self: `${base}/recalls/31` }, notes: observation(f.intent) };
  const request = resendRequestValue(f.intent), native: Record<string, unknown> = { ...source, id: "33", links: { self: `${base}/recalls/33` }, notes: value(encodeFinancialResendRequest(request)) };
  f.rows.set("31", obs); f.rows.set("33", native);
  let recordsAllowed = true; const methods: string[] = [];
  const port: typeof fetch = async (input, init) => {
    methods.push(init?.method ?? "GET"); const url = new URL(String(input));
    if (url.pathname !== "/v1/recalls") return f.port(input, init);
    const filters = url.searchParams.getAll("q[]"), pending = filters.includes("recalled_at:!?");
    const rows = [...f.rows.values()].filter(row => !pending || row.recalled === false && row.archived_at === null);
    const page = Number(url.searchParams.get("page")); return Response.json({ total_entries: rows.length, recalls: rows.slice((page-1)*100, page*100) });
  };
  const scanner = value(ClinikoFinancialWorkDiscovery.create(f.config, { allowsAccountRead: async () => true,
    allowsRecordRead: async q => q.actionRef !== request.actionRef || recordsAllowed, current: () => true }, port));
  const pending = value(ClinikoFinancialPendingDiscovery.create(f.config, { allowsPendingRead: async () => true,
    allowsRecordRead: async q => q.actionRef !== request.actionRef || recordsAllowed, current: () => true }, port));
  return { ...f, source, obs, request, native, scanner, pending, methods, denyRequest: () => { recordsAllowed = false; } };
}
test("native prospective request is discovered separately without replacing its original pair or sending", async () => {
  const f = setup(); const result = value(await f.scanner.scan(window, stop()));
  assert.equal(result.work.length, 1); assert.equal(result.work[0]?.kind, "pairedContext"); assert.deepEqual(result.resendRequests?.[0]?.request, f.request);
  assert.equal(result.attempts.length, 0); assert.equal(result.messageAttempts, undefined); assert.equal(f.burned.size, 0);
  assert.equal(f.methods.every(method => method === "GET"), true); assert.equal(JSON.stringify(result).includes("private-native-record-canary"), false);
  const pending = value(await f.pending.scan(stop())); assert.deepEqual(pending.resendRequests?.[0]?.request, f.request); assert.equal(pending.work.length, 1);
});
test("closed and archived requests remain in complete history and cannot become pending work", async () => {
  const f = setup(); f.native.recalled = true; f.native.archived_at = now;
  const request = value(await f.scanner.scan(window, stop())).resendRequests?.[0]; assert.equal(request?.recalled, true); assert.equal(request?.archivedAt, now);
  assert.equal(value(await f.pending.scan(stop())).resendRequests, undefined); assert.equal(f.methods.includes("POST"), false);
});
for (const key of ["actionRef", "effectRef", "approvalRef"] as const)
  test(`duplicate resend ${key} refuses the whole discovery result`, async () => {
    const f = setup(), next = { ...f.request, actionRef: uuid(103), effectRef: uuid(104), approvalRef: uuid(105), [key]: f.request[key] };
    f.rows.set("34", { ...f.native, id: "34", links: { self: `${base}/recalls/34` }, notes: value(encodeFinancialResendRequest(next)) });
    assert.equal((await f.scanner.scan(window, stop())).ok, false); assert.equal((await f.pending.scan(stop())).ok, false); assert.equal(f.burned.size, 0);
  });
for (const patch of [{ observationRecallRef: "cliniko:recall:81" }, { observationActionRef: uuid(111) }, { targetRef: "cliniko:appointment:92" },
  { intentDigest: "f".repeat(64) }, { effectRef: uuid(4) }, { requestedAt: "2026-11-01T10:00:30.001Z" }])
  test(`mismatched prospective request ${Object.keys(patch)[0]} cannot be promoted during discovery`, async () => {
    const f = setup(); f.native.notes = value(encodeFinancialResendRequest({ ...f.request, ...patch }));
    assert.equal((await f.scanner.scan(window, stop())).ok, false); assert.equal((await f.pending.scan(stop())).ok, false); assert.equal(f.methods.includes("POST"), false);
  });
test("a separate request read grant is mandatory even when the parent and account are authorized", async () => {
  const f = setup(); f.denyRequest(); assert.equal((await f.scanner.scan(window, stop())).ok, false); assert.equal((await f.pending.scan(stop())).ok, false);
});
test("a malformed new family cannot be silently skipped or interpreted as another obligation", async () => {
  const f = setup(); f.native.notes = String(f.native.notes).replace('request v1', 'request v2');
  assert.equal((await f.scanner.scan(window, stop())).ok, false); assert.equal((await f.pending.scan(stop())).ok, false);
});
