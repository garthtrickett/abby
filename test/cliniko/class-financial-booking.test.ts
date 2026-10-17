import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoClassAttendanceReader } from "../../src/cliniko/class-attendance-read.ts";
import { financialClassBookingFixture } from "../support/financial-class-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

type Fixture = Awaited<ReturnType<typeof financialClassBookingFixture>>;
async function selected(f: Fixture) {
  await f.verify();
  resultValue(await f.reception.readBookingMenu(f.scope, f.turn("financial-menu"), "2026-10-08", "2026-10-08", f.classSessionConfig.clock()));
  await f.play(); resultValue(await f.reception.selectBookingMenu(f.scope, f.turn("financial-choice"), 1, f.classSessionConfig.clock())); await f.play();
}
async function resume(f: Fixture) {
  const ref = f.pending().readySelection; assert.ok(ref);
  resultValue(await f.reception.proposeBooking(f.scope, f.turn("financial-resume"), ref.verificationRef, ref.offerRef, f.classSessionConfig.clock()));
}
async function consented(f: Fixture) { await selected(f); await f.readback(); await f.accept(); await resume(f); }

for (const passes of [false, true]) test(`actual class host separates private financial consent from native clinical confirmation (pass=${passes})`, async () => {
  const f = await financialClassBookingFixture({ passes }); try {
    await selected(f); assert.equal(Object.keys((await f.state()).actions).length, 0); assert.equal(f.writes.length, 0); assert.equal(f.funding.rows.size, 1);
    assert.equal(f.selections[0]?.bookingKind, "classBook"); assert.equal(f.selections[0]?.classSessionId, "94");
    assert.equal(f.selections[0]?.classPass?.selection.patientCaseId, passes ? f.pass.caseId : undefined);
    await f.readback(); assert.equal(f.pending().readySelection, undefined); await f.accept(); assert.ok(f.pending().readySelection); assert.equal(f.writes.length, 0);
    await resume(f); resultValue(await f.confirm()); resultValue(await f.drain()); assert.equal(f.writes.length, 1);
    const action = Object.values((await f.state()).actions)[0]!; assert.equal(action.status, "committed");
    assert.equal(f.proof().targetRef, "cliniko:attendee:401"); assert.ok(f.proof().financialConsent);
    assert.equal(f.writes[0]?.patient_case_id, passes ? f.pass.caseId : undefined);
    const state = JSON.stringify(await f.state()); assert.ok(!state.includes("class-financial-recipient")); assert.ok(!state.includes("GBP 12.00")); assert.ok(!state.includes("financialConsent"));
  } finally { await f.close(); }
});
for (const passes of [false, true]) test(`an explicit independent no-deposit assessment retains ordinary class/pass approval (pass=${passes})`, async () => {
  const f = await financialClassBookingFixture({ passes, required: false }); try {
    await f.verify(); await f.propose(); assert.equal(f.funding.rows.size, 0); assert.equal(f.pending().inputActive, false);
    resultValue(await f.confirm()); resultValue(await f.drain()); assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});
for (const failure of ["unknown", "lostIntent", "unplayed"] as const) test(`class financial ${failure} cannot become a clinical confirmation`, async () => {
  const f = await financialClassBookingFixture({ ...(failure === "unknown" ? { quote: () => undefined } : {}),
    ...(failure === "lostIntent" ? { lostIntent: true } : {}), ...(failure === "unplayed" ? { play: async () => undefined } : {}) }); try {
    await selected(f); if (failure === "unplayed") { await f.readback(); await f.accept(); }
    assert.equal(Object.keys((await f.state()).actions).length, 0); assert.equal(f.writes.length, 0); assert.equal(f.pending().readySelection, undefined);
  } finally { await f.close(); }
});
test("native financial observation response loss cannot erase an acknowledged attendee or replay it", async () => {
  const f = await financialClassBookingFixture({ lostObservation: true }); try {
    await consented(f); resultValue(await f.confirm()); resultValue(await f.drain()); assert.equal(f.writes.length, 1);
    assert.equal(Object.values((await f.state()).actions)[0]?.status, "committed"); assert.equal(f.funding.rows.size, 2);
    resultValue(await f.drain()); assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});
test("lost native attendee ACK leaves only prospective financial work and cannot be promoted by the matching diary", async () => {
  const f = await financialClassBookingFixture(); try {
    await consented(f); f.loseWrite(); resultValue(await f.confirm()); resultValue(await f.drain());
    assert.equal(f.writes.length, 1); assert.equal(f.funding.rows.size, 1);
    assert.notEqual(Object.values((await f.state()).actions)[0]?.status, "committed");
    resultValue(await f.drain()); assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});
test("renewed live call leases preserve unchanged financial terms; they do not extend the class offer", async () => {
  const f = await financialClassBookingFixture(); try {
    await selected(f); const initial = (await f.state()).sessionLease!.expiresAt;
    const seconds = Math.ceil((Date.parse(initial) - Date.parse(f.classSessionConfig.clock())) / 1_000) + 1;
    assert.ok(seconds < 120); await f.pause(seconds); assert.ok(Date.parse(f.classSessionConfig.clock()) > Date.parse(initial));
    await f.readback(); await f.accept(); await resume(f); resultValue(await f.confirm()); resultValue(await f.drain()); assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});
test("a live renewed lease cannot extend an expired financial class quote or offer", async () => {
  const f = await financialClassBookingFixture(); try {
    await selected(f); await f.pause(121); await f.readback(); await f.accept();
    assert.equal(f.pending().readySelection, undefined); assert.equal(f.writes.length, 0); assert.equal(Object.keys((await f.state()).actions).length, 0);
  } finally { await f.close(); }
});
test("financial acceptance cannot override withdrawn approved-pass authority", async () => {
  const f = await financialClassBookingFixture({ passes: true }); try {
    await consented(f); resultValue(await f.confirm()); f.pass.deny(); resultValue(await f.drain());
    assert.equal(f.writes.length, 0); assert.equal(f.funding.rows.size, 1);
  } finally { await f.close(); }
});
test("a required financial source read cannot bypass the configured 180-request class-pass ceiling", async () => {
  const f = await financialClassBookingFixture({ passes: true, budgetLimit: 180 }); try {
    await consented(f); assert.equal(f.pending().captureRequestCost, 1); resultValue(await f.confirm()); resultValue(await f.drain());
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  } finally { await f.close(); }
});
test("an explicit no-deposit pass assessment needs no additional request in the existing 180 profile", async () => {
  const f = await financialClassBookingFixture({ passes: true, required: false, budgetLimit: 180 }); try {
    await f.verify(); await f.propose(); assert.equal(f.pending().captureRequestCost, 0);
    resultValue(await f.confirm()); resultValue(await f.drain()); assert.equal(f.writes.length, 1); assert.equal(f.funding.rows.size, 0);
  } finally { await f.close(); }
});
test("a new class menu or withdrawn financial authority invalidates private consent", async () => {
  const f = await financialClassBookingFixture(); try {
    await selected(f); await f.readback(); await f.accept(); assert.ok(f.pending().readySelection);
    resultValue(await f.reception.readBookingMenu(f.scope, f.turn("new-menu"), "2026-10-08", "2026-10-08", f.classSessionConfig.clock()));
    assert.equal(f.pending().readySelection, undefined); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
  const g = await financialClassBookingFixture(); try {
    await consented(g); resultValue(await g.confirm()); g.denyFinancial(); resultValue(await g.drain()); assert.equal(g.writes.length, 0);
  } finally { await g.close(); }
});
test("financial preparation finishes before the final exact native class capacity read", async t => {
  const f = await financialClassBookingFixture(); try {
    await consented(f); resultValue(await f.confirm());
    const original = ClinikoClassAttendanceReader.prototype.inspectForSend;
    t.mock.method(ClinikoClassAttendanceReader.prototype, "inspectForSend", async function(this: ClinikoClassAttendanceReader, ...args: Parameters<typeof original>) {
      const r = await original.apply(this, args); f.events.push("finalCapacityComplete"); return r;
    });
    resultValue(await f.drain()); const final = f.events.lastIndexOf("finalCapacityComplete"), post = f.events.indexOf("clinical:POST:/v1/attendees");
    assert.ok(final > 0 && post > final); assert.deepEqual(f.events.slice(final + 1, post), []); assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});
test("an edited provider financial intent cannot use a prior private acceptance to send attendance", async () => {
  const f = await financialClassBookingFixture(); try {
    await consented(f); resultValue(await f.confirm());
    const intent = [...f.funding.rows.values()].find(r => String(r.notes).includes("financial intent")); assert.ok(intent);
    intent.notes = "Staff changed the private financial instruction.";
    resultValue(await f.drain()); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0); assert.equal(f.funding.rows.size, 1);
  } finally { await f.close(); }
});
test("financial authority withdrawn at the last capacity response prevents the native POST", async t => {
  const f = await financialClassBookingFixture(); try {
    await consented(f); resultValue(await f.confirm()); const original = ClinikoClassAttendanceReader.prototype.inspectForSend;
    let finalRead = false;
    t.mock.method(ClinikoClassAttendanceReader.prototype, "inspectForSend", async function(this: ClinikoClassAttendanceReader, ...args: Parameters<typeof original>) {
      const r = await original.apply(this, args); finalRead = true; f.denyFinancial(); return r;
    });
    resultValue(await f.drain()); assert.equal(finalRead, true); assert.equal(f.writes.length, 0); assert.equal(f.funding.rows.size, 1);
    assert.notEqual(Object.values((await f.state()).actions)[0]?.status, "committed");
  } finally { await f.close(); }
});
test("ending the class call owner at the native ACK preserves independent financial retention", async t => {
  let observed!: () => void; const retained = new Promise<void>(resolve => { observed = resolve; });
  const f = await financialClassBookingFixture({ onObservation: observed }); try {
    await consented(f); resultValue(await f.confirm()); const write = f.host.write.bind(f.host);
    t.mock.method(f.host, "write", (...[mutation, now, signal, acknowledged]: Parameters<typeof write>) => write(mutation, now, signal, receipt => { acknowledged?.(receipt); f.host.dispose(); }));
    resultValue(await f.drain()); await retained;
    assert.equal(f.writes.length, 1); assert.equal(Object.values((await f.state()).actions)[0]?.status, "committed"); assert.ok(f.proof().financialConsent);
    assert.equal(f.financialLife.signal.aborted, false);
  } finally { await f.close(); }
});
