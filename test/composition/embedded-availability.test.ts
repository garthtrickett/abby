import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { Result } from "../../src/core/model.ts";
import { AvailabilityTextRunner } from "../../src/reference/availability-text-runner.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";

function value<T>(result: Result<T, { kind: string }>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

test("E2E-125 text: embedded host runs shared Cliniko availability ingress and owns failure work", async () => {
  const scope = { tenantId: "embedded-availability-tenant", clinicId: "clinic", locationId: "frontdesk" };
  const now = "2026-10-01T00:00:00Z";
  const startsAt = "2026-10-02T00:00:00.000Z";
  let mode: "shown" | "empty" | "failed" = "shown";
  const requests: string[] = [];
  const fetchPort: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    assert.equal(init?.method ?? "GET", "GET");
    if (mode === "failed") return Response.json({}, { status: 503 });
    if (path === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: true,
      appointment_type_ids: ["33"], time_zone_identifier: "Australia/Sydney" });
    if (path === "/v1/practitioners/22") return Response.json({ id: "22", active: true, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/33") return Response.json({ id: "33", show_in_online_bookings: true });
    if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1, practitioners: [{ id: "22" }] });
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: "33" }] });
    if (path.endsWith("/available_times")) return Response.json({ total_entries: mode === "shown" ? 1 : 0,
      available_times: mode === "shown" ? [{ appointment_start: startsAt }] : [] });
    throw new Error("unexpected Cliniko request");
  };
  const reader = value(ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
  fetchPort, () => now));
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore();
  const host = new ReferenceClinicHost([], []);
  const reception = createEmbeddedTextComposition(ledger, policy, host, reader);
  const runner = new AvailabilityTextRunner(reception, scope, () => now);
  const question = { text: "Do you have an opening?", from: "2026-10-02", to: "2026-10-02" };

  value(await reception.startCall("empty-text-call", scope, now));
  assert.deepEqual(await reception.completeTextPresentation(scope, "empty-text-call", "missing", now),
    { ok: false, error: { kind: "invalidTransition" } });

  for (const expected of ["shown", "empty", "failed"] as const) {
    mode = expected;
    const prepared = value(await runner.prepare(question));
    assert.equal(prepared.status, expected);
    assert.match(prepared.message, expected === "shown" ? /can't reserve or confirm/ : /staff follow-up/);
    assert.doesNotMatch(prepared.message, /staff (has|will) (receive|contact)|confirmed appointment/i);
    assert.deepEqual(await runner.confirmWritten(prepared), { ok: true, value: true });
    const state = value(await reception.read(scope, prepared.callId));
    assert.deepEqual(await runner.confirmWritten(prepared), { ok: true, value: true });
    assert.equal(value(await reception.read(scope, prepared.callId)).version, state.version);
    assert.equal(state.lifecycle, "ended");
    assert.equal(state.terminal?.reason, "textCompleted");
    assert.deepEqual(state.callerMessages, []);
    assert.equal(state.presentations[prepared.presentationId]?.status, "played");
    assert.deepEqual(state.actions, {});
    if (expected === "failed") {
      assert.deepEqual(Object.values(state.staffItems).map(item => item.status), ["requested"]);
      const settled = value(await reception.drain(scope, prepared.callId, now));
      assert.deepEqual(Object.values(settled.staffItems).map(item => item.status), ["open"]);
    } else {
      assert.deepEqual(state.staffItems, {});
    }
  }
  assert.ok(requests.some(path => path.endsWith("/available_times")));
  assert.deepEqual(host.bookings(scope), []);
  assert.equal(host.tasks(scope).length, 1);
});
