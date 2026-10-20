import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { encodeTwilioOutboundReport, decodeTwilioOutboundReport, TwilioOutboundReportAuthentication } from "../../src/cliniko/twilio-outbound-report.ts";
import type { TwilioOutboundReport } from "../../src/cliniko/twilio-outbound-report.ts";
import { twilioOutboundReportValue as fixture } from "../support/twilio-outbound-report.ts";
import { value } from "../support/outbound-records.ts";


for (const stopped of [false, true]) test(`canonical authenticated native report: ${stopped ? "stop" : "no stop"}`, () => {
  const f = fixture(stopped), notes = value(encodeTwilioOutboundReport(f.report)), decoded = value(decodeTwilioOutboundReport(notes));
  assert.deepEqual(decoded, f.report); assert.equal(f.auth.verify(decoded), true);
  assert.equal(f.auth.matchesOriginal(decoded, f.context, decoded.accountSid), true);
  for (const v of [decoded, decoded.scope, decoded.original, decoded.terminal, decoded.contact]) assert.ok(Object.isFrozen(v));
  assert.ok(notes.length <= 1050); assert.equal(Object.hasOwn(decoded, "transcript"), false);
  assert.equal(Object.hasOwn(decoded, "verifiedPatient"), false);
});

test("editing any signed field fails authentication even when its native encoding remains valid", () => {
  const f = fixture(true);
  const changes: Partial<TwilioOutboundReport>[] = [
    { actionRef: randomUUID() }, { scope: { ...f.report.scope, clinicId: "another" } }, { businessId: "888" }, { patientId: "999" },
    { credentialFingerprint: (f.report.credentialFingerprint[0] === "a" ? "b" : "a").repeat(64) }, { original: { ...f.report.original, digest: "c".repeat(64) } },
    { original: { ...f.report.original, recallRef: "cliniko:recall:998" } }, { original: { ...f.report.original, actionRef: randomUUID() } },
    { accountSid: "AC" + "9".repeat(32) }, { callSid: "CA" + "9".repeat(32) }, { number: "+12025550999" },
    { terminal: { ...f.report.terminal!, endedAt: "2026-11-01T10:02:10.000Z" } },
    { terminal: { ...f.report.terminal!, observedAt: "2026-11-01T10:02:10.000Z" } },
    { contact: { kind: "completeNoStop" } }, { contact: { kind: "stopRequested", stoppedAt: "2026-11-01T10:01:01.000Z" } },
    { terminal: null },
    { reportedAt: "2026-11-01T10:03:01.000Z" }, { recordedAt: "2026-11-01T10:04:01.000Z" }, { authentication: "f".repeat(64) },
  ];
  for (const patch of changes) {
    const altered = { ...f.report, ...patch };
    assert.notDeepEqual(altered, f.report, "tamper control must change evidence");
    assert.ok(encodeTwilioOutboundReport(altered).ok, Object.keys(patch).join());
    assert.equal(f.auth.verify(altered), false, Object.keys(patch).join());
  }
});

test("keys/provider selection are captured and another provider or key cannot verify the report", () => {
  const f = fixture(), provider = { ...f.context.original.attempt.provider }, key = Buffer.from(f.key);
  const auth = new TwilioOutboundReportAuthentication(key, provider);
  const selectedKey = auth.authenticationBinding();
  key.fill(0); provider.bindingDigest = "0".repeat(64);
  assert.equal(auth.verify(f.report), true);
  assert.equal(auth.authenticationBinding(), selectedKey);
  assert.match(selectedKey, /^[a-f0-9]{64}$/);
  assert.notEqual(new TwilioOutboundReportAuthentication(Buffer.alloc(32, 19), auth.binding()).authenticationBinding(), selectedKey);
  assert.equal(new TwilioOutboundReportAuthentication(Buffer.alloc(32, 19), auth.binding()).verify(f.report), false);
  assert.equal(new TwilioOutboundReportAuthentication(f.key, { ...auth.binding(), bindingDigest: "f".repeat(64) }).verify(f.report), false);
  assert.equal(new TwilioOutboundReportAuthentication(f.key, { ...auth.binding(), ref: "other" }).verify(f.report), false);
  const reordered = { bindingDigest: auth.binding().bindingDigest, ref: auth.binding().ref };
  assert.equal(new TwilioOutboundReportAuthentication(f.key, reordered).verify(f.report), true);
  assert.equal(new TwilioOutboundReportAuthentication(f.key, reordered).authenticationBinding(), selectedKey);
  assert.equal(Reflect.set(auth, "verify", () => true), false);
  assert.equal(Reflect.set(auth, "matchesOriginal", () => true), false);
  assert.equal(auth.verify({ ...f.report, number: "+12025550999" }), false);
});

