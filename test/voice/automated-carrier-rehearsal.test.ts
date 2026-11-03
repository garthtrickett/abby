import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { TwilioVoiceRehearsal } from "../../src/testing/twilio-voice-rehearsal.ts";
import { createRehearsalServer } from "../../src/testing/twilio-rehearsal-server.ts";
import { runRehearsal } from "../../src/testing/twilio-rehearsal-run.ts";
import type { RehearsalCarrier, RehearsalReceipt } from "../../src/testing/twilio-rehearsal-run.ts";

const accountSid = `AC${"1".repeat(32)}`, callSid = `CA${"2".repeat(32)}`;
const config = { accountSid, authToken: "synthetic-rehearsal-token", from: "+6145550101", to: "+6125550199",
  callbackBase: "https://tester.example", runId: "3".repeat(32), expiresAt: 300_000, now: () => 1_000 };
function fixture() {
  let time = 1_000;
  const rehearsal = new TwilioVoiceRehearsal({ ...config, now: () => time });
  function request(step: number, text: string, overrides: Record<string, string> = {}) {
    const fields = { AccountSid: accountSid, CallSid: callSid, From: config.from, To: config.to,
      Direction: "outbound-api", CallStatus: "in-progress", SpeechResult: text, ...overrides };
    const target = `/voice-rehearsal/${config.runId}/${step}`;
    return { method: "POST", target, contentType: "application/x-www-form-urlencoded", body: new URLSearchParams(fields).toString(),
      signature: getExpectedTwilioSignature(config.authToken, config.callbackBase + target, fields) };
  }
  return { rehearsal, request, expire: () => { time = config.expiresAt; } };
}
const replies = ["Hello this is Abby in a phone audio test.", "Hello. I heard your test greeting.",
  "I heard the test word blue.", "I heard the test word green."];

test("automatic carrier caller: exact signed dialogue plus completed provider leg passes only that milestone", () => {
  const { rehearsal, request } = fixture(); rehearsal.bindCall(callSid);
  assert.match(rehearsal.initialTwiml(), /speechModel="deepgram_nova-3"/);
  for (const [step, reply] of replies.entries()) {
    const result = rehearsal.accept(request(step, reply)); assert.equal(result.status, 200);
    assert.match(result.xml!, step === 3 ? /<Hangup\/>/ : /<Say/);
  }
  assert.equal(rehearsal.summary().carrierDialoguePassed, false);
  rehearsal.observeTerminal(callSid, "completed");
  const summary = rehearsal.summary(); assert.equal(summary.carrierDialoguePassed, true);
  assert.equal(summary.interruption, "notRun"); assert.equal(summary.fallbackRinging, "notRun");
  assert.equal(summary.normalHangupNoFallback, "unverified"); assert.equal(summary.clinicalAcceptance, false);
  assert(!JSON.stringify(summary).includes(replies[0]!));
});

test("automatic carrier caller: forged, other-call/account/number, duplicate-field and reordered callbacks cannot advance", () => {
  const { rehearsal, request, expire } = fixture(); rehearsal.bindCall(callSid);
  const valid = request(0, replies[0]!);
  const bad = [
    { ...valid, signature: "bad" }, { ...valid, target: valid.target + "?extra=1" },
    { ...valid, body: valid.body + "&SpeechResult=duplicate" }, { ...valid, contentType: "application/json" },
    { ...valid, body: "x".repeat(16_385) }, request(0, replies[0]!, { CallSid: `CA${"4".repeat(32)}` }),
    request(0, replies[0]!, { AccountSid: `AC${"4".repeat(32)}` }),
    request(0, replies[0]!, { From: "+6145550102" }), request(0, replies[0]!, { To: "+6125550188" }),
    request(0, replies[0]!, { Direction: "inbound" }),
  ];
  for (const req of bad) assert.equal(rehearsal.accept(req).status, 403);
  assert.equal(rehearsal.accept(request(1, replies[1]!)).status, 409);
  assert.equal(rehearsal.summary().matchedSteps.length, 0);
  expire(); assert.equal(rehearsal.accept(valid).status, 403);
});

