import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { outboundContactSettlementFixture } from "../support/outbound-contact-settlement.ts";
import { encodeOutboundLaunchAttempt, outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { value } from "../support/outbound-records.ts";

test("an edited native context cannot borrow another completed call to release the original unresolved hold",async t=>{
  const f=await outboundContactSettlementFixture();t.after(f.close);
  const other={effectRef:randomUUID(),capacityAllocationRef:randomUUID()};
  const originalOther={...f.attempt,...other,actionRef:randomUUID(),contactReferences:{...f.attempt.contactReferences!,allocationRef:randomUUID(),outcomeActionRef:randomUUID()}};
  const changed={...f.attempt,...other};
  f.row.notes=value(encodeOutboundLaunchAttempt(changed));f.row.updated_at=f.state.now;
  // The backend legitimately knows a different completed pair. The original
  // dialled call's independent contact allocation remains unresolved.
  f.settlementState.reportPatch={...other,attemptDigest:outboundLaunchAttemptDigest(originalOther)};f.settlementState.terminalPatch={...other};
  assert.notEqual(other.effectRef,f.attempt.effectRef);assert.equal(f.contactHeld.size,1);
  await f.settle();
  assert.equal(f.contactHeld.size,1);assert.equal(f.outcomePosts.length,0);assert.equal(f.dncPosts.length,0);assert.equal(f.calls.length,1);
});

for(const field of ["allocationRef","outcomeActionRef"]as const)test(`editable native ${field} cannot replace the authenticated original send context`,async t=>{
  const f=await outboundContactSettlementFixture();t.after(f.close);
  const changed={...f.attempt,contactReferences:{...f.attempt.contactReferences!,[field]:randomUUID()}};
  f.row.notes=value(encodeOutboundLaunchAttempt(changed));f.row.updated_at=f.state.now;
  assert.notEqual(outboundLaunchAttemptDigest(changed),outboundLaunchAttemptDigest(f.attempt));
  assert.equal((await f.settle()).ok,false);assert.equal(f.contactHeld.size,1);assert.equal(f.outcomePosts.length,0);assert.equal(f.dncPosts.length,0);
});
for(const attemptDigest of [undefined,"","f".repeat(64)])test(`missing or foreign original send attestation cannot settle: ${String(attemptDigest).slice(0,8)}`,async t=>{
  const f=await outboundContactSettlementFixture();t.after(f.close);f.settlementState.reportPatch={attemptDigest};
  assert.equal((await f.settle()).ok,false);assert.equal(f.contactHeld.size,1);assert.equal(f.outcomePosts.length,0);
});
