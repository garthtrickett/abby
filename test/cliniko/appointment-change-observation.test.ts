import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCancellationWriter, ClinikoRescheduleWriter } from "../../src/cliniko/appointment-write.ts";
import type { ClinikoCancellationRequest, ClinikoRescheduleRequest } from "../../src/cliniko/appointment-write.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";

function fixture(kind: "cancel" | "reschedule", mode: "accepted" | "lost" | "wrongPatient" | "unavailable" | "conflict" = "accepted") {
  const scope = { tenantId: "observed-change", clinicId: "clinic", locationId: "main" }, at = "2026-10-21T04:00:00.000Z";
  const target = { scope, patientId: "42", appointmentId: "91", practitionerId: "22", appointmentTypeId: "33",
    startsAt: "2026-11-01T04:00:00.000Z", endsAt: "2026-11-01T04:30:00.000Z" };
  const cancel: ClinikoCancellationRequest = { ...target, cancellationReason: 10 };
  const move: ClinikoRescheduleRequest = { ...target, newStartsAt: "2026-11-02T04:00:00.000Z", newEndsAt: "2026-11-02T04:30:00.000Z" };
  const budget = new ClinikoReadBudget(180), config = { scope, apiKey: "synthetic-observation-au5", contactEmail: "test@example.test", businessId: "11", rateBudget: budget };
  let changed = false, clockReads = 0; const methods: string[] = [];
  const port: typeof fetch = async (url, init) => {
    const u = new URL(String(url)); assert.equal(u.origin, "https://api.au5.cliniko.com"); methods.push(init!.method!);
    if (init?.method === "PATCH") {
      assert.equal(u.pathname, `/v1/individual_appointments/91${kind === "cancel" ? "/cancel" : ""}`); changed = true;
      if (mode === "lost") throw Error("Synthetic change response lost");
      return kind === "cancel" ? new Response(null, { status: 204 }) : Response.json({});
    }
    if (u.pathname.endsWith("/conflicts")) return Response.json({ conflicts: { exist: mode === "conflict" } });
    if (changed && mode === "unavailable") return new Response(null, { status: 503 });
    const base = "https://api.au5.cliniko.com/v1";
    return Response.json({ id: "91", starts_at: changed && kind === "reschedule" ? move.newStartsAt : target.startsAt,
      ends_at: changed && kind === "reschedule" ? move.newEndsAt : target.endsAt,
      cancelled_at: changed && kind === "cancel" ? at : null, archived_at: null, deleted_at: null,
      patient: { links: { self: `${base}/patients/${changed && mode === "wrongPatient" ? "43" : "42"}` } },
      business: { links: { self: `${base}/businesses/11` } }, practitioner: { links: { self: `${base}/practitioners/22` } },
      appointment_type: { links: { self: `${base}/appointment_types/33` } } });
  };
  const clock = () => { clockReads++; return at; };
  const c = ClinikoCancellationWriter.create(config, port, clock), r = ClinikoRescheduleWriter.create(config, port, clock); assert.ok(c.ok && r.ok);
  return { c: c.value, r: r.value, config, port, cancel, move, methods, budget, at, get clockReads() { return clockReads; } };
}

for (const kind of ["cancel", "reschedule"] as const)
test(`${kind} exposes only its own acknowledged-and-inspected best-effort observation, without extra IO or clock reads`, async () => {
  const f = fixture(kind), result = kind === "cancel" ? await f.c.cancelOnce(f.cancel) : await f.r.rescheduleOnce(f.move);
  assert.ok(result.ok); const owner = kind === "cancel" ? f.c : f.r, observed = owner.observedOutcome(result.value); assert.ok(observed);
  assert.equal(observed.kind, kind === "cancel" ? "cancellationObserved" : "reschedulingObserved");
  assert.equal(observed.acknowledgedStatus, kind === "cancel" ? 204 : 200); assert.equal(observed.observedAt, f.at);
  assert.equal(observed.request.patientId, "42"); assert.equal(observed.request.appointmentId, "91");
  assert.equal(Object.isFrozen(observed.request.scope), true); assert.equal(Object.isFrozen(observed.selection), true);
  assert.equal(f.clockReads, 2); assert.equal(f.methods.length, kind === "cancel" ? 3 : 4);
  assert.equal(owner.sharesRequestBudget(f.budget), true); assert.equal(owner.sharesRequestBudget(new ClinikoReadBudget(180)), false);
  assert.equal(owner.observedOutcome(structuredClone(result.value)), undefined);
  assert.equal(owner.observedOutcome({ kind: result.value.kind }), undefined);
  const other = kind === "cancel" ? ClinikoCancellationWriter.create(f.config, f.port) : ClinikoRescheduleWriter.create(f.config, f.port); assert.ok(other.ok);
  assert.equal(other.value.observedOutcome(result.value), undefined);
  assert.equal((kind === "cancel" ? f.r : f.c).observedOutcome(result.value), undefined);
  assert.equal(f.clockReads, 2); assert.equal(f.methods.length, kind === "cancel" ? 3 : 4);
});

for (const kind of ["cancel", "reschedule"] as const) for (const mode of kind === "cancel"
  ? ["lost", "wrongPatient", "unavailable"] as const : ["lost", "wrongPatient", "unavailable", "conflict"] as const)
test(`${kind} ${mode} cannot become a verified workflow memo source from a later observed diary state`, async () => {
  const f = fixture(kind, mode), result = kind === "cancel" ? await f.c.cancelOnce(f.cancel) : await f.r.rescheduleOnce(f.move);
  assert.ok(result.ok); assert.equal((kind === "cancel" ? f.c : f.r).observedOutcome(result.value), undefined);
  if (mode === "lost") {
    const later = kind === "cancel" ? await f.c.observe(f.cancel) : await f.r.observeReschedule(f.move); assert.ok(later.ok);
    assert.equal(later.value.kind, kind === "cancel" ? "cancelled" : "new");
    assert.equal((kind === "cancel" ? f.c : f.r).observedOutcome(later.value), undefined);
  }
  assert.equal(f.methods.filter(x => x === "PATCH").length, 1);
});

test("cancellation captures the original request before asynchronous preparation and exposes an immutable subject", async () => {
  const f = fixture("cancel"), original = structuredClone(f.cancel);
  const result = await f.c.cancelOnce(f.cancel, undefined, async () => {
    (f.cancel as { patientId: string }).patientId = "43"; (f.cancel.scope as { tenantId: string }).tenantId = "mutated"; return true;
  });
  assert.ok(result.ok); assert.equal(result.value.kind, "cancelled"); assert.deepEqual(f.c.observedOutcome(result.value)!.request, original);
});