test("automatic carrier caller: exact retry returns same response and conflicting retry cannot change the script", () => {
  const { rehearsal, request } = fixture(); rehearsal.bindCall(callSid);
  const first = request(0, replies[0]!); const result = rehearsal.accept(first);
  assert.deepEqual(rehearsal.accept(first), result);
  assert.equal(rehearsal.summary().matchedSteps.length, 1);
  assert.equal(rehearsal.accept(request(0, "A different Abby test response")).status, 409);
  assert.throws(() => rehearsal.bindCall(callSid));
});

test("automatic carrier caller: wrong/empty/negated response hangs up; terminal status alone cannot pass", () => {
  for (const text of ["", "I cannot hear any speech", "A real patient private canary"]) {
    const { rehearsal, request } = fixture(); rehearsal.bindCall(callSid);
    assert.match(rehearsal.accept(request(0, text)).xml!, /<Hangup\/>/);
    rehearsal.observeTerminal(callSid, "completed");
    assert.equal(rehearsal.summary().carrierDialoguePassed, false);
    assert.equal(rehearsal.summary().failed, true);
    assert(!JSON.stringify(rehearsal.summary()).includes(text || "private canary"));
  }
  const { rehearsal, request } = fixture(); rehearsal.bindCall(callSid);
  rehearsal.accept(request(0, replies[0]!)); rehearsal.accept(request(1, replies[1]!));
  rehearsal.accept(request(2, "I did not hear the word blue"));
  assert.equal(rehearsal.summary().failed, true);
});

