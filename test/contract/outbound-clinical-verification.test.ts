import assert from "node:assert/strict";
import test from "node:test";
import { CallerVerificationSession } from "../../src/standalone/caller-verification-session.ts";
import { ClinikoVerificationContactReader } from "../../src/cliniko/verification-contact.ts";
import { ClinikoOutboundClinicalContext } from "../../src/standalone/cliniko-outbound-clinical-context.ts";
import { outboundClinicalVerificationFixture } from "../support/outbound-clinical-verification.ts";
import { value, outboundNow } from "../support/outbound-records.ts";

async function verify(f: Awaited<ReturnType<typeof outboundClinicalVerificationFixture>>, owner: CallerVerificationSession) {
  const sent = new Promise<void>(resolve => { f.onDelivery(resolve); });
  owner.begin(); await sent;
  assert.equal((await owner.submitCode(f.mail.at(-1)!.code)).verified, true);
  return owner;
}

test("actual outgoing admission verifies only through native registered email and independent permission", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  const context = value(await f.capture()), owner = value(f.make(context)); t.after(() => owner.dispose());
  assert.equal(f.receipt.admission.direction, "outbound");
  assert.equal("dialedNumber" in f.receipt.admission, false);
  assert.equal(await owner.verified(), undefined);
  const checked = await verify(f, owner); t.after(() => checked.dispose());
  assert.equal(f.mail.length, 1);
  assert.equal(f.mail[0]!.email, "registered-session@example.test");
  const subject = await checked.verifiedSubject("appointments.book");
  assert.equal(subject?.patientRef, f.original.attempt.patientId);
  assert.equal(await checked.verifiedSubject("appointments.cancel"), undefined);
  assert.equal(f.native.calls.filter(call => call.method === "POST").length, 1); // fixture setup only
  f.setPermitted(false);
  assert.equal(await checked.verified(), undefined);
});

test("outgoing admission cannot be disguised as an incoming event", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  const incoming = { ...f.inbound, key: f.key, dialedNumber: undefined };
  assert.equal(CallerVerificationSession.create({ ...f.sessionConfig, receipt: f.receipt, sessionId: f.sessionId,
    inbound: incoming as unknown as typeof f.inbound }).ok, false);
  const context = value(await f.capture()), config = f.makeConfig(context);
  assert.equal(CallerVerificationSession.createOutbound({ ...config, inbound: f.inbound } as typeof config).ok, false);
});

for (const kind of ["multiple", "different", "none"] as const) test(`original patient context cannot bypass ${kind} candidate lookup`, async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  f.setCandidates(kind === "multiple" ? { kind: "multiple", candidateIds: [f.original.attempt.patientId, "99"] } :
    kind === "different" ? { kind: "one", candidateIds: ["99"] } : { kind: "none", candidateIds: [] });
  const context = value(await f.capture());
  const lookup = context.constrainLookup(f.sessionConfig.lookup, "appointments.book");
  assert.deepEqual(await lookup.candidates(f.scope, f.native.request.recipient.number), { ok: true, value: { kind: "none", candidateIds: [] } });
  const owner = value(f.make(context)); t.after(() => owner.dispose());
  owner.begin(); assert.equal((await owner.submitCode("000000")).verified, false);
  assert.equal(f.mail.length, 0);
});

for (const kind of ["account", "direction", "scope", "provider", "clinicNumber"] as const) test(`verification refuses wrong ${kind} binding`, async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  const context = value(await f.capture()), config = f.makeConfig(context);
  if (kind === "account") {
    const contact = new ClinikoVerificationContactReader({ scope: f.scope, apiKey: "different-au5", contactEmail: "clinic@example.invalid", countryCallingCode: "61" }, f.fetchPort);
    assert.equal(CallerVerificationSession.createOutbound({ ...config, contact }).ok, false);
  } else {
    const receipt = structuredClone(config.receipt);
    if (kind === "direction") Object.assign(receipt, { admission: f.sessionConfig.receipt.admission });
    if (kind === "scope") Object.assign(receipt, { scope: { ...receipt.scope, locationId: "wrong" } });
    if (kind === "provider") Object.assign(receipt, { admission: { ...receipt.admission, key: { ...f.key, providerCallRef: "wrong" } } });
    if (kind === "clinicNumber") Object.assign(receipt, { admission: { ...receipt.admission, clinicNumber: "+6125550999" } });
    assert.equal(CallerVerificationSession.createOutbound({ ...config, receipt }).ok, false);
  }
});

test("strong decoded clinical grant and earlier native read grants remain necessary", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  const context = value(await f.capture());
  assert.ok(f.queries.some(q => q.record));
  assert.ok(f.native.queries.some(q => q.request));
  f.state.decodedCurrent = false;
  assert.equal(context.current("appointments.book"), false);
  assert.equal(f.make(context).ok, false);
  f.state.decodedCurrent = true; f.native.retire();
  assert.equal(context.current("appointments.book"), false);
});

test("changed native request across decoded approval cannot become original clinical context", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  f.state.beforeApproval = q => { if (q.record) f.native.rows.get("30")!.updated_at = "2026-11-01T10:00:01.000Z"; };
  assert.equal((await f.capture()).ok, false);
});

test("signed original request digest does not accept a changed patient or purpose", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  f.contextConfig.original.attempt = { ...f.original.attempt, requestDigest: "0".repeat(64) };
  assert.equal((await f.capture()).ok, false);
});

