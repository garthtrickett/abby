import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { TwilioVoiceRehearsal } from "../../src/testing/twilio-voice-rehearsal.ts";
import type { RehearsalConfig } from "../../src/testing/twilio-voice-rehearsal.ts";
import { TwilioRehearsalFallback } from "../../src/testing/twilio-rehearsal-fallback.ts";
import { runRehearsal } from "../../src/testing/twilio-rehearsal-run.ts";
import { rehearsalTargetSnapshot, qualifyRehearsalObservation } from "../../src/testing/twilio-rehearsal-observation.ts";
import type { RehearsalScenario } from "../../src/testing/twilio-voice-rehearsal.ts";
import type { RehearsalCallStatistics } from "../../src/testing/restricted-twilio-target.ts";
import { rehearsalLegObserver } from "../../src/testing/twilio-rehearsal-legs.ts";
import { createRehearsalServer } from "../../src/testing/twilio-rehearsal-server.ts";

const accountSid = "AC" + "1".repeat(32), callSid = "CA" + "2".repeat(32);
const parent = "CA" + "4".repeat(32), child = "CA" + "5".repeat(32);
const config = { accountSid, authToken: "synthetic-only", from: "+15555550101", to: "+15555550102",
  callbackBase: "https://tester.example", runId: "3".repeat(32), expiresAt: 300_000, now: () => 1_000 };

