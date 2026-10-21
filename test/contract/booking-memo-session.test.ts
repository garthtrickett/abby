import assert from "node:assert/strict";
import test from "node:test";
import { bookingMemoSessionFixture } from "../support/booking-memo-session.ts";
import { decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";

for (const mode of ["accepted", "lostStored", "lostUnstored", "nonexact"] as const)
test(`approved booking session creates one independent memo after its exact booking acknowledgement: ${mode}`, async t => {
  const f = await bookingMemoSessionFixture({ mode }); t.after(f.close); await f.prepare();
  assert.equal(f.memoPosts.length, 0); await f.drain();
  assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed"); assert.equal(f.posts, 1); assert.equal(f.memoPosts.length, 1);
  assert.equal(f.outcomes[0]!.kind, mode === "accepted" ? "accepted" : "uncertain");
  const memo = decodeAdministrativeMemo(f.memoPosts[0]!.content); assert.ok(memo.ok);
  assert.equal(memo.value.outcome.appointmentRef, "cliniko:appointment:91"); assert.equal(memo.value.direction, "inbound");
  await f.drain(); assert.equal(f.posts, 1); assert.equal(f.memoPosts.length, 1);
});

test("independent memo producer revocation inside native booking preserves the approved session's confirmed result", async t => {
  const f = await bookingMemoSessionFixture(); t.after(f.close); await f.prepare();
  f.setOnBooking(async () => { f.gates.producer = false; }); await f.drain();
  assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed"); assert.equal(f.posts, 1);
  assert.equal(f.memoPosts.length, 0); assert.equal(f.outcomes[0]!.kind, "unavailable");
});
