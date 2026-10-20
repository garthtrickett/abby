import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { encodeOutboundLaunchAttempt,decodeOutboundLaunchAttempt,outboundAttemptMatchesRequest,outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { outboundLaunchValue } from "../support/outbound-launch.ts";
import { value } from "../support/outbound-records.ts";
test("canonical possible launch binds exact original request but proves no launched call",()=>{
  const {request,attempt}=outboundLaunchValue(),notes=value(encodeOutboundLaunchAttempt(attempt)),decoded=value(decodeOutboundLaunchAttempt(notes));
  assert.deepEqual(decoded,attempt);assert.ok(Object.isFrozen(decoded)&&Object.isFrozen(decoded.scope)&&Object.isFrozen(decoded.provider));assert.equal(outboundAttemptMatchesRequest(decoded,request,attempt.requestRecallRef),true);
  assert.match(outboundLaunchAttemptDigest(attempt)!,/^[a-f0-9]{64}$/);assert.equal(notes.includes(request.recipient.number),false);assert.equal(Object.hasOwn(decoded,"providerCallId"),false);
});
for(const patch of [{actionRef:"bad"},{requestRecallRef:"cliniko:appointment:30"},{requestDigest:"bad"},{dispatchNotAfter:"2026-11-01T10:00:00.000Z"},
 {attemptedAt:"2026-02-30T00:00:00.000Z"},{provider:{ref:"x",bindingDigest:"bad"}},{launched:true},{terminal:true},{recipient:{number:"+12025550123"}}])
 test(`possible-attempt ${Object.keys(patch)[0]} cannot invent authority or an invalid binding`,()=>{
  const {attempt}=outboundLaunchValue();assert.equal(encodeOutboundLaunchAttempt({...attempt,...patch} as typeof attempt).ok,false);
 });
for(const field of ["requestActionRef","campaignRef","approvalRef","effectRef"] as const)test(`possible-attempt record action cannot alias ${field}`,()=>{
  const {attempt}=outboundLaunchValue();assert.equal(encodeOutboundLaunchAttempt({...attempt,actionRef:attempt[field]}).ok,false);
});
for(const field of ["actionRef","recipient","purpose","policy","target"] as const)test(`changed original request ${field} does not reuse possible evidence`,()=>{
  const {attempt,request}=outboundLaunchValue();const changed={...request,...(field==="actionRef"?{actionRef:randomUUID()}:field==="recipient"?{recipient:{kind:"voice" as const,number:"+12025550124"}}:field==="purpose"?{purpose:"sickDay" as const,appointment:{ref:"cliniko:appointment:91",digest:"a".repeat(64)}}:field==="policy"?{policy:{...request.policy,digest:"f".repeat(64)}}:{appointment:{ref:"cliniko:appointment:92",digest:"c".repeat(64)}})};
  assert.equal(outboundAttemptMatchesRequest(attempt,changed,attempt.requestRecallRef),false);
});
test("parser rejects noncanonical notes and older or foreign record families",()=>{
  const {attempt}=outboundLaunchValue(),notes=value(encodeOutboundLaunchAttempt(attempt));
  for(const changed of [notes+"\n",notes.replace("launch v1","launch v2"),notes.replace("Possible attempt only.","Launched successfully."),notes.replace('["cliniko:recall:30"','[ "cliniko:recall:30"')])assert.equal(decodeOutboundLaunchAttempt(changed).ok,false);
});


test("v2 possible evidence binds its exact independent capacity allocation while v1 stays readable", () => {
  const { request, attempt } = outboundLaunchValue(), capacityAllocationRef = randomUUID();
  const notes = value(encodeOutboundLaunchAttempt({ ...attempt, capacityAllocationRef }));
  assert.ok(notes.includes("Abby possible outbound launch v2"));
  const decoded = value(decodeOutboundLaunchAttempt(notes));
  assert.equal(decoded.capacityAllocationRef, capacityAllocationRef);
  assert.equal(outboundAttemptMatchesRequest(decoded, request, attempt.requestRecallRef), true);
  assert.notEqual(outboundLaunchAttemptDigest(decoded), outboundLaunchAttemptDigest(attempt));
  assert.equal(Object.hasOwn(value(decodeOutboundLaunchAttempt(value(encodeOutboundLaunchAttempt(attempt)))), "capacityAllocationRef"), false);
  assert.equal(decodeOutboundLaunchAttempt(notes.replace("launch v2", "launch v1")).ok, false);
});
for (const field of ["actionRef", "requestActionRef", "campaignRef", "approvalRef", "effectRef"] as const)
  test(`capacity allocation cannot alias possible-attempt ${field}`, () => {
    const { attempt } = outboundLaunchValue();
    assert.equal(encodeOutboundLaunchAttempt({ ...attempt, capacityAllocationRef: attempt[field] }).ok, false);
  });
test("malformed or explicit undefined capacity allocation is never encoded as legacy evidence", () => {
  const { attempt } = outboundLaunchValue();
  for (const capacityAllocationRef of ["private-patient-ref", "", undefined])
    assert.equal(encodeOutboundLaunchAttempt({ ...attempt, capacityAllocationRef } as typeof attempt).ok, false);
});

function dncValue() {
  const { request, attempt } = outboundLaunchValue();
  return { request, attempt: { ...attempt, capacityAllocationRef: randomUUID(), dncReferences: { actionRef: randomUUID(), approvalRef: randomUUID() } } };
}
test("v3 possible context retains stable independent future DNC identities without granting a stop or write", () => {
  const { request, attempt } = dncValue(), notes = value(encodeOutboundLaunchAttempt(attempt)), decoded = value(decodeOutboundLaunchAttempt(notes));
  assert.ok(notes.includes("Abby possible outbound launch v3")); assert.ok(notes.length <= 1050);
  assert.deepEqual(decoded, attempt); assert.ok(Object.isFrozen(decoded.dncReferences));
  const { dncReferences: _refs, ...v2 } = attempt;
  assert.ok(notes.length < value(encodeOutboundLaunchAttempt(v2)).length, "extra recovery IDs must not shrink the supported native note envelope");
  assert.equal(outboundAttemptMatchesRequest(decoded, request, attempt.requestRecallRef), true);
  assert.equal(Object.hasOwn(decoded, "optedOut"), false); assert.equal(notes.includes(request.recipient.number), false);
  for (const version of ["v1", "v2"]) assert.equal(decodeOutboundLaunchAttempt(notes.replace("launch v3", `launch ${version}`)).ok, false);
});
for (const ref of ["actionRef", "approvalRef"] as const)
  for (const alias of ["actionRef", "requestActionRef", "campaignRef", "approvalRef", "effectRef", "capacityAllocationRef"] as const)
    test(`future DNC ${ref} cannot alias original ${alias}`, () => {
      const { attempt } = dncValue();
      assert.equal(encodeOutboundLaunchAttempt({ ...attempt, dncReferences: { ...attempt.dncReferences, [ref]: attempt[alias] } }).ok, false);
    });
test("future DNC references cannot alias each other or encode a partial private context", () => {
  const { attempt } = dncValue();
  for (const dncReferences of [undefined, null, { actionRef: attempt.dncReferences.actionRef },
    { ...attempt.dncReferences, approvalRef: attempt.dncReferences.actionRef }, { ...attempt.dncReferences, actionRef: "private-patient-ref" },
    { ...attempt.dncReferences, number: "+61400000999" }])
    assert.equal(encodeOutboundLaunchAttempt({ ...attempt, dncReferences } as typeof attempt).ok, false);
  const { capacityAllocationRef: _capacity, ...withoutAllocation } = attempt;
  assert.equal(encodeOutboundLaunchAttempt(withoutAllocation).ok, false);
});
test("legacy possible-attempt records retain their original shape and acquire no DNC identities", () => {
  const { attempt } = outboundLaunchValue();
  for (const [record, version, length] of [[attempt, "v1", 13], [{ ...attempt, capacityAllocationRef: randomUUID() }, "v2", 14]] as const) {
    const notes = value(encodeOutboundLaunchAttempt(record)), decoded = value(decodeOutboundLaunchAttempt(notes));
    assert.ok(notes.includes(`Abby possible outbound launch ${version}`)); assert.equal(JSON.parse(notes.split("\n")[2]!).length, length);
    assert.equal(Object.hasOwn(decoded, "dncReferences"), false); assert.equal(value(encodeOutboundLaunchAttempt(decoded)), notes);
  }
});
test("changing either future DNC identity changes the exact native context digest", () => {
  const { attempt } = dncValue();
  for (const ref of ["actionRef", "approvalRef"] as const)
    assert.notEqual(outboundLaunchAttemptDigest({ ...attempt, dncReferences: { ...attempt.dncReferences, [ref]: randomUUID() } }), outboundLaunchAttemptDigest(attempt));
});
test("v3 preserves the original native note limit for a near-boundary v2 context", () => {
  const { attempt } = dncValue(); let largest: { record: typeof attempt; notes: string } | undefined;
  for (let n = 1; n <= 96; n++) {
    const record = { ...attempt, scope: { tenantId: "t".repeat(n), clinicId: "c".repeat(n), locationId: "l".repeat(n) },
      provider: { ...attempt.provider, ref: "p".repeat(n) } };
    const { dncReferences: _refs, ...v2 } = record, legacy = encodeOutboundLaunchAttempt(v2);
    if (legacy.ok && (!largest || legacy.value.length > largest.notes.length)) largest = { record, notes: legacy.value };
  }
  assert.ok(largest && largest.notes.length >= 1040, "exercise an actually near-full legacy native note");
  const lines = largest.notes.split("\n"), naive = JSON.parse(lines[2]!);
  naive.push([largest.record.dncReferences.actionRef, largest.record.dncReferences.approvalRef]);
  assert.ok([lines[0], "Abby possible outbound launch v3", JSON.stringify(naive), lines[3]].join("\n").length > 1050,
    "simply appending the two full UUIDs would break this supported legacy context");
  const notes = value(encodeOutboundLaunchAttempt(largest.record));
  assert.ok(notes.length < largest.notes.length); assert.deepEqual(value(decodeOutboundLaunchAttempt(notes)), largest.record);
});
test("v3 rejects noncanonical compact identities instead of admitting a second record encoding", () => {
  const { attempt } = dncValue(), notes = value(encodeOutboundLaunchAttempt(attempt)), lines = notes.split("\n"), payload = JSON.parse(lines[2]!);
  for (const bad of [attempt.requestActionRef, payload[1] + "=", "!".repeat(22), "A".repeat(22)]) {
    const changed = [...payload]; changed[1] = bad;
    assert.equal(decodeOutboundLaunchAttempt([lines[0], lines[1], JSON.stringify(changed), lines[3]].join("\n")).ok, false);
  }
});
