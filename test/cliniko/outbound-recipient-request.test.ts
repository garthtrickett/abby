import assert from "node:assert/strict";
import test from "node:test";
import { encodeOutboundRecipientRequest, decodeOutboundRecipientRequest, outboundRecipientRequestDigest } from "../../src/cliniko/outbound-recipient-request.ts";
import type { OutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
import { outboundRequestValue } from "../support/outbound-recipient-request.ts";
function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T { assert.ok(r.ok); return r.value; }
const appointment = { ref: "cliniko:appointment:91", digest: "c".repeat(64) };
for (const purpose of ["followUp", "sickDay"] as const) for (const targeted of [false, true]) {
  if (purpose === "sickDay" && !targeted) continue;
  test(`canonical private ${purpose} context retains explicit target=${targeted} without granting authority`, () => {
    const r = { ...outboundRequestValue(), purpose, ...(targeted ? { appointment } : {}) }, notes = value(encodeOutboundRecipientRequest(r));
    assert.ok(notes.length <= 1050); assert.match(notes, /No contact, patient authority or launch proof/);
    const found = value(decodeOutboundRecipientRequest(notes)); assert.deepEqual(found, r);
    assert.equal(Object.hasOwn(found, "appointment"), targeted);
    for (const object of [found, found.scope, found.policy, found.recipient, found.schedule, found.schedule.weekdays, ...(found.appointment ? [found.appointment] : [])])
      assert.equal(Object.isFrozen(object), true);
    assert.match(outboundRecipientRequestDigest(found)!, /^[a-f0-9]{64}$/);
    assert.equal(outboundRecipientRequestDigest(found), outboundRecipientRequestDigest(r));
  });
}
for (const patch of [
  { purpose: "collectPayment" }, { purpose: "sickDay" }, { appointment: undefined }, { appointment: { ...appointment, ref: "cliniko:attendee:91" } },
  { appointment: { ...appointment, ref: "cliniko:appointment:0" } }, { appointment: { ...appointment, digest: "wrong" } },
  { appointment: { ...appointment, authorized: true } }, { approved: true }, { optedOut: false }, { launchAcknowledged: true },
  { patientId: "0" }, { businessId: "01" }, { credentialFingerprint: "wrong" },
  { scope: { tenantId: "", clinicId: "clinic", locationId: "location" } },
  { scope: { tenantId: "tenant", clinicId: "clinic", locationId: "location", patientId: "21" } },
  { recipient: { kind: "email", number: "+12025550123" } }, { recipient: { kind: "voice", number: "2025550123" } },
  { recipient: { kind: "voice", number: "+02025550123" } }, { recipient: { kind: "voice", number: "+12025550123", name: "private" } },
  { policy: { version: "", digest: "b".repeat(64) } }, { policy: { version: "v1", digest: "wrong" } },
  { requestedAt: "2026-11-03T00:00:00.000Z" }, { requestedAt: "2026-11-01T10:00:00Z" }, { requestedAt: "2026-02-30T00:00:00.000Z" },
]) test(`invalid or authority-bearing recipient context refuses ${JSON.stringify(patch)}`, () => {
  const r = { ...outboundRequestValue(), ...patch } as unknown as OutboundRecipientRequest;
  assert.equal(encodeOutboundRecipientRequest(r).ok, false); assert.equal(outboundRecipientRequestDigest(r), undefined);
});
for (const schedule of [{ timeZone: "Missing/Zone" }, { weekdays: [2, 1] }, { weekdays: [1, 1] }, { weekdays: [] },
  { opensAt: "24:00" }, { opensAt: "09:00", closesAt: "09:00" }, { expiresAt: "2026-11-02T00:00:00.000Z" }])
  test(`recipient context shares strict finite schedule validation ${JSON.stringify(schedule)}`, () => {
    const r = outboundRequestValue(); assert.equal(encodeOutboundRecipientRequest({ ...r, schedule: { ...r.schedule, ...schedule } }).ok, false);
  });
for (const pair of [["actionRef", "effectRef"], ["approvalRef", "effectRef"], ["campaignRef", "approvalRef"],
  ["actionRef", "approvalRef"], ["campaignRef", "actionRef"], ["campaignRef", "effectRef"]] as const)
  test(`independent recipient IDs cannot alias ${pair.join("/")}`, () => {
    const r = outboundRequestValue(); assert.equal(encodeOutboundRecipientRequest({ ...r, [pair[0]]: r[pair[1]] }).ok, false);
  });
test("all private subject contact target schedule and policy changes alter the context fingerprint", () => {
  const r = { ...outboundRequestValue(), appointment }, original = outboundRecipientRequestDigest(r);
  for (const patch of [{ patientId: "22" }, { recipient: { kind: "voice" as const, number: "+12025550124" } },
    { appointment: { ...appointment, ref: "cliniko:appointment:92" } }, { policy: { ...r.policy, version: "outbound-2" } },
    { scope: { ...r.scope, locationId: "other-location" } }, { schedule: { ...r.schedule, closesAt: "16:00" } }])
    assert.notEqual(outboundRecipientRequestDigest({ ...r, ...patch }), original);
});
test("noncanonical native spelling, wrong families, extra context and oversize notes refuse without partial decoding", () => {
  const notes = value(encodeOutboundRecipientRequest({ ...outboundRequestValue(), appointment }));
  for (const altered of [notes.replace('["', '[ "'), notes.replace('v1\n', 'v2\n'), notes+'\n', notes+'private',
    notes.replace('outbound recipient request', 'financial resend request'), "x".repeat(1051), "", null, {}])
    assert.equal(decodeOutboundRecipientRequest(altered).ok, false);
  const r = outboundRequestValue(); assert.equal(encodeOutboundRecipientRequest({ ...r, scope: { ...r.scope, tenantId: "x".repeat(1000) } }).ok, false);
});

test("a context with individually bounded fields still refuses an oversized native summary", () => {
  const r = outboundRequestValue();
  assert.equal(encodeOutboundRecipientRequest({ ...r, appointment,
    scope: { tenantId: "t".repeat(96), clinicId: "c".repeat(96), locationId: "l".repeat(96) },
    businessId: "9".repeat(19), patientId: "9".repeat(19), recipient: { kind: "voice", number: "+"+"9".repeat(15) },
    policy: { version: "v".repeat(64), digest: r.policy.digest } }).ok, false);
});
