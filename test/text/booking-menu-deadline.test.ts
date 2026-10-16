import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import type { BookingMenuRead } from "../../src/core/booking-menu.ts";
import type { BookingMenuHost } from "../../src/core/host.ts";
import { bookingMenuDeadlineMs } from "../../src/reference/booking-menu-turns.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { proposalHarness, proposalNow, resultValue } from "../support/agent-appointment-proposals.ts";

for (const phase of ["read", "selection", "evidence"] as const)
for (const boundary of ["live", "externalFirst", "deadlineFirst", "revision", "ended", "expiredLease", "invalidClock", "backwardsClock"] as const)
test(`E2E-353/E2E-358 booking menu ${phase} deadline preserves ${boundary} boundary and refuses late options`, async context => {
  const scope = { tenantId: "booking-menu-deadline", clinicId: "clinic", locationId: "main" };
  const app = proposalHarness(scope, "embedded");
  const readPolicy = app.policy.read.bind(app.policy);
  app.policy.read = async scope => {
    const result = await readPolicy(scope);
    return result.ok ? ok({ ...result.value, staffWorkEnabled: true }) : result;
  };
  await app.enable();
  resultValue(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1",
    expectedVersion: resultValue(await app.policy.read(scope)).policyVersion, enabled: true }));
  const proposal = await app.admit("reschedule");
  const admitted = resultValue(await app.runtime.read(proposal.turn.callId));
  resultValue(await app.runtime.startPresentation(proposal.turn.callId, admitted.pendingPresentationId!, proposal.turn.sessionId, proposalNow));
  resultValue(await app.runtime.resolvePresentation(proposal.turn.callId, admitted.pendingPresentationId!, "played", proposal.turn.sessionId, proposalNow));
  const menu: BookingMenuRead = { scope, callId: proposal.turn.callId, sessionId: proposal.turn.sessionId,
    policyVersion: admitted.policy.policyVersion, observedAt: proposalNow, timeZone: "Etc/UTC",
    practitionerName: "Alex", appointmentTypeName: "Physio", reservable: false,
    choices: [{ startsAt: "2026-10-08T10:00:00.000Z", endsAt: "2026-10-08T10:30:00.000Z",
      expiresAt: "2026-10-03T10:01:00.000Z" }] };
  let entered!: () => void, release!: () => void, evidenceReads = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let readSignal: AbortSignal | undefined;
  const hold = async (signal: AbortSignal | undefined) => { readSignal = signal; entered(); await held; };
  const host = Object.assign(app.host, {
    bookingMenuAvailable: () => true,
    readBookingMenu: async (query: Parameters<BookingMenuHost["readBookingMenu"]>[0]) => {
      if (phase === "read") await hold(query.signal);
      return ok(menu);
    },
    selectBookingMenu: async (query: Parameters<BookingMenuHost["selectBookingMenu"]>[0]) => {
      if (phase === "selection") await hold(query.signal);
      return ok({ verificationRef: "private-menu-proof", offerRef: "private-menu-offer" });
    },
    resolveBooking: async (_scope: typeof scope, _proof: string, _offer: string, _now: string, signal?: AbortSignal) => {
      evidenceReads++;
      if (phase === "evidence") await hold(signal);
      return ok({ kind: "book" as const, patient: { scope, patientRef: "private-menu-patient", verificationRef: "private-menu-proof",
        expiresAt: "2026-10-03T10:01:00.000Z" }, offer: { scope, offerRef: "private-menu-offer", serviceRef: "physio",
        startsAt: menu.choices[0]!.startsAt, expiresAt: "2026-10-03T10:01:00.000Z" } });
    },
  });
  let clock = proposalNow;
  const reception = new TextReception(app.ledger, app.policy, host, undefined, undefined, undefined, undefined, () => clock);
  const turn = { ...proposal.turn, turnId: "slow-menu", text: "Show me available times" };
  if (phase !== "read") {
    const shown = resultValue(await reception.readBookingMenu(scope, { ...turn, turnId: "initial-menu" },
      "2026-10-08", "2026-10-08", proposalNow));
    assert.match(shown.callerMessages.at(-1)!, /option one/);
    resultValue(await app.runtime.startPresentation(turn.callId, shown.pendingPresentationId!, turn.sessionId, proposalNow));
    resultValue(await app.runtime.resolvePresentation(turn.callId, shown.pendingPresentationId!, "played", turn.sessionId, proposalNow));
  }
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const external = new AbortController();
    const pending = phase === "read" ? reception.readBookingMenu(scope, turn,
      "2026-10-08", "2026-10-08", proposalNow, undefined, undefined, external.signal) :
      reception.selectBookingMenu(scope, turn, 1, proposalNow, external.signal);
    await started;
    context.mock.timers.tick(bookingMenuDeadlineMs - 1);
    assert.equal(readSignal?.aborted, false);
    if (boundary === "revision") resultValue(await app.runtime.acceptTurn(
      { ...turn, turnId: "newer-turn", text: "Another request" }, { kind: "unavailableAction", actionKind: "book" }, proposalNow));
    if (boundary === "ended") resultValue(await app.runtime.endCall(turn.callId, turn.sessionId, proposalNow));
    const before = resultValue(await app.runtime.read(turn.callId));
    clock = boundary === "invalidClock" ? "invalid" : boundary === "backwardsClock" ?
      new Date(Date.parse(proposalNow) - 1).toISOString() : new Date(Date.parse(proposalNow) + (boundary === "expiredLease" ? 30_000 : bookingMenuDeadlineMs)).toISOString();
    if (boundary === "externalFirst") external.abort();
    context.mock.timers.tick(1);
    if (boundary === "deadlineFirst") external.abort();
    const result = await pending;
    assert.equal(readSignal?.aborted, true, "the original native deadline remains enforced");
    const state = resultValue(await app.runtime.read(turn.callId));
    if (boundary === "live") {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(state.lifecycle, "active");
      assert.ok(state.processedTurnIds.includes(turn.turnId));
      assert.match(state.callerMessages.at(-1)!, /can't check or select those booking options.*fresh options/);
    } else {
      assert.equal(result.ok, false, "a stale, ended or expired owner cannot publish the timeout notice");
      if (!result.ok && (boundary === "externalFirst" || boundary === "deadlineFirst")) assert.equal(result.error.kind, "staleTurn");
      if (!result.ok && boundary === "expiredLease") assert.equal(result.error.kind, "leaseLost");
      assert.deepEqual(state, before);
    }
    assert.equal(Object.keys(state.actions).length, 0);
    assert.equal(app.host.writes.length, 0);
    assert.equal(app.host.tasks(scope).length, 0);
    assert.equal(evidenceReads, phase === "evidence" ? 1 : 0);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(resultValue(await app.runtime.read(turn.callId)), state, "late options or evidence cannot replace the refusal or create an action");
    assert.equal(evidenceReads, phase === "evidence" ? 1 : 0, "a late selection cannot start a protected booking read");
  } finally {
    release();
    context.mock.timers.reset();
  }
});
