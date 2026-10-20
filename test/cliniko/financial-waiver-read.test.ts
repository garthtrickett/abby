import assert from "node:assert/strict";
import test from "node:test";
import { nativeWaiverFixture, issuerKey } from "../support/financial-waiver.ts";
import { value, base } from "../support/financial-retention.ts";
import { ApprovedFinancialWaiverIssuer } from "../../src/standalone/approved-financial-waiver-issuer.ts";
import { ClinikoFinancialWaiverReader } from "../../src/cliniko/financial-waiver-read.ts";
import { OwnerFileFinancialSource } from "../../src/standalone/owner-file-financial-source.ts";

const signal = () => new AbortController().signal;
test("native waiver needs its own current clinic issuer approval plus exact private record admission", async t => {
  const f = await nativeWaiverFixture(); t.after(f.close); const reader = f.create(), found = value(await reader.read(f.binding, signal()));
  assert.deepEqual(found.decision, f.decision); assert.equal(f.state.gets, 1); assert.equal(f.state.quota, 1);
  assert.equal(f.queries.length, 3); assert.equal(f.queries[0], f.queries[2]); assert.equal(JSON.stringify(reader), "{}");
  assert.equal(JSON.stringify(found).includes("private-native-chart"), false);
});
for (const change of ["disabled", "role", "membership", "removed", "expired"] as const)
test(`native waiver refuses current issuer ${change} before native access`, async t => {
  const f = await nativeWaiverFixture(); t.after(f.close);
  if (change === "disabled") await f.withdraw();
  if (change === "role") f.sourceState.account = { ...f.sourceState.account!, actor: { ...f.sourceState.account!.actor, role: "staff" } };
  if (change === "membership") f.sourceState.account = { ...f.sourceState.account!, membershipVersion: "2" };
  if (change === "removed") f.sourceState.account = undefined;
  if (change === "expired") f.sourceState.now = "2026-12-01T00:00:00.000Z";
  assert.equal((await f.create().read(f.binding, signal())).ok, false); assert.equal(f.state.gets, 0);
});
test("ordinary booking/financial-record source approval cannot become waiver issuer approval", async t => {
  const f = await nativeWaiverFixture(); t.after(f.close);
  await f.replace({ source: f.approval.source });
  const ordinary = value(await OwnerFileFinancialSource.capture({ path: f.path, scope: f.intent.scope, directory: f.directory,
    clock: () => f.sourceState.now }, signal()));
  const issuer = value(ApprovedFinancialWaiverIssuer.create(f.config, issuerKey, ordinary));
  assert.equal(await issuer.current(signal()), false);
});
for (const patch of [{ id: "72" }, { patient: { links: { self: `${base}/patients/22` } } },
  { recall_type: { links: { self: `${base}/recall_types/41` } } }, { recalled: true }, { recalled_at: "2026-11-02T00:00:00.000Z" },
  { archived_at: "2026-11-02T00:00:00.000Z" }, { notes: "staff says paid or waived" }])
test("changed, recalled, archived or unsigned native waiver records cannot publish a decision", async t => {
  const f = await nativeWaiverFixture(); t.after(f.close);
  assert.equal((await f.create(async () => Response.json({ ...f.row, ...patch })).read(f.binding, signal())).ok, false);
});
test("copying a signed waiver to another native row cannot bypass original-record revocation", async t => {
  const f = await nativeWaiverFixture(); t.after(f.close);
  const reader = f.create(async () => Response.json({ ...f.row, id: "72", links: { self: `${base}/recalls/72` } }));
  const found = await reader.read({ ...f.binding, waiverRecallRef: "cliniko:recall:72" }, signal());
  assert.equal(found.ok, false, "the signature must bind its own native waiver record");
});
test("withdrawal during actual physical quota wait prevents the private GET", async t => {
  const f = await nativeWaiverFixture(); t.after(f.close);
  const config = { ...f.config, rateBudget: { ...f.config.rateBudget, claim: async () => { await f.withdraw(); return null; } } };
  assert.equal((await f.create(f.port, f.authority, config).read(f.binding, signal())).ok, false); assert.equal(f.state.gets, 0);
});
test("financial permission withdrawn during the last issuer lookup prevents private dispatch", async t => {
  const f = await nativeWaiverFixture(); t.after(f.close); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; }), original = f.directory.findByRef;
  t.after(() => release?.());
  f.directory.findByRef = async ref => { if (f.state.quota > 0) { entered(); await gate; } return original(ref); };
  const definition = value(await OwnerFileFinancialSource.capture({ path: f.path, scope: f.intent.scope, directory: f.directory,
    clock: () => f.sourceState.now }, signal()));
  const issuer = value(ApprovedFinancialWaiverIssuer.create(f.config, issuerKey, definition));
  const reader = value(ClinikoFinancialWaiverReader.create(f.config, issuer, f.authority, f.port));
  const pending = reader.read(f.binding, signal()); await ready; f.state.current = false; release();
  assert.equal((await pending).ok, false); assert.equal(f.state.gets, 0, "withdrawn financial read permission must prevent native GET");
});
test("native body completion rechecks independent permission and issuer approval", async t => {
  const f = await nativeWaiverFixture(); t.after(f.close);
  const reader = f.create(async () => { await f.withdraw(); return Response.json(f.row); });
  assert.equal((await reader.read(f.binding, signal())).ok, false);
});
test("private reader rejects cross-account issuer reuse before transport", async t => {
  const f = await nativeWaiverFixture(); t.after(f.close);
  assert.equal(ClinikoFinancialWaiverReader.create({ ...f.config, businessId: "12" }, f.issuer, f.authority, f.port).ok, false);
});
test("mutation of expected private context during a held issuer lookup cannot retarget a signed decision", async t => {
  const f = await nativeWaiverFixture(); t.after(f.close); let hold = false, entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; }), original = f.directory.findByRef;
  t.after(() => release?.()); f.directory.findByRef = async ref => { if (hold) { entered(); await gate; } return original(ref); };
  // Recapture while unheld because source owners intentionally bind their methods.
  const definition = value(await OwnerFileFinancialSource.capture({ path: f.path, scope: f.intent.scope, directory: f.directory,
    clock: () => f.sourceState.now }, signal()));
  const issuer = value(ApprovedFinancialWaiverIssuer.create(f.config, issuerKey, definition));
  hold = true; const expected = structuredClone(f.expected); expected.targetRef = "cliniko:appointment:92";
  const pending = issuer.verifyCurrent(f.format(), expected, signal()); await ready; expected.targetRef = f.expected.targetRef; release();
  assert.equal((await pending).ok, false);
});
test("abort bounds a held private waiver provider without leaking its eventual payload", async t => {
  const f = await nativeWaiverFixture(); t.after(f.close); let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const reader = f.create(async () => { entered(); return new Promise(() => {}); }), controller = new AbortController();
  const pending = reader.read(f.binding, controller.signal); await ready; controller.abort(); assert.equal((await pending).ok, false);
});
test("a held waiver body is bounded by the native reader deadline", { timeout: 3000 }, async t => {
  const f = await nativeWaiverFixture(); t.after(f.close); let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const reader = f.create(async () => new Response(new ReadableStream({ start() { entered(); } })), f.authority, { ...f.config, deadlineMs: 1000 });
  t.mock.timers.enable({ apis: ["setTimeout"] }); const pending = reader.read(f.binding, signal()); await ready; t.mock.timers.tick(1000);
  assert.equal((await pending).ok, false);
});