test("automatic carrier caller: real local HTTP callback host authenticates and returns deterministic TwiML without storing speech", async () => {
  const { rehearsal, request } = fixture(); rehearsal.bindCall(callSid); let changed = 0;
  const server = createRehearsalServer(rehearsal, () => changed++, config.runId);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const req = request(0, replies[0]!);
    const denied = await fetch(base + req.target, { method: "POST", body: req.body });
    assert.equal(denied.status, 403); assert.equal(changed, 0);
    const accepted = await fetch(base + req.target, { method: "POST", body: req.body,
      headers: { "content-type": req.contentType, "x-twilio-signature": req.signature } });
    assert.equal(accepted.status, 200); assert.match(await accepted.text(), /<Say[^>]*>Hello\.<\/Say>/);
    assert.equal(changed, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

function carrier(overrides: Partial<RehearsalCarrier> = {}): RehearsalCarrier {
  return { eligibleCaller: async () => true, launch: async () => callSid, status: async () => "completed", end: async () => {}, ...overrides };
}

test("automatic carrier caller: unverified origin and failed intent journal produce zero physical calls", async () => {
  for (const eligible of [false, true]) {
    const { rehearsal } = fixture(); let launches = 0;
    await assert.rejects(runRehearsal(rehearsal, carrier({ eligibleCaller: async () => eligible,
      launch: async () => { launches++; return callSid; } }), () => { throw Error("disk unavailable"); }, { signal: new AbortController().signal }));
    assert.equal(launches, 0);
  }
});

test("automatic carrier caller: lost create acknowledgement is recorded unknown and never retried or looked up", async () => {
  const { rehearsal } = fixture(); let launches = 0, reads = 0; const receipts: RehearsalReceipt[] = [];
  await assert.rejects(runRehearsal(rehearsal, carrier({ launch: async () => { launches++; throw Error("lost ACK"); },
    status: async () => { reads++; return "completed"; } }), r => receipts.push(r), { signal: new AbortController().signal }));
  assert.equal(launches, 1); assert.equal(reads, 0);
  assert.deepEqual(receipts.map(r => r.phase), ["launchIntent", "launchUnknown"]);
});

test("automatic carrier caller: timeout cleans only acknowledged leg; unavailable terminal remains unverified", async () => {
  const { rehearsal } = fixture(); let time = 0; const ended: string[] = [], receipts: RehearsalReceipt[] = [];
  const result = await runRehearsal(rehearsal, carrier({ status: async () => "in-progress",
    end: async sid => { ended.push(sid); } }), r => receipts.push(r), {
    signal: new AbortController().signal, now: () => time, wait: async () => { time += 210_000; } });
  assert.deepEqual(ended, [callSid]); assert.equal(result.carrierDialoguePassed, false);
  assert.equal(result.providerTerminal, "unverified"); assert.equal(receipts.at(-1)?.phase, "terminalUnknown");
});

test("automatic carrier caller: busy/no-answer and wrong terminal identity cannot pass", async () => {
  for (const status of ["busy", "no-answer", "failed"]) {
    const { rehearsal } = fixture();
    const result = await runRehearsal(rehearsal, carrier({ status: async () => status }), () => {}, { signal: new AbortController().signal });
    assert.equal(result.carrierDialoguePassed, false); assert.equal(result.providerTerminal, status);
  }
  const { rehearsal } = fixture(); rehearsal.bindCall(callSid);
  assert.throws(() => rehearsal.observeTerminal(`CA${"4".repeat(32)}`, "completed"));
});


test("automatic carrier caller: journal failure after ACK still cleans only that owned call", async () => {
  const { rehearsal } = fixture(); const ended: string[] = [];
  await assert.rejects(runRehearsal(rehearsal, carrier({ end: async sid => { ended.push(sid); } }),
    receipt => { if (receipt.phase !== "launchIntent") throw Error("journal unavailable"); },
    { signal: new AbortController().signal }));
  assert.deepEqual(ended, [callSid]); assert.equal(rehearsal.summary().carrierDialoguePassed, false);
});


test("automatic carrier caller: whole coordinator uses signed local HTTP callbacks and verifies exact terminal", async () => {
  const { rehearsal, request } = fixture(); let complete = false; let drive: Promise<void> | undefined;
  const receipts: RehearsalReceipt[] = [];
  const server = createRehearsalServer(rehearsal, () => {}, config.runId);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(await (await fetch(base + "/healthz")).text(), config.runId);
    const result = await runRehearsal(rehearsal, carrier({
      launch: async () => {
        drive = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
          for (const [step, text] of replies.entries()) {
            const req = request(step, text);
            const response = await fetch(base + req.target, { method: "POST", body: req.body,
              headers: { "content-type": req.contentType, "x-twilio-signature": req.signature } });
            assert.equal(response.status, 200);
            assert.match(await response.text(), step === 3 ? /<Hangup\/>/ : /<Say/);
          }
          complete = true;
        });
        return callSid;
      },
      status: async sid => { assert.equal(sid, callSid); return complete ? "completed" : "in-progress"; },
    }), receipt => receipts.push(receipt), { signal: new AbortController().signal,
      wait: () => new Promise(resolve => setTimeout(resolve, 10)) });
    await drive; assert(result.carrierDialoguePassed);
    assert.equal(receipts.at(-1)?.phase, "terminal");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test("automatic carrier caller: cancellation during eligibility or intent never launches a physical call", async () => {
  for (const during of ["eligibility", "intent"]) {
    const { rehearsal } = fixture(); const stop = new AbortController(); let launches = 0;
    const receipts: RehearsalReceipt[] = [];
    await assert.rejects(runRehearsal(rehearsal, carrier({
      eligibleCaller: async () => { await Promise.resolve(); if (during === "eligibility") stop.abort(); return true; },
      launch: async () => { launches++; return callSid; },
    }), receipt => { receipts.push(receipt); if (during === "intent") stop.abort(); }, { signal: stop.signal }),
    /Test canceled before launch/);
    assert.equal(launches, 0);
    assert.deepEqual(receipts.map(receipt => receipt.phase), during === "intent" ? ["launchIntent"] : []);
  }
});

test("automatic carrier caller: cancellation during terminal read invalidates even a fully matched dialogue", async () => {
  const { rehearsal, request } = fixture(); const stop = new AbortController(); const ended: string[] = [];
  const receipts: RehearsalReceipt[] = []; let reads = 0;
  const result = await runRehearsal(rehearsal, carrier({
    status: async sid => {
      assert.equal(sid, callSid);
      if (++reads === 1) {
        for (const [step, reply] of replies.entries()) assert.equal(rehearsal.accept(request(step, reply)).status, 200);
        await Promise.resolve(); stop.abort();
      }
      return "completed";
    }, end: async sid => { ended.push(sid); },
  }), receipt => receipts.push(receipt), { signal: stop.signal });
  assert.equal(result.matchedSteps.length, 4); assert.equal(result.providerTerminal, "completed");
  assert.equal(result.failed, true); assert.equal(result.carrierDialoguePassed, false);
  assert.deepEqual(ended, [callSid]); assert.equal(receipts.at(-1)?.summary.carrierDialoguePassed, false);
});
