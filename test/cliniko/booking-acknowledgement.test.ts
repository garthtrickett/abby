import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoBookingWriter } from "../../src/cliniko/booking-write.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { value } from "../support/outbound-records.ts";

function fixture(options: { clock?: () => string; response?: "lost" | "nonexact" | "headers" } = {}) {
  const scope = { tenantId: "memo-clinical", clinicId: "clinic", locationId: "main" }, now = "2026-11-02T00:00:00.000Z";
  const request = { scope: { ...scope }, patientId: "42", marker: randomUUID(), startsAt: "2026-11-05T01:00:00.000Z", endsAt: "2026-11-05T01:30:00.000Z" };
  const config = { scope, apiKey: "synthetic-clinical-au5", contactEmail: "ops@example.invalid", businessId: "11", practitionerId: "22", appointmentTypeId: "33", rateBudget: new ClinikoReadBudget(180) };
  let posts = 0;
  const native: typeof fetch = async (_url, init) => {
    posts++; const body = JSON.parse(String(init!.body));
    if (options.response === "lost") throw Error("Synthetic response lost");
    if (options.response === "headers") return new Response("not JSON", { status: 201 });
    return Response.json({ id: "91", notes: body.notes, starts_at: body.starts_at, ends_at: body.ends_at,
      cancelled_at: null, archived_at: null, deleted_at: null,
      patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${options.response === "nonexact" ? "43" : body.patient_id}` } },
      business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } }, practitioner: { links: { self: "https://api.au5.cliniko.com/v1/practitioners/22" } },
      appointment_type: { links: { self: "https://api.au5.cliniko.com/v1/appointment_types/33" } } }, { status: 201 });
  };
  const writer = value(ClinikoBookingWriter.create(config, native, options.clock ?? (() => now)));
  return { writer, request, config, now, native, get posts() { return posts; } };
}

test("the actual writer exposes exact transient native provenance before its acknowledgement observer", async () => {
  const f = fixture(); let observed = false;
  const receipt = value(await f.writer.writeOnce(f.request, undefined, undefined, r => {
    const known = f.writer.acknowledgement(r); assert.ok(known); observed = true;
    assert.equal(known.request.patientId, "42"); assert.equal(known.request.marker, f.request.marker);
    assert.equal(known.appointmentRef, "cliniko:appointment:91");
  }));
  assert.equal(receipt.kind, "accepted"); assert.equal(observed, true); assert.equal(f.posts, 1);
  assert.ok(f.writer.acknowledgement(receipt));
});

test("a copied, fabricated or different writer's acknowledgement cannot become a memo source", async () => {
  const f = fixture(), receipt = value(await f.writer.writeOnce(f.request)); assert.equal(receipt.kind, "accepted");
  assert.equal(f.writer.acknowledgement(structuredClone(receipt)), undefined);
  assert.equal(f.writer.acknowledgement({ kind: "accepted", appointmentRef: "cliniko:appointment:91" }), undefined);
  const other = value(ClinikoBookingWriter.create(f.config, f.native, () => f.now)); assert.equal(other.acknowledgement(receipt), undefined);
  assert.equal(f.writer.acknowledgement({ kind: "committed", hostRef: "cliniko:appointment:91" }), undefined);
});

test("an input mutation or attempted receipt change cannot rewrite captured patient/interval/account facts", async () => {
  const f = fixture(), receipt = value(await f.writer.writeOnce(f.request)); const known = f.writer.acknowledgement(receipt); assert.ok(known);
  f.request.patientId = "43"; f.request.startsAt = "private text"; f.config.scope.clinicId = "changed";
  assert.equal(known.request.patientId, "42"); assert.equal(known.selection.scope.clinicId, "clinic");
  assert.equal(Object.isFrozen(known.request), true); assert.equal(Object.isFrozen(known.selection.scope), true);
  if (!Object.isFrozen(receipt)) (receipt as any).appointmentRef = "cliniko:appointment:92";
  assert.equal(f.writer.acknowledgement(receipt), undefined);
});

for (const response of ["lost", "nonexact", "headers"] as const)
test(`${response} native result cannot mint an acknowledged booking source`, async () => {
  const f = fixture({ response }); let observed = 0;
  const receipt = value(await f.writer.writeOnce(f.request, undefined, undefined, () => { observed++; }));
  assert.equal(receipt.kind, "uncertain"); assert.equal(observed, 0); assert.equal(f.writer.acknowledgement(receipt), undefined);
  assert.equal(f.writer.acknowledgement({ kind: "accepted", appointmentRef: "cliniko:appointment:91" }), undefined);
});

test("native provenance adds no new clock observation or success veto after dispatch", async () => {
  let clockReads = 0;
  const f = fixture({ clock: () => { clockReads++; throw Error("No new clock read is permitted"); } }); let observed = false;
  const receipt = value(await f.writer.writeOnce(f.request, undefined, undefined, r => { observed = true; assert.equal(r.kind, "accepted"); }));
  assert.equal(receipt.kind, "accepted"); assert.equal(observed, true); assert.ok(f.writer.acknowledgement(receipt)); assert.equal(clockReads, 0);
});

test("an observer throwing after capture preserves both exact native success and its private provenance", async () => {
  const f = fixture(), receipt = value(await f.writer.writeOnce(f.request, undefined, undefined, () => { throw Error("Observer failed"); }));
  assert.equal(receipt.kind, "accepted"); assert.ok(f.writer.acknowledgement(receipt)); assert.equal(f.posts, 1);
});