test("canonical report refuses alternate wire forms and private or permission extensions", () => {
  const f = fixture(), notes = value(encodeTwilioOutboundReport(f.report)), lines = notes.split("\n"), a = JSON.parse(lines[2]!);
  for (const changed of [notes + "\n", notes.replace("report v1", "report v2"), notes.replace(lines[2]!, " " + lines[2]), "x".repeat(1051)])
    assert.equal(decodeTwilioOutboundReport(changed).ok, false);
  for (const index of [2, 5, 6, 13]) {
    const changed = structuredClone(a); changed[index] += "=";
    assert.equal(decodeTwilioOutboundReport([lines[0], lines[1], JSON.stringify(changed), lines[3]].join("\n")).ok, false);
  }
  for (const patch of [{ transcript: "private caller words" }, { permission: true }, { complete: true }, { contact: { kind: "unknown" } },
    { contact: { kind: "completeNoStop", stoppedAt: f.report.terminal!.endedAt } }, { terminal: { ...f.report.terminal, allCalls: true } }])
    assert.equal(encodeTwilioOutboundReport({ ...f.report, ...patch } as TwilioOutboundReport).ok, false);
  assert.equal(f.auth.sign(f.report).ok, false, "do not silently re-sign an existing report");
});

test("valid dates, interval order and the exact authenticated original context are independently required", () => {
  const f = fixture(true);
  for (const patch of [{ reportedAt: "2026-02-30T10:03:00.000Z" }, { reportedAt: "2026-11-01T10:03:00Z" },
    { recordedAt: "2026-11-01T10:01:00.000Z" }, { contact: { kind: "stopRequested", stoppedAt: "2026-11-01T10:05:00.000Z" } }])
    assert.equal(f.auth.sign({ ...f.unsigned, ...patch } as typeof f.unsigned).ok, false);
  for (const c of [{ ...f.context, reportActionRef: randomUUID() }, { ...f.context, number: "+12025550999" },
    { ...f.context, attemptDigest: "f".repeat(64) }, { ...f.context, original: { ...f.context.original, recallRef: "cliniko:recall:999" } },
    { ...f.context, original: { ...f.context.original, attempt: { ...f.context.original.attempt, patientId: "999" } } }])
    assert.equal(f.auth.matchesOriginal(f.report, c, f.report.accountSid), false);
  assert.equal(f.auth.matchesOriginal(f.report, f.context, "AC" + "9".repeat(32)), false);
  const early = value(f.auth.sign({ ...f.unsigned, contact: { kind: "stopRequested", stoppedAt: "2026-11-01T09:00:00.000Z" } }));
  assert.equal(f.auth.verify(early), true, "authentication alone is not original-context completeness");
  assert.equal(f.auth.matchesOriginal(early, f.context, early.accountSid), false);
});

test("oversized native reports refuse rather than truncate signed evidence", () => {
  const f = fixture(), oversized = { ...f.unsigned, scope: { tenantId: "t".repeat(96), clinicId: "c".repeat(96), locationId: "l".repeat(96) } };
  const signed = f.auth.sign(oversized);
  if (signed.ok) assert.ok(value(encodeTwilioOutboundReport(signed.value)).length <= 1050);
  assert.equal(f.auth.sign({ ...f.unsigned, scope: { ...f.unsigned.scope, tenantId: "t".repeat(97) } }).ok, false);
  assert.throws(() => new TwilioOutboundReportAuthentication(Buffer.alloc(31), f.auth.binding()));
});

test("positive stop evidence may precede call closure; absence of terminal evidence never permits a no-stop assertion", () => {
  const f = fixture(true), report = value(f.auth.sign({ ...f.unsigned, terminal: null,
    reportedAt: "2026-11-01T10:01:10.000Z", recordedAt: "2026-11-01T10:01:11.000Z" }));
  assert.equal(f.auth.matchesOriginal(report, f.context, report.accountSid), true);
  assert.deepEqual(value(decodeTwilioOutboundReport(value(encodeTwilioOutboundReport(report)))), report);
  assert.equal(report.terminal, null); assert.equal(report.contact.kind, "stopRequested");
  assert.equal(f.auth.sign({ ...f.unsigned, terminal: null, contact: { kind: "completeNoStop" } }).ok, false);
});
