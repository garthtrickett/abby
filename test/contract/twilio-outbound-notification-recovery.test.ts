import assert from "node:assert/strict";
import test from "node:test";
import { twilioNotificationRecoveryFixture as fixture } from "../support/twilio-outbound-notification-recovery.ts";
import { value } from "../support/outbound-records.ts";
import { recoverTwilioOutboundNotification } from "../../src/standalone/cliniko-twilio-outbound-notification-recovery.ts";
import { encodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { TwilioOutboundTerminalObservationAuthentication } from "../../src/cliniko/twilio-outbound-terminal-observation.ts";


test("actual signed native notification recovers capacity through independent complete provider reads without contact settlement", async () => {
  const f = await fixture(), before = structuredClone([...f.native.rows]), claims = f.native.claims;
  assert.deepEqual(value(await f.recover()), { kind: "terminal", released: true });
  assert.equal(f.held.size, 0); assert.equal(f.recoveryState.reads, 4); assert.equal(f.recoveryState.pages, 4);
  assert.equal(f.recoveryState.releases, 1); assert.equal(f.carrierRequests, 1); assert.ok(f.native.claims > claims);
  assert.deepEqual([...f.native.rows], before); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
  assert.ok(f.providerQueries.every(q => q.purpose === "providerTerminalFromCompletedNotification" && !Object.hasOwn(q.input, "stoppedAt")));
  assert.equal(Object.hasOwn(f.recoveryPorts, "contact"), false);
  // Fresh invocation discovers native truth again; there is no private cache.
  assert.deepEqual(value(await f.recover()), { kind: "terminal", released: false }); assert.equal(f.carrierRequests, 1);
});

for (const grant of ["history", "decoded", "record", "nativeLive", "source", "provider", "providerLive", "release"] as const)
test(`capacity-only recovery requires independent ${grant} approval`, async () => {
  const f = await fixture(); f.recoveryState[grant] = false;
  const result = await f.recover(); assert.ok(!result.ok || result.value.kind === "held");
  assert.equal(f.held.size, 1); assert.equal(f.recoveryState.releases, 0); assert.equal(f.carrierRequests, 1);
});

for (const mode of ["missing", "child", "active", "changedOrigin", "badMac"] as const)
test(`signed completed progress does not release capacity with ${mode} evidence`, async () => {
  const f = await fixture();
  if (mode === "missing") f.native.rows.delete("30");
  if (mode === "child") f.recoveryState.child = true;
  if (mode === "active") f.recoveryState.active = true;
  if (mode === "changedOrigin") f.originalRow.notes = value(encodeOutboundLaunchAttempt({ ...f.original.attempt, attemptedAt: "2026-11-01T10:00:01.000Z" }));
  if (mode === "badMac") f.native.rows.get("30")!.notes = String(f.native.rows.get("30")!.notes).replace("completed", "ringing");
  const result = await f.recover(); assert.ok(!result.ok || result.value.kind === "held");
  assert.equal(f.held.size, 1); assert.equal(f.recoveryState.releases, 0);
});

for (const phase of ["providerRead", "nativeReread", "sqlGate"] as const)
for (const grant of ["nativeLive", "providerLive", "record", "release"] as const)
test(`${grant} withdrawal during ${phase} fences the actual capacity mutation`, async () => {
  const f = await fixture(), withdraw = () => { f.recoveryState[grant] = false; };
  if (phase === "providerRead") f.recoveryState.beforeProvider = withdraw;
  if (phase === "nativeReread") f.recoveryState.beforeNative = () => { if (f.recoveryState.reads === 4) withdraw(); };
  if (phase === "sqlGate") f.recoveryState.beforeRelease = withdraw;
  const result = await f.recover(); assert.ok(!result.ok || result.value.kind === "held");
  assert.equal(f.held.size, 1); assert.equal(f.recoveryState.releases, 0);
});

test("restoring notification under another unapproved MAC key leaves capacity held", async () => {
  const f = await fixture(); const authentication = new TwilioOutboundTerminalObservationAuthentication(Buffer.alloc(32, 99), f.auth.binding());
  const found = await recoverTwilioOutboundNotification(f.recoveryConfig, { ...f.recoveryPorts, authentication }, f.recoveryInput, new AbortController().signal); assert.ok(!found.ok || found.value.kind === "held"); assert.equal(f.held.size, 1); assert.equal(f.recoveryState.reads, 0);
});

test("native family/account selection and shared physical budget must match before any read", async () => {
  for (const change of ["budget", "credential", "family", "scope"] as const) {
    const f = await fixture(), c = f.recoveryConfig;
    const observations = { ...c.observations, ...(change === "budget" ? { rateBudget: { claim: async () => null, observe429: async () => ({ kind: "rateLimited" as const }) } } : {}),
      ...(change === "credential" ? { apiKey: "different-au5" } : {}), ...(change === "family" ? { outboundTerminalObservationRecallTypeId: "62" } : {}),
      ...(change === "scope" ? { scope: { ...c.observations.scope, locationId: "other" } } : {}) };
    assert.equal((await recoverTwilioOutboundNotification({ ...c, observations }, f.recoveryPorts, f.recoveryInput, new AbortController().signal)).ok, false);
    assert.equal(f.recoveryState.reads, 0); assert.equal(f.recoveryState.pages, 0); assert.equal(f.recoveryState.releases, 0);
  }
});

test("one cumulative native allowance covers original reads, both history passes and final reread", async () => {
  const f = await fixture(); f.recoveryConfig.call.maximumNativeRequests = 5; const claims = f.native.claims;
  const found = await f.recover(); assert.ok(!found.ok || found.value.kind === "held");
  assert.ok(f.native.claims - claims <= 5); assert.equal(f.held.size, 1); assert.equal(f.recoveryState.releases, 0);
});

test("an already aborted recovery neither reads nor releases", async () => {
  const f = await fixture(), c = new AbortController(); c.abort(); assert.equal((await f.recover(c.signal)).ok, false);
  assert.equal(f.recoveryState.reads, 0); assert.equal(f.recoveryState.pages, 0); assert.equal(f.recoveryState.releases, 0);
});


test("closed or archived native evidence remains discoverable without inventing new private identities", async () => {
  const f = await fixture(), at = "2026-11-01T10:03:00.000Z";
  for (const row of f.native.rows.values()) Object.assign(row, { archived_at: at, recalled: true, recalled_at: at, updated_at: at });
  assert.deepEqual(value(await f.recover()), { kind: "terminal", released: true });
  assert.ok(f.nativeQueries.some(q => "includeArchived" in q && q.includeArchived));
});
