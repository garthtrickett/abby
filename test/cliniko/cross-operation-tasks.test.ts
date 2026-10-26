import assert from "node:assert/strict";
import { test } from "node:test";
import { crossOperationTasksFixture } from "../support/cross-operation-tasks.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

for (const firstKind of ["book", "cancel", "reschedule"] as const) for (const secondKind of ["book", "cancel", "reschedule"] as const) {
  if (firstKind === "reschedule" && secondKind === "reschedule") continue;
  test(`E2E-381 ordinary ${firstKind} then ${secondKind} retain separate current authority and original receipts`, async () => {
    const f = await crossOperationTasksFixture();
    try {
      await f.start(firstKind); const first = await f.perform(firstKind); assert.equal(first.status, "committed");
      await f.start(secondKind); assert.equal(f.native.mutations.length, 1);
      assert.equal((await f.flow.publicIntentContext())?.lastAction, null);
      const second = await f.perform(secondKind); assert.equal(second.status, "committed");
      assert.equal(f.mail.length, 2); assert.equal(f.native.reviews.length, 2);
      assert.deepEqual(f.native.mutations.map(row => row.operation), [firstKind, secondKind]);
      assert.notEqual(first.key, second.key); assert.deepEqual((await f.state()).actions[first.key], first);
      assert.deepEqual(await f.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
      assert.deepEqual(await f.flow.write(first.mutation, f.flowConfig.clock!()), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
      assert.deepEqual(await f.flow.reconcile({ ...first.mutation, payloadDigest: "f".repeat(64) }), { kind: "stillUnknown", actionKey: first.key });
      assert.equal((await f.flow.choose("book")).ok, false);
      for (const secret of [verificationCanaries[0]!, verificationCanaries[1]!, ...f.mail.map(item => item.code)])
        assert.equal(JSON.stringify(await f.state()).includes(secret), false);
    } finally { await f.close(); }
  });
}

test("E2E-381 two same-minute reschedules preserve the first receipt and refuse an unsent second move at the shared request limit", async () => {
  const f = await crossOperationTasksFixture();
  try {
    await f.start("reschedule"); const first = await f.perform("reschedule"); assert.equal(first.status, "committed");
    await f.start("reschedule"); const second = await f.perform("reschedule"); assert.equal(second.status, "rejected");
    assert.equal(f.native.traffic.length, 199); assert.equal(f.budget.checkHeadroom(1)?.kind, "rateLimited");
    assert.equal(f.native.mutations.length, 1); assert.equal(f.native.reviews.length, 2);
    assert.deepEqual((await f.state()).actions[first.key], first);
    assert.deepEqual(await f.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
    assert.deepEqual(await f.flow.write(second.mutation, f.flowConfig.clock!()), { kind: "rejected", actionKey: second.key, reason: "forbidden" });
    assert.equal(f.native.mutations.length, 1); assert.equal(f.native.reviews.length, 2);
    assert.equal((await f.flow.choose("book")).ok, false);
  } finally { await f.close(); }
});

test("E2E-381 an independently verified booking can use newly available time after a settled cancellation", async () => {
  const f = await crossOperationTasksFixture();
  try {
    const startsAt = String(f.native.rows.get("201")!.starts_at);
    await f.start("cancel"); const cancellation = await f.perform("cancel"); assert.equal(cancellation.status, "committed");
    assert.notEqual(f.native.rows.get("201")!.cancelled_at, null);
    f.setStarts([startsAt]);
    await f.start("book"); assert.equal(f.native.mutations.length, 1);
    const booking = await f.perform("book"); assert.equal(booking.status, "committed");
    // The booking receipt is opaque; only the synthetic native port owns row IDs.
    assert.equal(f.native.rows.get("91")!.starts_at, startsAt);
    assert.notEqual(booking.hostRef, cancellation.hostRef);
    assert.equal(f.mail.length, 2); assert.equal(f.native.reviews.length, 2);
    assert.deepEqual(f.native.mutations.map(row => row.operation), ["cancel", "book"]);
    assert.deepEqual((await f.state()).actions[cancellation.key], cancellation);
  } finally { await f.close(); }
});

for (const firstKind of ["book", "cancel", "reschedule"] as const) for (const nextKind of ["book", "cancel", "reschedule"] as const)
  test(`E2E-381 possible ${firstKind} write blocks a following ${nextKind} without another code, review or send`, async () => {
    const f = await crossOperationTasksFixture();
    try {
      await f.start(firstKind); f.native.loseResponse(); const first = await f.perform(firstKind);
      assert.ok(["uncertain", "needsReview"].includes(first.status));
      assert.equal((await f.flow.choose(nextKind)).ok, false);
      assert.equal(f.mail.length, 1); assert.equal(f.native.reviews.length, 1); assert.equal(f.native.mutations.length, 1);
      assert.deepEqual((await f.state()).actions[first.key], first);
    } finally { await f.close(); }
  });

for (const firstKind of ["book", "cancel", "reschedule"] as const)
  test(`E2E-381 settled ${firstKind} cannot advance after the sequence approval is revoked`, async () => {
    const f = await crossOperationTasksFixture();
    try {
      await f.start(firstKind); const first = await f.perform(firstKind); assert.equal(first.status, "committed");
      await f.sequence.replace({ enabled: false });
      for (const kind of ["book", "cancel", "reschedule"] as const) assert.equal((await f.flow.choose(kind)).ok, false);
      assert.equal(f.mail.length, 1); assert.equal(f.native.reviews.length, 1); assert.equal(f.native.mutations.length, 1);
      assert.deepEqual((await f.state()).actions[first.key], first);
    } finally { await f.close(); }
  });
