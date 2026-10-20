import assert from "node:assert/strict";
import test from "node:test";
import { financialClassBookingFixture } from "../support/financial-class-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { addCaseHistory, addClassRosterHistory } from "../support/class-pass-history.ts";
import { classLink } from "../support/class-attendance.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";

type Fixture = Awaited<ReturnType<typeof financialClassBookingFixture>>;
async function selected(f: Fixture) {
  await f.verify();
  resultValue(await f.reception.readBookingMenu(f.scope, f.turn("menu"), "2026-10-08", "2026-10-08", f.classSessionConfig.clock()));
  await f.play(); resultValue(await f.reception.selectBookingMenu(f.scope, f.turn("choice"), 1, f.classSessionConfig.clock())); await f.play();
}
async function consented(f: Fixture) {
  await selected(f); await f.readback(); await f.accept();
  const ref = f.pending().readySelection; assert.ok(ref);
  resultValue(await f.reception.proposeBooking(f.scope, f.turn("resume"), ref.verificationRef, ref.offerRef, f.classSessionConfig.clock()));
}
function costBinding(f: Fixture) {
  return { scope: f.scope, credentialFingerprint: clinikoCredentialFingerprint(f.native.config.apiKey), budget: f.native.config.rateBudget };
}
for (const failure of ["unknown", "foreignScope", "foreignAccount", "foreignBudget", "overCeiling"] as const)
test(`financial class proposal refuses ${failure} callback costs before private readback`, async () => {
  const f = await financialClassBookingFixture({ passes: true, budgetLimit: 180 }); try {
    const binding = costBinding(f), port = async () => true;
    f.classSessionConfig.classPermission.allows = failure === "unknown" ? port : declareClinikoRequestCost(port,
      { ...binding, ...(failure === "foreignScope" ? { scope: { ...f.scope, clinicId: "foreign" } } : {}),
        ...(failure === "foreignAccount" ? { credentialFingerprint: "a".repeat(64) } : {}),
        ...(failure === "foreignBudget" ? { budget: new ClinikoReadBudget(180) } : {}) }, failure === "overCeiling" ? 6 : 0);
    await selected(f);
    assert.equal(f.pending().inputActive, false); assert.equal(f.pending().readySelection, undefined);
    assert.equal(f.texts.length, 0); assert.equal(Object.keys((await f.state()).actions).length, 0);
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  } finally { await f.close(); }
});

for (const timing of ["beforeConfirmation", "afterReview", "lastCapacity"] as const)
test(`a changed cost declaration ${timing} cannot send under the earlier financial class plan`, async () => {
  const f = await financialClassBookingFixture({ passes: true, budgetLimit: 180 }); try {
    await consented(f);
    const replace = () => { f.classSessionConfig.classPermission.allows = declareClinikoRequestCost(async () => true, costBinding(f), timing === "beforeConfirmation" ? 6 : 1); };
    if (timing === "beforeConfirmation") replace();
    if (timing === "afterReview") f.onRecall(async () => replace());
    if (timing === "lastCapacity") f.native.onRead(path => { if (f.recalls.length && path === "/v1/attendees") replace(); });
    resultValue(await f.confirm()); resultValue(await f.drain()); assert.equal(f.writes.length, 0);
    assert.notEqual(Object.values((await f.state()).actions)[0]?.status, "committed");
  } finally { await f.close(); }
});

for (const change of ["archived", "capacity", "relationship", "roster"] as const)
test(`a native ${change} change after clinical review is caught by final class capacity`, async () => {
  const f = await financialClassBookingFixture({ passes: true, budgetLimit: 180 }); try {
    await consented(f); resultValue(await f.confirm());
    f.onRecall(async () => {
      const group = f.native.groups.find(row => row.id === "94")!;
      if (change === "archived") group.archived_at = verificationNow;
      if (change === "capacity") group.max_attendees = 2;
      if (change === "relationship") group.practitioner = classLink("practitioners", "99");
      if (change === "roster") for (let i = 0; i < 3; i++) f.native.attendees.push({ id: String(710 + i), ...classLink("attendees", String(710 + i)),
        booking: classLink("bookings", "94"), patient: classLink("patients", String(810 + i)), archived_at: null, deleted_at: null, cancelled_at: null });
    });
    resultValue(await f.drain()); assert.equal(f.recalls.length, 1); assert.equal(f.writes.length, 0);
    assert.notEqual(Object.values((await f.state()).actions)[0]?.status, "committed");
  } finally { await f.close(); }
});

test("financial pass send budgets maximum native page growth and 999 linked case records within 180", async () => {
  let grown = false;
  const pages: string[] = [];
  const f = await financialClassBookingFixture({ passes: true, budgetLimit: 180, fetchAround: port => async (input, init) => {
    const url = new URL(String(input)), resource = url.pathname.split("/").at(-1)!;
    if (grown && ["/v1/practitioners/22/businesses", "/v1/practitioners/22/appointment_types"].includes(url.pathname)) {
      const ids = [resource === "businesses" ? "11" : "33", ...Array.from({ length: 499 }, (_, i) => String(10_000 + i))];
      const page = Number(url.searchParams.get("page")); pages.push(`${resource}:${page}`);
      return Response.json({ [resource]: ids.slice((page - 1) * 100, page * 100).map(id => ({ id, ...classLink(resource, id) })), total_entries: ids.length });
    }
    return port(input, init);
  } }); try {
    addCaseHistory(f.pass.rows, f.pass.caseId, verificationCanaries[2]!, 999, verificationNow);
    f.pass.record.attendee_ids = f.pass.rows.map(row => row.id); f.pass.record.max_sessions = 300;
    await consented(f);
    // Concurrent inactive roster/relationship growth does not grant a place or
    // change the pass fingerprint. It must still fit the global send bound.
    addClassRosterHistory(f.native.attendees, "94", 500, verificationNow); grown = true;
    const before = f.claims;
    resultValue(await f.confirm());
    resultValue(await f.drain());
    assert.equal(f.writes.length, 1); assert.equal(f.recalls.length, 1); assert.ok(f.proof().financialConsent);
    assert.ok(f.claims - before <= 149, `send used ${f.claims - before} native claims`);
    assert.equal(f.claims - before, 149);
    assert.equal(pages.filter(p => p === "businesses:5").length, 3);
    assert.equal(pages.filter(p => p === "appointment_types:5").length, 3);
    assert.equal(f.native.traffic.filter(r => r.path === "/v1/attendees" && r.page === 5).length, 4);
  } finally { await f.close(); }
});
