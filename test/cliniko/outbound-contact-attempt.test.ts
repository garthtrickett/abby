import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { encodeOutboundLaunchAttempt, decodeOutboundLaunchAttempt, outboundLaunchAttemptDigest, outboundAttemptMatchesRequest } from "../../src/cliniko/outbound-launch-attempt.ts";
import type { OutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { outboundLaunchValue } from "../support/outbound-launch.ts";
import { value } from "../support/outbound-records.ts";

// Captured from unchanged bc4d84b module, not calculated by the codec under test.
const legacy = [
  {
    "record": {
      "actionRef": "00000000-0000-4000-8000-000000000001",
      "requestRecallRef": "cliniko:recall:30",
      "requestActionRef": "00000000-0000-4000-8000-000000000002",
      "requestDigest": "1111111111111111111111111111111111111111111111111111111111111111",
      "campaignRef": "00000000-0000-4000-8000-000000000003",
      "approvalRef": "00000000-0000-4000-8000-000000000004",
      "effectRef": "00000000-0000-4000-8000-000000000005",
      "scope": {
        "tenantId": "t",
        "clinicId": "c",
        "locationId": "l"
      },
      "businessId": "1",
      "credentialFingerprint": "2222222222222222222222222222222222222222222222222222222222222222",
      "patientId": "7",
      "provider": {
        "ref": "voice",
        "bindingDigest": "3333333333333333333333333333333333333333333333333333333333333333"
      },
      "attemptedAt": "2026-11-01T10:00:00.000Z",
      "dispatchNotAfter": "2026-11-01T10:00:10.000Z"
    },
    "notes": "Abby request 00000000-0000-4000-8000-000000000001\nAbby possible outbound launch v1\n[\"cliniko:recall:30\",\"00000000-0000-4000-8000-000000000002\",\"1111111111111111111111111111111111111111111111111111111111111111\",\"00000000-0000-4000-8000-000000000003\",\"00000000-0000-4000-8000-000000000004\",\"00000000-0000-4000-8000-000000000005\",[\"t\",\"c\",\"l\"],\"1\",\"2222222222222222222222222222222222222222222222222222222222222222\",\"7\",[\"voice\",\"3333333333333333333333333333333333333333333333333333333333333333\"],\"2026-11-01T10:00:00.000Z\",\"2026-11-01T10:00:10.000Z\"]\nPossible attempt only. No launch, delivery, terminal or clinical result proved. Never replay this effect.",
    "digest": "1f8c1139133bcfbfe7b133df2b101c053893aacbcd7b15d6b7aa63eda13fcc2c"
  },
  {
    "record": {
      "actionRef": "00000000-0000-4000-8000-000000000001",
      "requestRecallRef": "cliniko:recall:30",
      "requestActionRef": "00000000-0000-4000-8000-000000000002",
      "requestDigest": "1111111111111111111111111111111111111111111111111111111111111111",
      "campaignRef": "00000000-0000-4000-8000-000000000003",
      "approvalRef": "00000000-0000-4000-8000-000000000004",
      "effectRef": "00000000-0000-4000-8000-000000000005",
      "scope": {
        "tenantId": "t",
        "clinicId": "c",
        "locationId": "l"
      },
      "businessId": "1",
      "credentialFingerprint": "2222222222222222222222222222222222222222222222222222222222222222",
      "patientId": "7",
      "provider": {
        "ref": "voice",
        "bindingDigest": "3333333333333333333333333333333333333333333333333333333333333333"
      },
      "attemptedAt": "2026-11-01T10:00:00.000Z",
      "dispatchNotAfter": "2026-11-01T10:00:10.000Z",
      "capacityAllocationRef": "00000000-0000-4000-8000-000000000006"
    },
    "notes": "Abby request 00000000-0000-4000-8000-000000000001\nAbby possible outbound launch v2\n[\"cliniko:recall:30\",\"00000000-0000-4000-8000-000000000002\",\"1111111111111111111111111111111111111111111111111111111111111111\",\"00000000-0000-4000-8000-000000000003\",\"00000000-0000-4000-8000-000000000004\",\"00000000-0000-4000-8000-000000000005\",[\"t\",\"c\",\"l\"],\"1\",\"2222222222222222222222222222222222222222222222222222222222222222\",\"7\",[\"voice\",\"3333333333333333333333333333333333333333333333333333333333333333\"],\"2026-11-01T10:00:00.000Z\",\"2026-11-01T10:00:10.000Z\",\"00000000-0000-4000-8000-000000000006\"]\nPossible attempt only. No launch, delivery, terminal or clinical result proved. Never replay this effect.",
    "digest": "b49285f3998d4379ef7241898cec177550cf0f9bbb28f3dfa7cb25e77d838d7f"
  },
  {
    "record": {
      "actionRef": "00000000-0000-4000-8000-000000000001",
      "requestRecallRef": "cliniko:recall:30",
      "requestActionRef": "00000000-0000-4000-8000-000000000002",
      "requestDigest": "1111111111111111111111111111111111111111111111111111111111111111",
      "campaignRef": "00000000-0000-4000-8000-000000000003",
      "approvalRef": "00000000-0000-4000-8000-000000000004",
      "effectRef": "00000000-0000-4000-8000-000000000005",
      "scope": {
        "tenantId": "t",
        "clinicId": "c",
        "locationId": "l"
      },
      "businessId": "1",
      "credentialFingerprint": "2222222222222222222222222222222222222222222222222222222222222222",
      "patientId": "7",
      "provider": {
        "ref": "voice",
        "bindingDigest": "3333333333333333333333333333333333333333333333333333333333333333"
      },
      "attemptedAt": "2026-11-01T10:00:00.000Z",
      "dispatchNotAfter": "2026-11-01T10:00:10.000Z",
      "capacityAllocationRef": "00000000-0000-4000-8000-000000000006",
      "dncReferences": {
        "actionRef": "00000000-0000-4000-8000-000000000007",
        "approvalRef": "00000000-0000-4000-8000-000000000008"
      }
    },
    "notes": "Abby request 00000000-0000-4000-8000-000000000001\nAbby possible outbound launch v3\n[\"cliniko:recall:30\",\"AAAAAAAAQACAAAAAAAAAAg\",\"1111111111111111111111111111111111111111111111111111111111111111\",\"AAAAAAAAQACAAAAAAAAAAw\",\"AAAAAAAAQACAAAAAAAAABA\",\"AAAAAAAAQACAAAAAAAAABQ\",[\"t\",\"c\",\"l\"],\"1\",\"2222222222222222222222222222222222222222222222222222222222222222\",\"7\",[\"voice\",\"3333333333333333333333333333333333333333333333333333333333333333\"],\"2026-11-01T10:00:00.000Z\",\"2026-11-01T10:00:10.000Z\",\"AAAAAAAAQACAAAAAAAAABg\",[\"AAAAAAAAQACAAAAAAAAABw\",\"AAAAAAAAQACAAAAAAAAACA\"]]\nPossible attempt only. No launch, delivery, terminal or clinical result proved. Never replay this effect.",
    "digest": "bdca796eea264f45fa4c21f9c0b1eb204aa06f6eac33fd64597bb22ea93d0d51"
  }
] as const;
for (const [index, fixture] of legacy.entries()) test(`legacy v${index + 1} exact persisted bytes and digest remain readable`, () => {
  assert.equal(value(encodeOutboundLaunchAttempt(fixture.record)), fixture.notes);
  assert.equal(outboundLaunchAttemptDigest(fixture.record), fixture.digest);
  assert.deepEqual(value(decodeOutboundLaunchAttempt(fixture.notes)), fixture.record);
});
function fixture() {
  const { request, attempt: original } = outboundLaunchValue();
  const attempt = { ...original, capacityAllocationRef: randomUUID(), dncReferences: { actionRef: randomUUID(), approvalRef: randomUUID() },
    contactReferences: { guardRef: randomUUID(), allocationRef: randomUUID(), outcomeActionRef: randomUUID() } };
  return { request, attempt };
}
test("v4 retains distinct pending-contact identities under exact native context without inventing completion", () => {
  const { request, attempt } = fixture(), notes = value(encodeOutboundLaunchAttempt(attempt)), read = value(decodeOutboundLaunchAttempt(notes));
  assert.deepEqual(read, attempt); assert.match(notes, /Abby possible outbound launch v4/);
  assert.ok(Object.isFrozen(read) && Object.isFrozen(read.scope) && Object.isFrozen(read.provider) && Object.isFrozen(read.dncReferences) && Object.isFrozen(read.contactReferences));
  assert.equal(outboundAttemptMatchesRequest(read, request, attempt.requestRecallRef), true);
  assert.equal(notes.includes(request.recipient.number), false);
  for (const field of ["terminal", "optedOut", "contactComplete", "permission", "providerCallId"]) assert.equal(Object.hasOwn(read, field), false);
  for (const key of ["guardRef", "allocationRef", "outcomeActionRef"] as const)
    assert.notEqual(outboundLaunchAttemptDigest({ ...attempt, contactReferences: { ...attempt.contactReferences, [key]: randomUUID() } }), outboundLaunchAttemptDigest(attempt));
});
test("a stable clinic guard may be shared across distinct calls without aliasing their per-attempt identities", () => {
  const a = fixture().attempt, b = fixture().attempt;
  b.contactReferences.guardRef = a.contactReferences.guardRef;
  assert.equal(encodeOutboundLaunchAttempt(a).ok, true); assert.equal(encodeOutboundLaunchAttempt(b).ok, true);
  assert.notEqual(a.contactReferences.allocationRef, b.contactReferences.allocationRef);
});
for (const key of ["guardRef", "allocationRef", "outcomeActionRef"] as const)
  test(`contact ${key} cannot alias any existing action or another contact identity`, () => {
    const { attempt } = fixture();
    const others = [attempt.actionRef, attempt.requestActionRef, attempt.campaignRef, attempt.approvalRef, attempt.effectRef, attempt.capacityAllocationRef,
      ...Object.values(attempt.dncReferences), ...Object.entries(attempt.contactReferences).filter(([name]) => name !== key).map(([,ref]) => ref)];
    for (const alias of others) assert.equal(encodeOutboundLaunchAttempt({ ...attempt, contactReferences: { ...attempt.contactReferences, [key]: alias } }).ok, false);
  });
test("contact context requires both older recovery contexts and rejects partial or private extra fields", () => {
  const { attempt } = fixture();
  const { capacityAllocationRef: _cap, ...noCap } = attempt, { dncReferences: _dnc, ...noDnc } = attempt;
  assert.equal(encodeOutboundLaunchAttempt(noCap).ok, false); assert.equal(encodeOutboundLaunchAttempt(noDnc).ok, false);
  for (const contactReferences of [undefined, null, {}, { guardRef: attempt.contactReferences.guardRef },
    { ...attempt.contactReferences, patientId: attempt.patientId }, { ...attempt.contactReferences, guardRef: "phone-derived-value" }])
    assert.equal(encodeOutboundLaunchAttempt({ ...attempt, contactReferences } as OutboundLaunchAttempt).ok, false);
});
test("v4 fits every supported near-full v3 envelope without increasing native note bounds", () => {
  const { attempt } = fixture(); let largest: { record: typeof attempt; notes: string } | undefined;
  for (let n = 1; n <= 96; n++) {
    const record = { ...attempt, scope: { tenantId: "t".repeat(n), clinicId: "c".repeat(n), locationId: "l".repeat(n) }, provider: { ...attempt.provider, ref: "p".repeat(n) } };
    const { contactReferences: _contact, ...v3 } = record, old = encodeOutboundLaunchAttempt(v3);
    if (!old.ok) continue;
    const current = value(encodeOutboundLaunchAttempt(record));
    assert.ok(current.length <= old.value.length && current.length <= 1050);
    assert.deepEqual(value(decodeOutboundLaunchAttempt(current)), record);
    if (!largest || largest.notes.length < old.value.length) largest = { record, notes: old.value };
  }
  assert.ok(largest && largest.notes.length >= 1040);
});
test("v4 rejects noncanonical packed digests, native IDs, tuples, version aliases and truncation", () => {
  const { attempt } = fixture(), notes = value(encodeOutboundLaunchAttempt(attempt)), lines = notes.split("\n"), payload = JSON.parse(lines[2]!);
  const changed = (mutate: (a: any[]) => void) => { const a = structuredClone(payload); mutate(a); return [lines[0], lines[1], JSON.stringify(a), lines[3]].join("\n"); };
  for (const bad of [attempt.requestDigest, payload[2] + "=", payload[2].slice(1), "!".repeat(43), payload[2].slice(0, -1) + "F"])
    for (const slot of [2, 8, 10]) assert.equal(decodeOutboundLaunchAttempt(changed(a => { if (slot === 10) a[10][1] = bad; else a[slot] = bad; })).ok, false);
  for (const bad of [30, "030", "cliniko:recall:30", "0", "-30"]) assert.equal(decodeOutboundLaunchAttempt(changed(a => { a[0] = bad; })).ok, false);
  assert.equal(decodeOutboundLaunchAttempt(changed(a => a.push(true))).ok, false);
  assert.equal(decodeOutboundLaunchAttempt(changed(a => a[15].push("extra"))).ok, false);
  for (const version of ["v1", "v2", "v3", "v5"]) assert.equal(decodeOutboundLaunchAttempt(notes.replace("launch v4", `launch ${version}`)).ok, false);
  assert.equal(decodeOutboundLaunchAttempt(notes.slice(0, -1)).ok, false);
});
