import assert from "node:assert/strict";
import test from "node:test";
import { callClosureFixture } from "../support/twilio-outbound-call-closure.ts";


test("actual runtime credentials own two exact root and complete empty child observations", async () => {
  const f = callClosureFixture(), result = await f.inspect(); assert.equal(result.kind, "singleRootClosed"); assert.equal(f.state.count, 4);
  assert.ok(f.state.queries.every(q => q.coverage === "allCallCreationMutationAndRestoreSources" && q.inspectionBinding === f.runtime.createCallClosureReader().binding()));
  assert.equal((await f.inspect()).kind, "singleRootClosed");
  const again = await f.inspect(); if (result.kind === "singleRootClosed" && again.kind === "singleRootClosed") assert.equal(result.digest, again.digest);
});

for (const denial of ["approveExclusiveSingleRootProfile", "readRootCall", "readChildCalls"] as const)
test(`provider closure requires ${denial} independently`, async () => {
  const f = callClosureFixture(); f.state.grant = q => q.operation !== denial; assert.equal((await f.inspect()).kind, "unknown");
  if (denial !== "readChildCalls") assert.equal(f.state.count, 0);
});

for (const change of ["account", "sid", "from", "to", "parent", "direction", "uri", "busy", "noEnd", "beforeStop", "badDate", "future", "changedRoot", "child", "nextPage", "absentNext", "wrongPage"] as const)
test(`provider closure refuses ${change}`, async () => {
  const f = callClosureFixture();
  if (change === "account") f.raw.account_sid = "AC" + "9".repeat(32);
  if (change === "sid") f.raw.sid = "CA" + "9".repeat(32);
  if (change === "from") f.raw.from = "+12025550111";
  if (change === "to") f.raw.to = "+12025550124";
  if (change === "parent") Object.assign(f.raw, { parent_call_sid: "CA" + "9".repeat(32) });
  if (change === "direction") f.raw.direction = "inbound";
  if (change === "uri") f.raw.uri += "?extra=true";
  if (change === "busy") f.raw.status = "busy";
  if (change === "noEnd") Object.assign(f.raw, { end_time: null });
  if (change === "beforeStop") f.raw.end_time = "Sun, 01 Nov 2026 10:00:59 +0000";
  if (change === "badDate") f.raw.end_time = "Sun, 31 Feb 2026 10:02:00 +0000";
  if (change === "future") f.raw.date_updated = "Sun, 01 Nov 2026 10:04:01 +0000";
  if (change === "changedRoot") f.state.response = relative => Response.json(relative === f.rootPath ? { ...f.raw, end_time: f.state.count > 2 ? "Sun, 01 Nov 2026 10:01:59 +0000" : f.raw.end_time } : f.children);
  if (change === "child") Object.assign(f.children, { calls: [{ sid: "CA" + "3".repeat(32), status: "completed" }] });
  if (change === "nextPage") Object.assign(f.children, { next_page_uri: f.childrenPath + "&PageToken=one" });
  if (change === "absentNext") Reflect.deleteProperty(f.children, "next_page_uri");
  if (change === "wrongPage") f.children.page = 1;
  assert.equal((await f.inspect()).kind, "unknown");
});

test("active, missing, rate limited and malformed responses never invent end time or retry", async () => {
  const active = callClosureFixture(); active.raw.status = "in-progress"; assert.equal((await active.inspect()).kind, "active"); assert.equal(active.state.count, 1);
  for (const make of [() => new Response(null, { status: 404 }), () => new Response(null, { status: 429 }), () => new Response("bad", { headers: { "content-type": "application/json" } }), () => new Response("{}")]) {
    const f = callClosureFixture(); f.state.response = make; assert.equal((await f.inspect()).kind, "unknown"); assert.equal(f.state.count, 1);
  }
});

test("permission loss during provider body and backwards time cannot escape as closure", async () => {
  for (const failure of ["permission", "clock"] as const) {
    const f = callClosureFixture(); f.state.response = relative => { if (failure === "permission") f.state.live = false; else f.state.now = "2026-11-01T10:03:59.000Z"; return Response.json(relative === f.rootPath ? f.raw : f.children); };
    assert.equal((await f.inspect()).kind, "unknown");
  }
});


test("equivalent provider query ordering and later billing metadata do not change closure identity", async () => {
  const f = callClosureFixture(), first = await f.inspect();
  f.raw.date_updated = "Sun, 01 Nov 2026 10:03:00 +0000";
  f.children.uri = f.childrenPath.replace(/ParentCallSid=([^&]+)&PageSize=100&Page=0$/, "Page=0&PageSize=100&ParentCallSid=$1"); f.children.first_page_uri = f.children.uri;
  const again = await f.inspect(); assert.equal(again.kind, "singleRootClosed");
  if (first.kind === "singleRootClosed" && again.kind === "singleRootClosed") assert.equal(first.digest, again.digest);
});

test("the captured provider deadline bounds an ignored fetch and an unfinished owned body", { timeout: 5000 }, async () => {
  for (const phase of ["fetch", "body"] as const) {
    const f = callClosureFixture(); let cancelled = false;
    f.state.response = () => phase === "fetch" ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
    assert.equal((await f.inspect()).kind, "unknown"); assert.equal(f.state.count, 1);
    if (phase === "body") assert.equal(cancelled, true);
  }
});

test("a response arriving after caller abort is cancelled and cannot become closure", async () => {
  const f = callClosureFixture(), controller = new AbortController(); let ready!: () => void, late!: (r: Response) => void, cancelled = false;
  const reached = new Promise<void>(resolve => { ready = resolve; });
  f.state.response = () => new Promise<Response>(resolve => { late = resolve; ready(); });
  const pending = f.runtime.createCallClosureReader().inspect(f.input, f.authority, controller.signal); await reached; controller.abort();
  assert.deepEqual(await pending, { kind: "unknown" });
  late(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
});

test("redirected or foreign provider responses never supply root evidence", async () => {
  for (const property of ["redirected", "url"] as const) {
    const f = callClosureFixture(); f.state.response = () => {
      const response = Response.json(f.raw); Object.defineProperty(response, property, { value: property === "redirected" ? true : "https://other.example.invalid/call" }); return response;
    };
    assert.equal((await f.inspect()).kind, "unknown"); assert.equal(f.state.count, 1);
  }
});