test("carrier probe CLI exposes the normal dialogue scenario without contacting the provider", () => {
  const script = fileURLToPath(new URL("../../dist/runtime/scripts/rehearse-twilio-probe.js", import.meta.url));
  const env = { PATH: process.env.PATH, ABBY_VOICE_TEST_MODE: "1",
    ABBY_TWILIO_ACCOUNT_SID: accountSid, ABBY_TWILIO_AUTH_TOKEN: "synthetic-only",
    ABBY_TWILIO_TEST_CALLER_NUMBER: config.from, ABBY_TWILIO_TEST_NUMBER: config.to,
    ABBY_TWILIO_FALLBACK_NUMBER: "+15555550103",
    ABBY_REHEARSAL_CALLBACK_BASE: config.callbackBase } satisfies NodeJS.ProcessEnv;
  const dryRun = spawnSync(process.execPath, [script, "--dry-run", "dialogue"],
    { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const plan = JSON.parse(dryRun.stdout) as Record<string, unknown>;
  assert.equal(plan.scenario, "dialogue"); assert.equal(plan.calls, 1);
  assert.equal(plan.clinicalAcceptance, false); assert.equal(plan.recordingEnabled, false);
  const invalid = spawnSync(process.execPath, [script, "--dry-run", "unapproved"],
    { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(invalid.status, 1);
});
function reply(text: string, step = 0) {
  const target = `/voice-rehearsal/${config.runId}/${step}`;
  const fields = { AccountSid: accountSid, CallSid: callSid, From: config.from, To: config.to,
    Direction: "outbound-api", CallStatus: "in-progress", SpeechResult: text };
  return { method: "POST", target, contentType: "application/x-www-form-urlencoded",
    signature: getExpectedTwilioSignature(config.authToken, config.callbackBase + target, fields),
    body: new URLSearchParams(fields).toString() };
}
function fallback() {
  let now = 1_000;
  const callbackUrl = config.callbackBase + "/fallback-ringing/" + config.runId;
  const collector = new TwilioRehearsalFallback({ accountSid, authToken: config.authToken, callbackUrl,
    fallback: "+15555550103", expiresAt: config.expiresAt, now: () => now });
  function event(overrides: Record<string, string> = {}) {
    const fields = { AccountSid: accountSid, CallSid: child, ParentCallSid: parent, To: "+15555550103",
      CallbackSource: "call-progress-events",
      Direction: "outbound-dial", CallStatus: "ringing", SequenceNumber: "1", ...overrides };
    return { method: "POST", target: new URL(callbackUrl).pathname, contentType: "application/x-www-form-urlencoded",
      signature: getExpectedTwilioSignature(config.authToken, callbackUrl, fields),
      body: new URLSearchParams(fields).toString() };
  }
  return { collector, event, expire: () => { now = config.expiresAt; } };
}

test("carrier probe: explicit fixed interruption script cannot turn reply recognition into a qualified interruption", () => {
  assert.throws(() => new TwilioVoiceRehearsal({ ...config, scenario: "other" } as unknown as RehearsalConfig));
  const rehearsal = new TwilioVoiceRehearsal({ ...config, scenario: "interruption" });
  const xml = rehearsal.initialTwiml();
  assert.match(xml, /<Pause length="25"\/><Say>Count\.<\/Say><Pause length="3"\/><Say>Hello\.<\/Say><Gather/);
  assert.match(xml, /speechModel="deepgram_nova-3"/); assert.match(xml, /<Hangup\/>/);
  rehearsal.bindCall(callSid);
  const request = reply("Hello. I heard your test greeting.");
  assert.equal(rehearsal.accept({ ...request, signature: "bad" }).status, 403);
  const accepted = rehearsal.accept(request);
  assert.equal(accepted.status, 200);
  assert.match(accepted.xml!, /<Pause length="20"\/><Hangup\/>/);
  assert.deepEqual(rehearsal.accept(request), accepted);
  rehearsal.observeTerminal(callSid, "completed");
  assert.equal(rehearsal.summary().scriptMatched, true);
  assert.equal(rehearsal.summary().interruption, "unverified");
  assert.equal(rehearsal.summary().carrierDialoguePassed, false);
  assert.deepEqual(rehearsal.summary().matchedSteps, ["replacement"]);
});

test("carrier probe: missing or wrong replacement reply fails and never persists recognized words", () => {
  for (const text of ["", "Hello this is Abby in a test", "I did not hear your greeting", "private canary detail"]) {
    const rehearsal = new TwilioVoiceRehearsal({ ...config, scenario: "interruption" }); rehearsal.bindCall(callSid);
    const xml = rehearsal.accept(reply(text)).xml!;
    assert.match(xml, /<Hangup\/>/); assert.doesNotMatch(xml, /<Pause/);
    rehearsal.observeTerminal(callSid, "completed");
    assert.equal(rehearsal.summary().scriptMatched, false); assert.equal(rehearsal.summary().failed, true);
    assert(!JSON.stringify(rehearsal.summary()).includes("private canary"));
  }
});

test("carrier probe: fallback sends only the approved keypad action and completion proves no ringing", () => {
  const rehearsal = new TwilioVoiceRehearsal({ ...config, scenario: "fallback" });
  const xml = rehearsal.initialTwiml();
  assert.match(xml, /<Pause length="25"\/><Play digits="9"\/><Pause length="20"\/><Hangup\/>/);
  assert(!xml.includes("<Say")); assert(!xml.includes("<Gather"));
  rehearsal.bindCall(callSid); assert.equal(rehearsal.accept(reply("Hello. I heard your test greeting.")).status, 403);
  rehearsal.observeTerminal(callSid, "completed");
  assert.equal(rehearsal.summary().scriptMatched, false);
  assert.equal(rehearsal.summary().fallbackRinging, "unverified");
  assert.equal(rehearsal.summary().carrierDialoguePassed, false);
});

test("carrier probe: the existing one-create journal owns explicit interruption launch and exact terminal", async () => {
  const rehearsal = new TwilioVoiceRehearsal({ ...config, scenario: "interruption" });
  let creates = 0; const phases: string[] = [];
  const result = await runRehearsal(rehearsal, { eligibleCaller: async () => true,
    async launch(xml) { creates++; assert.match(xml, /<Say>Count\.<\/Say>/); return callSid; },
    async status(sid) {
      assert.equal(sid, callSid); assert.equal(rehearsal.accept(reply("Hello. I heard your test greeting.")).status, 200);
      return "completed";
    }, async end() { assert.fail("terminal call needs no cleanup send"); },
  }, receipt => phases.push(receipt.phase), { signal: new AbortController().signal, now: () => 1_000 });
  assert.equal(creates, 1); assert.deepEqual(phases, ["launchIntent", "bound", "terminal"]);
  assert.equal(result.scriptMatched, true); assert.equal(result.interruption, "unverified");
});

test("fallback evidence: an early signed ringing event waits for exact target and child identity", () => {
  const { collector, event } = fallback();
  assert.equal(collector.accept(event()).status, 204); assert.equal(collector.ringing(child), false);
  collector.bindTarget(parent); assert.equal(collector.ringing(child), true);
  assert.equal(collector.ringing("CA" + "6".repeat(32)), false);
  assert.throws(() => collector.bindTarget(parent));
  assert.equal(collector.accept(event({ ParentCallSid: "CA" + "7".repeat(32) })).status, 403);
});

test("fallback evidence: forged, cross-account, other-number, malformed and expired callbacks cannot supply ringing", () => {
  const { collector, event, expire } = fallback(); collector.bindTarget(parent);
  const valid = event();
  const bad = [{ ...valid, signature: "bad" }, { ...valid, method: "GET" }, { ...valid, target: valid.target + "?extra=1" },
    { ...valid, contentType: "application/json" }, { ...valid, body: "x".repeat(16_385) },
    { ...valid, body: valid.body + "&CallStatus=ringing" },
    event({ AccountSid: "AC" + "8".repeat(32) }), event({ To: "+15555550104" }), event({ Direction: "outbound-api" }),
    event({ CallbackSource: "other" }),
    event({ CallSid: "bad" }), event({ ParentCallSid: child }), event({ SequenceNumber: "01" }), event({ CallStatus: "other" })];
  for (const request of bad) assert.equal(collector.accept(request).status, 403);
  assert.equal(collector.ringing(child), false); expire();
  assert.equal(collector.accept(valid).status, 403); assert.equal(collector.ringing(child), false);
});

test("fallback evidence: duplicate events are stable, conflicts and overflow refuse a passing classification", () => {
  const first = fallback(); first.collector.bindTarget(parent);
  assert.equal(first.collector.accept(first.event()).status, 204);
  assert.equal(first.collector.accept(first.event()).status, 204); assert.equal(first.collector.ringing(child), true);
  assert.equal(first.collector.accept(first.event({ CallStatus: "completed" })).status, 409);
  assert.equal(first.collector.ringing(child), false);
  const full = fallback(); full.collector.bindTarget(parent);
  for (let index = 0; index < 16; index++) assert.equal(full.collector.accept(full.event({ SequenceNumber: String(index) })).status, 204);
  assert.equal(full.collector.ringing(child), true);
  assert.equal(full.collector.accept(full.event({ SequenceNumber: "15" })).status, 204);
  assert.equal(full.collector.accept(full.event({ SequenceNumber: "16" })).status, 409);
  assert.equal(full.collector.ringing(child), false);
});

test("fallback evidence: successful connection or completion without ringing is insufficient", () => {
  const { collector, event } = fallback(); collector.bindTarget(parent);
  assert.equal(collector.accept(event({ CallStatus: "in-progress" })).status, 204);
  assert.equal(collector.accept(event({ CallStatus: "completed", SequenceNumber: "2" })).status, 204);
  assert.equal(collector.ringing(child), false);
});

test("fallback callback route: loopback listener accepts only the exact signed path", async () => {
  const { collector, event } = fallback(); let changes = 0;
  const server = createRehearsalServer(new TwilioVoiceRehearsal({ ...config, scenario: "fallback" }),
    () => { changes++; }, config.runId, { path: `/fallback-ringing/${config.runId}`, accept: request => collector.accept(request) });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address === "object");
  const local = `http://127.0.0.1:${address.port}`;
  try {
    const request = event();
    const accepted = await fetch(local + request.target, { method: "POST", headers: {
      "content-type": request.contentType!, "x-twilio-signature": request.signature! }, body: request.body });
    assert.equal(accepted.status, 204); assert.equal(changes, 1);
    collector.bindTarget(parent); assert.equal(collector.ringing(child), true);
    const bad = await fetch(local + request.target + "?wrong=1", { method: "POST", headers: {
      "content-type": request.contentType!, "x-twilio-signature": request.signature! }, body: request.body });
    assert.equal(bad.status, 403); assert.equal(changes, 1);
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  }
});

function observation(scenario: RehearsalScenario) {
  const rehearsal = new TwilioVoiceRehearsal({ ...config, scenario }); rehearsal.bindCall(callSid);
  if (scenario === "interruption") rehearsal.accept(reply("Hello. I heard your test greeting."));
  if (scenario === "dialogue") for (const [index, text] of ["Abby test", "Hello. I heard your test greeting.",
    "I heard the test word blue.", "I heard the test word green."].entries()) rehearsal.accept(reply(text, index));
  rehearsal.observeTerminal(callSid, "completed");
  const statistics: RehearsalCallStatistics = { session: 1, callSid: parent, started: true,
    turns: scenario === "fallback" ? 0 : scenario === "dialogue" ? 3 : 2, repliesQueued: 2,
    played: scenario === "fallback" ? 1 : scenario === "dialogue" ? 4 : 2,
    interruptions: scenario === "interruption" ? 1 : 0, clearAcknowledged: scenario === "interruption" ? 1 : 0,
    dtmfFallback: scenario === "fallback", stopped: scenario !== "fallback", failed: false, failureStage: "none",
    active: 0, total: 1, expiresAt: new Date(300_000).toISOString() };
  const report = { runId: "9".repeat(32), phase: "listening", at: new Date(4_000).toISOString(),
    expiresAt: statistics.expiresAt, active: 0, total: 1, windowOpen: true, latest: statistics,
    clinicalAutomationEnabled: false, audioOrTranscriptPersisted: false, speechQualificationPassed: false };
  const before = rehearsalTargetSnapshot({ ...report, at: new Date(1_000).toISOString(), total: 0, latest: null }, 5_000);
  const after = rehearsalTargetSnapshot(report, 5_000);
  const target = { sid: parent, accountSid, from: config.from, to: config.to, direction: "inbound",
    status: "completed", parentCallSid: null, startTime: new Date(2_500) };
  const selected = { accountSid, caller: config.from, number: config.to, fallback: "+15555550103", scenario };
  const events = fallback(); events.collector.accept(events.event()); events.collector.bindTarget(parent);
  const childCall = { ...target, sid: child, parentCallSid: parent, direction: "outbound-dial", to: selected.fallback };
  const evidence = { callerSid: callSid, launchedAt: 2_000, now: 5_000, caller: rehearsal.summary(), before, after,
    target, children: { complete: true, calls: scenario === "fallback" ? [childCall] : [] }, fallbackEvents: events.collector };
  return { selected, evidence, report, childCall };
}

test("carrier observation: malformed target reports refuse and allowlisted snapshots discard unexpected data", () => {
  const { report } = observation("interruption");
  for (const bad of [null, [], { ...report, clinicalAutomationEnabled: true }, { ...report, audioOrTranscriptPersisted: true },
    { ...report, speechQualificationPassed: true }, { ...report, active: "0" }, { ...report, total: 7 },
    { ...report, phase: "stopped" }, { ...report, at: new Date(6_000).toISOString() },
    { ...report, expiresAt: "invalid" }, { ...report, windowOpen: false }, { ...report, latest: null },
    { ...report, latest: { ...report.latest, active: 1 } }, { ...report, latest: { ...report.latest, played: "2" } }]) {
    assert.throws(() => rehearsalTargetSnapshot(bad, 5_000), /observation unavailable/);
  }
  const allowed = rehearsalTargetSnapshot({ ...report, privateCanary: "never persist",
    latest: { ...report.latest, privateCanary: "never persist" } }, 5_000);
  assert(!JSON.stringify(allowed).includes("privateCanary")); assert(!JSON.stringify(allowed).includes("never persist"));
});

test("carrier observation: interruption requires same-run fresh target, exact native identity, replacement and clear", () => {
  const { selected, evidence, childCall } = observation("interruption");
  assert.equal(qualifyRehearsalObservation(selected, evidence).carrierScenarioPassed, true);
  const wrong = [{ ...evidence, now: 65_001 }, { ...evidence, callerSid: parent },
    { ...evidence, caller: { ...evidence.caller, scriptMatched: false } },
    { ...evidence, caller: { ...evidence.caller, providerTerminal: "busy" } },
    { ...evidence, after: { ...evidence.after, runId: "0".repeat(32) } },
    { ...evidence, after: { ...evidence.after, total: 2 } },
    { ...evidence, after: { ...evidence.after, at: 1_000 } },
    { ...evidence, target: { ...evidence.target, accountSid: "AC" + "a".repeat(32) } },
    { ...evidence, target: { ...evidence.target, sid: child } },
    { ...evidence, target: { ...evidence.target, from: "+15555550104" } },
    { ...evidence, target: { ...evidence.target, to: "+15555550104" } },
    { ...evidence, target: { ...evidence.target, direction: "outbound-api" } },
    { ...evidence, target: { ...evidence.target, startTime: new Date(0) } },
    { ...evidence, target: { ...evidence.target, status: "in-progress" } },
    { ...evidence, children: { complete: false, calls: [] } },
    { ...evidence, children: { complete: true, calls: [childCall] } }];
  for (const item of wrong) assert.equal(qualifyRehearsalObservation(selected, item).carrierScenarioPassed, false);
  for (const patch of [{ clearAcknowledged: 0 }, { interruptions: 0 }, { played: 1 }, { played: 3 }, { turns: 1 },
    { failed: true }, { stopped: false }, { dtmfFallback: true }]) {
    const after = { ...evidence.after, latest: { ...evidence.after.latest!, ...patch } };
    assert.equal(qualifyRehearsalObservation(selected, { ...evidence, after }).carrierScenarioPassed, false);
  }
});

test("carrier observation: signed ringing and independent exact fallback child are both required", () => {
  const { selected, evidence, childCall } = observation("fallback");
  const result = qualifyRehearsalObservation(selected, evidence);
  assert.equal(result.carrierScenarioPassed, true); assert.equal(result.fallbackRinging, "passed");
  assert.equal(qualifyRehearsalObservation(selected, { ...evidence, now: 35_000 }).carrierScenarioPassed, true);
  assert.equal(qualifyRehearsalObservation(selected, { ...evidence, now: 65_001 }).carrierScenarioPassed, false);
  assert.equal(result.normalHangupNoFallback, "unverified"); assert.equal(result.clinicalAcceptance, false);
  const silent = fallback(); silent.collector.bindTarget(parent);
  assert.equal(qualifyRehearsalObservation(selected, { ...evidence, fallbackEvents: silent.collector }).carrierScenarioPassed, false);
  for (const patch of [{ parentCallSid: child }, { accountSid: "AC" + "b".repeat(32) },
    { to: "+15555550104" }, { direction: "inbound" }, { sid: callSid }, { status: "in-progress" }]) {
    assert.equal(qualifyRehearsalObservation(selected, { ...evidence,
      children: { complete: true, calls: [{ ...childCall, ...patch }] } }).carrierScenarioPassed, false);
  }
  assert.equal(qualifyRehearsalObservation(selected, { ...evidence,
    children: { complete: false, calls: [childCall] } }).carrierScenarioPassed, false);
  assert.equal(qualifyRehearsalObservation(selected, { ...evidence,
    children: { complete: true, calls: [childCall, childCall] } }).carrierScenarioPassed, false);
});

test("carrier observation: normal hangup also requires clean target stop and complete absence of fallback", () => {
  const { selected, evidence, childCall } = observation("dialogue");
  const result = qualifyRehearsalObservation(selected, evidence);
  assert.equal(result.carrierScenarioPassed, true); assert.equal(result.normalHangupNoFallback, "passed");
  assert.equal(qualifyRehearsalObservation(selected, { ...evidence,
    after: { ...evidence.after, latest: { ...evidence.after.latest!, stopped: false } } }).carrierScenarioPassed, false);
  assert.equal(qualifyRehearsalObservation(selected, { ...evidence,
    children: { complete: true, calls: [childCall] } }).carrierScenarioPassed, false);
  assert.equal(qualifyRehearsalObservation(selected, { ...evidence,
    children: { complete: false, calls: [] } }).carrierScenarioPassed, false);
});

test("carrier leg readback: exact parent and complete child page are required", async () => {
  const seen: string[] = [];
  const target = { sid: parent, account_sid: accountSid, from: config.from, to: config.to,
    direction: "inbound", status: "completed", parent_call_sid: null, start_time: new Date(2_500).toISOString() };
  const childCall = { ...target, sid: child, parent_call_sid: parent, direction: "outbound-dial" };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); seen.push(url);
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    assert.equal(init?.headers && "authorization" in init.headers, true);
    if (url.endsWith(`/Calls/${parent}.json`)) return Response.json(target);
    if (url.includes("/Calls.json?")) return Response.json({ calls: [childCall], next_page_uri: null });
    assert.fail("unexpected provider read");
  }) as typeof fetch;
  const reader = rehearsalLegObserver(accountSid, "synthetic-only", fetcher);
  assert.equal((await reader.target(parent)).sid, parent);
  assert.deepEqual((await reader.children(parent)).calls.map(x => x.sid), [child]);
  assert.equal(seen.length, 2);
  assert.equal(new URL(seen[1]!).searchParams.get("ParentCallSid"), parent);
  assert.equal(new URL(seen[1]!).searchParams.get("PageSize"), "20");
});

test("carrier leg readback: wrong account/parent, incomplete page and invalid payloads fail closed", async () => {
  const base = { sid: parent, account_sid: accountSid, from: config.from, to: config.to,
    direction: "inbound", status: "completed", parent_call_sid: null, start_time: new Date(2_500).toISOString() };
  const read = (payload: unknown) => rehearsalLegObserver(accountSid, "synthetic-only",
    (async () => Response.json(payload)) as typeof fetch);
  await assert.rejects(read({ ...base, sid: child }).target(parent), /identity unavailable/);
  await assert.rejects(read({ ...base, account_sid: "AC" + "9".repeat(32) }).target(parent), /identity unavailable/);
  for (const payload of [null, {}, { calls: [], next_page_uri: "/next" },
    { calls: [{ ...base, parent_call_sid: child }], next_page_uri: null },
    { calls: [{ ...base, parent_call_sid: parent, account_sid: "AC" + "9".repeat(32) }], next_page_uri: null }]) {
    if (payload && typeof payload === "object" && "calls" in payload && Array.isArray(payload.calls) &&
        payload.calls.length === 0 && payload.next_page_uri === "/next") {
      assert.equal((await read(payload).children(parent)).complete, false);
    } else await assert.rejects(read(payload).children(parent));
  }
});
