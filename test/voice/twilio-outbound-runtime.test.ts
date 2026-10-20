import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { TwilioAbbyOutboundRuntime } from "../../src/voice/twilio-outbound-runtime.ts";
import { bindOutboundVoiceRuntime } from "../../src/voice/outbound-runtime.ts";
import type { OutboundOriginalSend } from "../../src/voice/outbound-original-send.ts";
import type { OutboundRuntimeCall } from "../../src/voice/outbound-runtime.ts";
import type { SignedTwilioWebhook } from "../../src/voice/twilio-signed-ingress.ts";
import { outboundLaunchValue } from "../support/outbound-launch.ts";
import { encodeOutboundLaunchAttempt, outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { value } from "../support/outbound-records.ts";

function fixture(options: { response?: (body: Record<string, unknown>) => Response | Promise<Response>; port?: typeof fetch } = {}) {
  let now = "2026-11-01T10:00:00.000Z", calls = 0, fences = 0, acknowledgements = 0;
  const config = { ref: "twilio-abby", profileRef: "generic-outbound", accountSid: `AC${"a".repeat(32)}`, authToken: "synthetic-twilio-secret",
    from: "+61255550100", publicAnswerUrl: "https://clinic.example.invalid/outbound/answer", publicStatusUrl: "https://clinic.example.invalid/outbound/status",
    publicStreamUrl: "wss://clinic.example.invalid/outbound/stream", contextKey: new Uint8Array(32).fill(7), now: () => now };
  const callSid = `CA${"b".repeat(32)}`, streamSid = `MZ${"c".repeat(32)}`;
  let form!: URLSearchParams;
  const port: typeof fetch = options.port ?? (async (url, init) => {
    calls++; assert.equal(String(url), `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`);
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init.signal instanceof AbortSignal, true);
    assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`);
    form = new URLSearchParams(String(init.body));
    const body = { account_sid: config.accountSid, sid: callSid, to: form.get("To"), from: config.from, direction: "outbound-api", status: "queued",
      parent_call_sid: null, uri: `/2010-04-01/Accounts/${config.accountSid}/Calls/${callSid}.json` };
    return options.response ? options.response(body) : Response.json(body, { status: 201 });
  });
  const adapter = new TwilioAbbyOutboundRuntime(config, port), binding = adapter.binding(), seed = outboundLaunchValue();
  const call: OutboundRuntimeCall = { effectRef: seed.attempt.effectRef, capacityAllocationRef: randomUUID(), number: "+61455550123", profileRef: binding.profileRef };
  const original: OutboundOriginalSend = { recallRef: "cliniko:recall:40", attempt: { ...seed.attempt, provider: { ref: binding.ref, bindingDigest: binding.bindingDigest },
    capacityAllocationRef: call.capacityAllocationRef, dncReferences: { actionRef: randomUUID(), approvalRef: randomUUID() },
    contactReferences: { guardRef: randomUUID(), allocationRef: randomUUID(), outcomeActionRef: randomUUID() } } };
  const runtime = value(bindOutboundVoiceRuntime(adapter));
  const gate = async () => { fences++; return true; }, ack = () => { acknowledgements++; };
  const launch = () => runtime.launch.launchOnce(call, new AbortController().signal, gate, ack, original);
  function request(kind: "answer" | "status" = "answer", patch: Record<string, string> = {}): SignedTwilioWebhook {
    const url = form.get(kind === "answer" ? "Url" : "StatusCallback")!;
    const fields = { AccountSid: config.accountSid, CallSid: callSid, From: config.from, To: call.number, Direction: "outbound-api", CallStatus: "in-progress", ...patch };
    const u = new URL(url);
    return { method: "POST", requestTarget: u.pathname + u.search, contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      signature: getExpectedTwilioSignature(config.authToken, url, fields), body: new URLSearchParams(fields).toString() };
  }
  return { config, adapter, runtime, original, call, gate, ack, launch, request, callSid, streamSid,
    get form() { return form; }, get calls() { return calls; }, get fences() { return fences; }, get acknowledgements() { return acknowledgements; },
    setNow: (v: string) => { now = v; } };
}

test("real outbound resource contract: one fenced POST and exact ACK, without native context in the public payload", async () => {
  const f = fixture(); assert.deepEqual(await f.launch(), { kind: "accepted", effectRef: f.call.effectRef });
  assert.equal(f.calls, 1); assert.equal(f.fences, 1); assert.equal(f.acknowledgements, 1);
  assert.deepEqual([...f.form.keys()].sort(), ["From", "Method", "StatusCallback", "StatusCallbackEvent", "StatusCallbackEvent", "StatusCallbackEvent", "StatusCallbackEvent", "StatusCallbackMethod", "To", "Url"].sort());
  assert.deepEqual(f.form.getAll("StatusCallbackEvent"), ["initiated", "ringing", "answered", "completed"]);
  const token = new URL(f.form.get("Url")!).searchParams.get("abbyContext")!;
  assert.equal(token.includes(f.original.recallRef), false);
  assert.equal(Buffer.from(token, "base64url").includes(Buffer.from("Abby possible outbound")), false);
  assert.equal(new URL(f.form.get("StatusCallback")!).searchParams.get("abbyContext"), token);
});
for (const mode of ["missing", "wrongPair", "wrongProvider", "wrongRecall", "noContactHold"] as const)
  test(`original ${mode} refuses before the adapter can issue a request or consume the clinic fence`, async () => {
    const f = fixture(); let original: OutboundOriginalSend | undefined = structuredClone(f.original);
    if (mode === "missing") original = undefined;
    else if (mode === "wrongPair") original = { ...original, attempt: { ...original.attempt, effectRef: randomUUID() } };
    else if (mode === "wrongProvider") original = { ...original, attempt: { ...original.attempt, provider: { ...original.attempt.provider, bindingDigest: "f".repeat(64) } } };
    else if (mode === "wrongRecall") original = { ...original, recallRef: "not-a-native-selection" };
    else { const { contactReferences, ...a } = original.attempt; void contactReferences; original = { ...original, attempt: a }; }
    await f.runtime.launch.launchOnce(f.call, new AbortController().signal, f.gate, f.ack, original);
    assert.equal(f.calls, 0); assert.equal(f.fences, 0); assert.equal(f.acknowledgements, 0);
  });
test("false and delayed aborting final fences cannot dispatch", async () => {
  const f = fixture(), controller = new AbortController();
  await f.runtime.launch.launchOnce(f.call, controller.signal, async () => { controller.abort(); return true; }, f.ack, f.original);
  assert.equal(f.calls, 0);
  await f.adapter.launchOnce(f.call, new AbortController().signal, async () => false, f.ack, f.original); assert.equal(f.calls, 0);
});
test("the actual clock after the final wait cannot outlive the native dispatch window", async () => {
  const f = fixture();
  await f.runtime.launch.launchOnce(f.call, new AbortController().signal, async () => { f.setNow(f.original.attempt.dispatchNotAfter); return true; }, f.ack, f.original);
  assert.equal(f.calls, 0); assert.equal(f.acknowledgements, 0);
});
for (const patch of [{ account_sid: `AC${"d".repeat(32)}` }, { sid: "not-a-call" }, { to: "+61455550999" }, { from: "+61255550999" },
  { direction: "inbound" }, { parent_call_sid: `CA${"e".repeat(32)}` }, { uri: "/foreign" }, { status: "not-a-provider-status" }])
  test(`parsed foreign ACK ${Object.keys(patch)[0]} stays unknown with no retry`, async () => {
    const f = fixture({ response: body => Response.json({ ...body, ...patch }, { status: 201 }) });
    assert.deepEqual(await f.launch(), { kind: "unknown" }); assert.equal(f.calls, 1); assert.equal(f.acknowledgements, 0);
  });
for (const status of [200, 302, 400, 429, 500]) test(`HTTP${status} is never an exact call-created ACK and never retried`, async () => {
  const f = fixture({ response: body => Response.json(body, { status }) }); assert.deepEqual(await f.launch(), { kind: "unknown" });
  assert.equal(f.calls, 1); assert.equal(f.acknowledgements, 0);
});
test("lost ACK, ignored abort and late provider response cannot create retry permission", async () => {
  let entered!: () => void, respond!: (r: Response) => void, calls = 0;
  const began = new Promise<void>(r => { entered = r; });
  const f = fixture({ port: async () => { calls++; entered(); return new Promise<Response>(r => { respond = r; }); } }), controller = new AbortController();
  const pending = f.runtime.launch.launchOnce(f.call, controller.signal, f.gate, f.ack, f.original); await began; controller.abort();
  assert.deepEqual(await pending, { kind: "unknown" }); assert.equal(calls, 1); assert.equal(f.acknowledgements, 0);
  respond(Response.json({ private: "discard" }, { status: 201 })); await new Promise<void>(r => setImmediate(r)); assert.equal(f.acknowledgements, 0);
});
test("exact received ACK is retained when an observer mutates caller input and throws", async () => {
  const f = fixture(), originalRef = f.call.effectRef;
  assert.deepEqual(await f.adapter.launchOnce(f.call, new AbortController().signal, f.gate, () => {
    Object.assign(f.call, { effectRef: randomUUID() }); throw Error("private observer failure");
  }, f.original), { kind: "accepted", effectRef: originalRef });
});
test("authenticated outbound cold recovery preserves ORIGINAL attestation without native rereads or a local map", async () => {
  const f = fixture(); await f.launch(); const digest = outboundLaunchAttemptDigest(f.original.attempt);
  Object.assign(f.original.attempt, { patientId: "999" });
  const cold = new TwilioAbbyOutboundRuntime(f.config, async () => { throw Error("no request needed"); });
  const answer = value(cold.authenticateAnswer(f.request()));
  assert.equal(answer.call.context.attemptDigest, digest); assert.notEqual(answer.call.context.original.attempt.patientId, "999");
  assert.equal(answer.call.clinicNumber, f.config.from); assert.equal(answer.call.recipientNumber, f.call.number);
  assert.equal(answer.call.kind, "authenticatedOutboundCall"); assert.equal("dialedNumber" in answer.call, false);
  assert.equal(Object.isFrozen(answer.call.context.original.attempt.contactReferences), true);
  assert.equal(answer.twiml.includes("<Dial"), false); assert.equal(answer.twiml.includes("<Hangup"), true);
});
for (const patch of [{ AccountSid: `AC${"d".repeat(32)}` }, { From: "+61255550999" }, { To: "+61455550999" }, { Direction: "inbound" },
  { Direction: "outbound-dial" }, { ParentCallSid: `CA${"d".repeat(32)}` }, { CallStatus: "completed" }, { CallSid: "not-a-call" }])
  test(`even validly signed answer ${Object.keys(patch)[0]} cannot borrow the sealed context`, async () => {
    const f = fixture(); await f.launch(); assert.equal(f.adapter.authenticateAnswer(f.request("answer", patch)).ok, false);
  });
test("callback signed URL, body and purpose are exact; new signed fields remain allowed", async () => {
  const f = fixture(); await f.launch(); const r = f.request();
  assert.equal(f.adapter.authenticateAnswer({ ...r, signature: "foreign" }).ok, false);
  assert.equal(f.adapter.authenticateAnswer({ ...r, body: r.body + "&To=%2B61455550123" }).ok, false);
  assert.equal(f.adapter.authenticateAnswer({ ...r, requestTarget: r.requestTarget + "&extra=true" }).ok, false);
  assert.equal(f.adapter.authenticateAnswer({ ...r, requestTarget: r.requestTarget.replace("answer", "status") }).ok, false);
  assert.equal(f.adapter.authenticateAnswer({ ...r, requestTarget: "https://foreign.invalid" + r.requestTarget }).ok, false);
  assert.equal(f.adapter.authenticateAnswer(f.request("answer", { FutureProviderField: "new" })).ok, true);
});
test("configuration and encryption keys are captured; other profiles, accounts and keys cannot open a token", async () => {
  const f = fixture(); await f.launch(); const request = f.request();
  for (const patch of [{ profileRef: "other" }, { accountSid: `AC${"d".repeat(32)}` }, { contextKey: new Uint8Array(32).fill(9) }, { from: "+61255550999" }])
    assert.equal(new TwilioAbbyOutboundRuntime({ ...f.config, ...patch }).authenticateAnswer(request).ok, false);
  f.config.contextKey.fill(0); Object.assign(f.config, { from: "+61255550999" });
  assert.equal(f.adapter.authenticateAnswer(request).ok, true);
});
function mediaRequest(f: ReturnType<typeof fixture>, twiml: string) {
  const parameters: Record<string, string> = {};
  for (const m of twiml.matchAll(/<Parameter name="([^"]+)" value="([^"]+)"\s*\/>/g)) { parameters[m[1]!] = m[2]!; assert.ok(m[1]!.length + m[2]!.length < 500); }
  assert.ok(Object.keys(parameters).length > 1);
  return { method: "GET", requestTarget: "/outbound/stream", signature: getExpectedTwilioSignature(f.config.authToken, f.config.publicStreamUrl, {}),
    connected: JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }),
    start: JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: f.streamSid, start: { streamSid: f.streamSid,
      accountSid: f.config.accountSid, callSid: f.callSid, tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: parameters } }) };
}
test("signed media start binds cold call, account, original context and bounded chunked encrypted parameters", async () => {
  const f = fixture(); await f.launch(); const answer = value(f.adapter.authenticateAnswer(f.request())), request = mediaRequest(f, answer.twiml);
  const cold = new TwilioAbbyOutboundRuntime(f.config), start = value(cold.authenticateStream(request));
  assert.equal(start.call.callSid, f.callSid); assert.equal(start.call.context.attemptDigest, answer.call.context.attemptDigest);
  assert.equal(start.call.context.reportActionRef, answer.call.context.reportActionRef); assert.equal(start.streamSid, f.streamSid);
  for (const patch of [{ signature: "invalid" }, { requestTarget: "/outbound/stream?extra=1" }, { connected: "{}" }])
    assert.equal(cold.authenticateStream({ ...request, ...patch }).ok, false);
  for (const field of ["callSid", "accountSid", "streamSid", "customParameters"]) {
    const start = JSON.parse(request.start); start.start[field] = field === "customParameters" ? { abbyOutbound0: "tamper" } : "foreign";
    assert.equal(cold.authenticateStream({ ...request, start: JSON.stringify(start) }).ok, false);
  }
  f.setNow("2026-11-01T10:03:00.001Z"); assert.equal(cold.authenticateStream(request).ok, false);
});
test("signed completed progress cannot manufacture ALL-call terminal or final no-stop semantics", async () => {
  const f = fixture(); await f.launch();
  const status = value(f.adapter.authenticateStatus(f.request("status", { CallStatus: "completed" })));
  assert.equal(status.status, "completed"); assert.equal("complete" in status, false); assert.equal("contact" in status, false);
  assert.deepEqual(await f.runtime.terminal.inspectTerminal({ effectRef: f.call.effectRef, capacityAllocationRef: f.call.capacityAllocationRef }, new AbortController().signal), { kind: "unknown" });
  assert.equal(f.calls, 1); // No fake provider list scan or local completed-call cache.
});
test("expired original answer cannot mint a fresh stream capability from an old signed callback", async () => {
  const f = fixture(); await f.launch(); const request = f.request();
  f.setNow("2026-11-01T10:10:00.000Z"); assert.equal(f.adapter.authenticateAnswer(request).ok, true);
  f.setNow("2026-11-01T10:10:00.001Z"); assert.equal(f.adapter.authenticateAnswer(request).ok, false);
  // A late signed progress fact still grants no release or new conversation.
  assert.equal(f.adapter.authenticateStatus(f.request("status", { CallStatus: "completed" })).ok, true);
});
test("the private handoff snapshots mutable getters once before validating and passing them to the adapter", async () => {
  const f = fixture(); let reads = 0;
  const original = { attempt: f.original.attempt, get recallRef() { return ++reads === 1 ? "cliniko:recall:40" : "not-native"; } };
  assert.equal((await f.runtime.launch.launchOnce(f.call, new AbortController().signal, f.gate, f.ack, original)).kind, "accepted");
  assert.equal(reads, 1); assert.equal(value(f.adapter.authenticateAnswer(f.request())).call.context.original.recallRef, "cliniko:recall:40");
});
test("an authenticated-envelope tamper is refused even when the provider signs the changed URL", async () => {
  const f = fixture(); await f.launch(); const request = f.request(), url = new URL(f.form.get("Url")!);
  const token = url.searchParams.get("abbyContext")!; url.searchParams.set("abbyContext", (token[0] === "A" ? "B" : "A") + token.slice(1));
  const form = Object.fromEntries(new URLSearchParams(request.body));
  assert.equal(f.adapter.authenticateAnswer({ ...request, requestTarget: url.pathname + url.search,
    signature: getExpectedTwilioSignature(f.config.authToken, url.href, form) }).ok, false);
});
test("aborting an owned never-finishing ACK body cancels it and retains unknown after exactly one dispatch", async () => {
  let reading!: () => void, cancellations = 0; const began = new Promise<void>(r => { reading = r; });
  const f = fixture({ response: () => new Response(new ReadableStream<Uint8Array>({ pull() { reading(); }, cancel() { cancellations++; } }),
    { status: 201, headers: { "Content-Type": "application/json" } }) }), controller = new AbortController();
  const result = f.runtime.launch.launchOnce(f.call, controller.signal, f.gate, f.ack, f.original); await began; controller.abort();
  assert.deepEqual(await result, { kind: "unknown" }); assert.equal(f.calls, 1); assert.equal(cancellations, 1); assert.equal(f.acknowledgements, 0);
});
test("oversized or malformed ACK bodies are discarded without leaking or retrying", async () => {
  for (const text of ["private-invalid-json", "x".repeat(32769)]) {
    const f = fixture({ response: () => new Response(text, { status: 201, headers: { "Content-Type": "application/json" } }) });
    assert.deepEqual(await f.launch(), { kind: "unknown" }); assert.equal(f.calls, 1); assert.equal(f.acknowledgements, 0);
  }
});

test("cold original context retains distinct preallocated session and final-report exclusions", async () => {
  const f = fixture(); await f.launch();
  const one = value(f.adapter.authenticateAnswer(f.request())).call.context;
  const cold = value(new TwilioAbbyOutboundRuntime(f.config).authenticateAnswer(f.request())).call.context;
  assert.match(one.sessionActionRef, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(one.sessionActionRef, one.reportActionRef); assert.deepEqual(one, cold);
});

for (const shape of ["legacyWithoutSession", "aliasedSessionAndReport"] as const)
test(`authenticated sealed ${shape} cannot gain a fresh conversation claim`, async () => {
  const f = fixture(); await f.launch(); const reportRef = randomUUID();
  const payload: unknown[] = [shape === "legacyWithoutSession" ? 1 : 2, f.adapter.binding().bindingDigest,
    f.config.profileRef, f.config.accountSid, f.config.from, f.call.number, reportRef, f.original.recallRef,
    value(encodeOutboundLaunchAttempt(f.original.attempt))];
  if (shape === "aliasedSessionAndReport") payload.push(reportRef);
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", f.config.contextKey, nonce);
  cipher.setAAD(Buffer.from("abby.twilio-outbound.launch.v1"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const token = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
  const request = f.request(), url = new URL(request.requestTarget, f.config.publicAnswerUrl); url.searchParams.set("abbyContext", token);
  const fields = Object.fromEntries(new URLSearchParams(request.body));
  const signed = { ...request, requestTarget: url.pathname + url.search,
    signature: getExpectedTwilioSignature(f.config.authToken, url.href, fields) };
  assert.equal(new TwilioAbbyOutboundRuntime(f.config).authenticateAnswer(signed).ok, false);
});