test("context expiry, owner cancellation and backwards clock deny independent verification", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  const context = value(await f.capture());
  f.native.setNow("2026-11-01T10:05:00.000Z");
  assert.equal(context.current("appointments.book"), false);
  f.native.setNow("2026-11-01T09:59:59.000Z");
  assert.equal(context.current("appointments.book"), false);
  f.native.setNow(outboundNow); f.lifetime.abort();
  assert.equal(context.current("appointments.book"), false);
});

test("only an actual captured context can supply the outgoing verifier", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  const context = value(await f.capture()), config = f.makeConfig(context);
  assert.equal(CallerVerificationSession.createOutbound({ ...config, outbound: Object.create(ClinikoOutboundClinicalContext.prototype) }).ok, false);
  context.dispose(); assert.equal(f.make(context).ok, false);
});

for (const kind of ["email", "phone", "nativePatient", "clinicalGrant", "nativeGrant"] as const)
test(`outbound registered proof is retired after ${kind} changes`, async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  const context = value(await f.capture()), initial = value(f.make(context));
  const owner = await verify(f, initial); t.after(() => owner.dispose());
  if (kind === "email") f.setEmail("changed@example.test");
  if (kind === "phone") f.setPhone("+61400999888");
  if (kind === "nativePatient") f.setNativePatientId("99");
  if (kind === "clinicalGrant") f.state.decodedCurrent = false;
  if (kind === "nativeGrant") f.native.retire();
  assert.equal(await owner.verifiedSubject("appointments.book"), undefined);
  assert.equal(await owner.verified(), undefined);
});

test("revoked clinical grant after asynchronous candidate lookup cannot send a code", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  const context = value(await f.capture()), base = f.makeConfig(context);
  const owner = value(CallerVerificationSession.createOutbound({ ...base, lookup: { candidates: async () => {
    await Promise.resolve(); f.state.decodedCurrent = false;
    return { ok: true, value: { kind: "one", candidateIds: [f.original.attempt.patientId] } };
  } } }));
  t.after(() => owner.dispose()); owner.begin();
  assert.equal((await owner.submitCode("000000")).verified, false);
  assert.equal(f.mail.length, 0);
});

test("stalled original clinical approval respects the whole capture deadline", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  f.state.beforeApproval = async () => new Promise<void>(() => {});
  const began = performance.now();
  assert.equal((await ClinikoOutboundClinicalContext.capture({ ...f.contextConfig, requests: { ...f.contextConfig.requests, deadlineMs: 20 } })).ok, false);
  assert.ok(performance.now() - began < 1000);
});

test("renewal retires the old outgoing proof and verifies the same original patient again", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  const context = value(await f.capture()), owner = value(f.make(context)); t.after(() => owner.dispose());
  await verify(f, owner);
  const first = (await owner.verified())!; assert.ok(first);
  const successor = value(await owner.renewOnce(first.verificationRef, f.lifetime.signal)); t.after(() => successor.dispose());
  assert.equal(await owner.verified(), undefined);
  assert.equal(await successor.verified(), undefined);
  await verify(f, successor);
  assert.equal(f.mail.length, 2);
  const second = (await successor.verified())!; assert.ok(second);
  assert.notEqual(first.verificationRef, second.verificationRef);
  assert.equal((await successor.verifiedSubject("appointments.book"))?.patientRef, f.original.attempt.patientId);
});

test("the outgoing verifier cannot use a fresh uncoordinated native request budget", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  const context = value(await f.capture()), config = f.makeConfig(context);
  const contact = new ClinikoVerificationContactReader({ scope: f.scope, apiKey: f.native.config.apiKey,
    contactEmail: "clinic@example.invalid", countryCallingCode: "61", rateBudget: { claim: async () => null, observe429: async () => ({ kind: "rateLimited" }) } }, f.fetchPort);
  assert.equal(CallerVerificationSession.createOutbound({ ...config, contact }).ok, false);
});

test("native account configuration is captured before the first asynchronous approval", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  f.state.beforeApproval = async q => {
    if (!q.record) { await Promise.resolve(); Object.assign(f.contextConfig.requests, { apiKey: "changed-au5", businessId: "99" }); }
  };
  const context = value(await f.capture());
  assert.equal(context.verificationBinding().businessId, "11");
  assert.equal(context.verificationBinding().credentialFingerprint, f.original.attempt.credentialFingerprint);
});

test("a replacement contact read cannot supply original-patient registered-channel authority", async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  const context = value(await f.capture()), config = f.makeConfig(context);
  config.contact.read = async () => ({ ok: true, value: "replacement@example.test" });
  assert.equal(CallerVerificationSession.createOutbound(config).ok, false);
});


for (const cause of ["expired", "backwards", "invalid"] as const)
test(`observed ${cause} time permanently retires original clinical context even after clock recovery`, async t => {
  const f = await outboundClinicalVerificationFixture(); t.after(f.close);
  const context = value(await f.capture());
  f.native.setNow("2026-11-01T10:00:01.000Z");
  assert.equal(context.current("appointments.book"), true);
  f.native.setNow(cause === "expired" ? "2026-11-01T10:05:00.000Z" : cause === "backwards" ? outboundNow : "invalid");
  assert.equal(context.current("appointments.book"), false);
  f.native.setNow("2026-11-01T10:00:02.000Z");
  assert.equal(context.current("appointments.book"), false);
  assert.equal(f.make(context).ok, false);
});
