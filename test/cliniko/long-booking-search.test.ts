import assert from "node:assert/strict";
import test from "node:test";
import { OwnerFileBookingPolicy } from "../../src/standalone/owner-file-booking-policy.ts";
import { bookingOffersFixture } from "../support/booking-offers.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const approval = { availabilityPlan: { mode: "online" as const, maxSearchDays: 90 }, maxAdvanceDays: 90 };
test("E2E-356 complete approved longer search finds a late slot and revalidates one exact native booking", async () => {
  const f = await bookingOffersFixture(approval);
  try {
    f.setStarts(["2026-10-30T04:00:00.000Z", "2026-10-30T05:00:00.000Z"]);
    const proof = await f.verify();
    const listed = resultValue(await f.list(proof, "2026-10-05", "2026-11-01"));
    assert.equal(listed.choices.length, 2); assert.equal(listed.choices[0]!.startsAt, "2026-10-30T04:00:00.000Z");
    assert.equal(f.allTraffic.filter(path => path.endsWith("/available_times")).length, 4);
    const choice = listed.choices[0]!;
    resultValue(await f.propose(proof, "late-choice", choice.offerRef));
    resultValue(await f.confirm()); await f.drain();
    assert.equal(f.posts, 1); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    assert.equal(f.claims, f.allTraffic.length);
  } finally { await f.close(); }
});

for (const fault of ["laterFailure", "metadataDrift", "incompletePage", "revoked", "abort"] as const) test(`E2E-356 ${fault} cannot publish partial early offers`, async () => {
  const f = await bookingOffersFixture(approval);
  let source: ReturnType<typeof f.freshSource> | undefined;
  try {
    const proof = await f.verify(), stop = new AbortController();
    const port: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/available_times") && url.searchParams.get("from") === "2026-10-26") {
        if (fault === "laterFailure") return new Response(null, { status: 503 });
        if (fault === "incompletePage") return Response.json({ total_entries: 2, available_times: [] });
        if (fault === "revoked") await f.replacePolicy({ approved: false });
        if (fault === "abort") stop.abort();
      }
      const response = await f.ownerPorts.fetchPort(input, init);
      if (fault === "metadataDrift" && url.pathname === "/v1/practitioners/22") {
        const body = await response.json(); body.display_name = `Changed ${++names}`; return Response.json(body);
      }
      return response;
    };
    let names = 0;
    source = resultValue(f.createSource({}, port));
    const read = await source.list(f.scope, proof, "2026-10-05", "2026-11-01", "2026-10-04T06:00:00.000Z", stop.signal);
    assert.equal(read.ok, false, fault);
    assert.equal(f.posts, 0);
  } finally { source?.dispose(); await f.close(); }
});

test("E2E-356 legacy approvals keep their native range and explicit plans reject malformed or overlong bounds", async () => {
  const legacy = await bookingOffersFixture(), extended = await bookingOffersFixture(approval);
  try {
    const oldProof = await legacy.verify();
    assert.equal((await legacy.list(oldProof, "2026-10-05", "2026-11-01")).ok, false);
    const proof = await extended.verify(), before = extended.allTraffic.length;
    assert.equal((await extended.list(proof, "2026-10-05", "2027-01-03")).ok, false);
    assert.equal(extended.allTraffic.slice(before).some(path => path.endsWith("/available_times")), false);
    for (const plan of [{ mode: "roster", maxSearchDays: 30 }, { mode: "online", maxSearchDays: 0 },
      { mode: "online", maxSearchDays: 91 }, { mode: "online", maxSearchDays: "30" }, { mode: "online", maxSearchDays: 30, patientId: "42" }]) {
      await extended.replacePolicy({ availabilityPlan: plan as never });
      assert.equal((await OwnerFileBookingPolicy.capture({ ...extended.bookingPolicy.binding(), path: extended.path,
        directory: extended.directory, clock: () => "2026-10-04T06:00:00.000Z" })).ok, false);
    }
  } finally { await extended.close(); await legacy.close(); }
});

test("E2E-356 withdrawal after a late-range proposal prevents the final native send", async () => {
  const f = await bookingOffersFixture(approval);
  try {
    f.setStarts(["2026-10-30T04:00:00.000Z"]); const proof = await f.verify();
    const choice = resultValue(await f.list(proof, "2026-10-05", "2026-11-01")).choices[0]!;
    resultValue(await f.propose(proof, "late-proposal", choice.offerRef));
    f.setOnRecall(() => f.replacePolicy({ availabilityPlan: { mode: "online", maxSearchDays: 7 } }));
    resultValue(await f.confirm()); await f.drain();
    assert.equal(f.posts, 0); assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
  } finally { await f.close(); }
});
