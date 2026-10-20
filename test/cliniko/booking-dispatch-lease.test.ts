import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoClassAttendanceReader } from "../../src/cliniko/class-attendance-read.ts";
import { ClinikoClassAttendanceWriter } from "../../src/cliniko/class-attendance-write.ts";
import { bookingOffersFixture } from "../support/booking-offers.ts";
import { classBookingFixture } from "../support/class-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { rosterPlan, syntheticRosterProvider } from "../support/roster-booking.ts";

for (const mode of ["online", "roster", "class"] as const) for (const checkpoint of ["finalRead", "transport"] as const) for (const renewed of [false, true])
  test(`E2E-279/E2E-392 final ${mode} ${checkpoint} ${renewed ? "uses a renewal observed during preparation" : "refuses an expired session lease even with live proof and offer"}`, async t => {
    const calendar = mode === "roster" ? syntheticRosterProvider() : undefined;
    const f = mode === "class" ? await classBookingFixture() : await bookingOffersFixture({
      ...(calendar ? { availabilityPlan: rosterPlan, fetchAround: port => calendar.wrap(port) } : {}),
    });
    try {
      if ("source" in f) {
        const proof = await f.verify(), offers = resultValue(await f.list(proof));
        resultValue(await f.propose(proof, "lease-proposal", offers.choices[0]!.offerRef));
      } else { await f.verify(); await f.propose(); }
      resultValue(await f.confirm());
      const before = await f.state(), oldExpiry = before.sessionLease!.expiresAt;
      const preparedAt = new Date(Date.parse(oldExpiry) - 5_000).toISOString();
      const completedAt = new Date(Date.parse(oldExpiry) + 1).toISOString();
      f.setTime(preparedAt);
      if (renewed) resultValue(await f.runtime.renewSession(f.callId, f.sessionId, before.sessionLease!.version, preparedAt));
      let finalRead = false;
      if ("source" in f) {
        const read = f.source.resolveForSend.bind(f.source);
        t.mock.method(f.source, "resolveForSend", async (...args: Parameters<typeof read>) => {
          const result = await read(...args); assert.equal(result.ok, true);
          finalRead = true; if (checkpoint === "finalRead") f.setTime(completedAt); return result;
        });
        if (checkpoint === "transport") {
          const write = f.writer.writeOnce.bind(f.writer);
          t.mock.method(f.writer, "writeOnce", (...[q, signal, beforeSend, accepted, current]: Parameters<typeof write>) =>
            write(q, signal, async stop => {
              const permitted = await beforeSend!(stop); assert.equal(permitted, true);
              f.setTime(completedAt); return permitted;
            }, accepted, current));
        }
      } else {
        const read = ClinikoClassAttendanceReader.prototype.inspectForSend;
        t.mock.method(ClinikoClassAttendanceReader.prototype, "inspectForSend", async function(this: ClinikoClassAttendanceReader,
          ...args: Parameters<typeof read>) {
          const result = await read.apply(this, args); assert.equal(result.ok, true);
          finalRead = true; if (checkpoint === "finalRead") f.setTime(completedAt); return result;
        });
        if (checkpoint === "transport") {
          const write = ClinikoClassAttendanceWriter.prototype.executeBookingOnce;
          t.mock.method(ClinikoClassAttendanceWriter.prototype, "executeBookingOnce", function(this: ClinikoClassAttendanceWriter,
            ...[q, signal, checks]: Parameters<typeof write>) {
            return write.call(this, q, signal, { ...checks, beforeSend: async stop => {
              const permitted = await checks.beforeSend(stop); assert.equal(permitted, true);
              f.setTime(completedAt); return permitted;
            } });
          });
        }
      }
      await f.drain();
      assert.equal(finalRead, true, "the lease expires after valid final availability, not during preparation");
      const state = await f.state(), action = Object.values(state.actions)[0]!;
      assert.ok(action.mutation.request.kind === "book");
      assert.ok(Date.parse(action.mutation.request.patient.expiresAt) > Date.parse(completedAt) + 120_000);
      assert.ok(Date.parse(action.mutation.request.offer.expiresAt) > Date.parse(completedAt));
      assert.equal(f.recalls.length, 1);
      assert.equal("posts" in f ? f.posts : f.writes.length, Number(renewed));
      assert.equal(action.status === "committed", renewed);
      await f.drain();
      assert.equal("posts" in f ? f.posts : f.writes.length, Number(renewed), "no replay");
    } finally { await f.close(); }
  });
