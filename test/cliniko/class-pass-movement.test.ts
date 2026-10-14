import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { ClinikoClassAttendanceMove } from "../../src/standalone/cliniko-class-attendance-move.ts";
import { decodeClinikoReview, encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { classPassMoveFixture } from "../support/class-pass-move.ts";
import { classLink as link, classAttendee as attendee, classNow as now } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

for (const differentCase of [false, true]) for (const differentService of [false, true]) for (const effect of ["releaseOne", "unchanged", "consumeOne"] as const)
  test(`E2E-409 native pass movement case=${differentCase} service=${differentService} effect=${effect} stages, cancels, links and inspects exact effects`, async () => {
    const f = await classPassMoveFixture({ differentCase, differentService, effect }); assert.ok(f.binding);
    const sourceBefore = f.used(f.sourceCaseId), destinationBefore = f.used(f.destinationCaseId), shared = structuredClone(f.groups);
    const result = resultValue(await f.run()); assert.equal(result.kind, "moved", JSON.stringify({ result, claims: f.claims, phases: f.phases, writes: f.writes.map(w => w.leg) }));
    assert.equal(result.original, "inspectedCancelled"); assert.equal(result.replacement, "inspectedActive"); assert.equal(result.caseAssociation, "inspectedLinked");
    assert.deepEqual(f.writes.map(w => w.leg), ["replacement", "original", "association"]);
    assert.equal(Object.hasOwn(f.writes[0]!.body, "patient_case_id"), false);
    assert.deepEqual(f.writes[2]!.body, { patient_case_id: f.destinationCaseId });
    const change = effect === "releaseOne" ? -1 : effect === "consumeOne" ? 1 : 0;
    assert.equal(f.used(f.sourceCaseId), sourceBefore + change + (differentCase ? 0 : 1));
    assert.equal(f.used(f.destinationCaseId), destinationBefore + 1 + (differentCase ? 0 : change));
    assert.deepEqual(f.groups, shared); assert.ok(f.claims <= 180, `native pipeline claims ${f.claims}`);
    const decoded = resultValue(decodeClinikoReview(f.recalls[0]!.notes)); assert.ok(decoded.request.operation.kind === "classMove");
    assert.deepEqual(decoded.request.operation.pass, f.binding); assert.ok(String(f.recalls[0]!.notes).length < 1100);
    for (const secret of [f.sourceCaseId, f.destinationCaseId, "entitlement", "private-pass-notes", "private-class-proof"]) assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal((await f.run()).ok, false); assert.equal(f.writes.length, 3);
  });
for (const differentService of [false, true]) test(`E2E-409 a full pass funds a replacement only after the original session is released, service=${differentService}`, async () => {
  const f = await classPassMoveFixture({ full: true, differentService }); assert.ok(f.binding); assert.equal(f.binding.source.used, f.binding.source.maximum);
  const result = resultValue(await f.run()); assert.equal(result.kind, "moved", JSON.stringify({ result, claims: f.claims }));
  assert.equal(f.used(f.sourceCaseId), f.binding.source.maximum); assert.deepEqual(f.writes.map(w => w.leg), ["replacement", "original", "association"]);
});
for (const effect of ["unchanged", "consumeOne"] as const) test(`E2E-409 a full pass cannot fund extra usage when source cancellation ${effect}`, async () => {
  const f = await classPassMoveFixture({ full: true, effect }); assert.equal(f.binding, undefined);
  assert.equal((await f.run()).ok, false); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
});
test("E2E-409 a closed expired source pass can transfer attendance to an independently approved eligible different pass", async () => {
  const f = await classPassMoveFixture({ differentCase: true, differentService: true });
  Object.assign(f.records[f.sourceCaseId]!, { closed_at: now, expiry_date: "2026-10-07" });
  const binding = await f.passes.select(f.request, "proposal", f.lifetime.signal); assert.ok(binding); Object.assign(f.request, { pass: binding });
  assert.equal(resultValue(await f.run()).kind, "moved"); assert.equal(f.used(f.sourceCaseId), 1); assert.equal(f.used(f.destinationCaseId), 2);
});
for (const phase of ["cancelOriginal", "linkReplacement", "inspectPass"] as const)
  test(`E2E-409 permission denial at ${phase} compensates only while original cancellation was never sent`, async () => {
    const f = await classPassMoveFixture(); f.deny([phase]); const result = resultValue(await f.run());
    assert.equal(result.kind, phase === "cancelOriginal" ? "restored" : "needsReview", JSON.stringify({ result, claims: f.claims, writes: f.writes }));
    assert.deepEqual(f.writes.map(w => w.leg), phase === "cancelOriginal" ? ["replacement", "compensation"] : phase === "linkReplacement" ? ["replacement", "original"] : ["replacement", "original", "association"]);
    assert.equal(f.original.cancelled_at === null, phase === "cancelOriginal");
    if (phase === "cancelOriginal") { assert.equal(f.used(f.sourceCaseId), f.binding!.source.used); assert.equal(f.attendees.find(row => row.id === "401")!.cancelled_at, now); }
    assert.equal((await f.run()).ok, false);
  });
for (const leg of ["review", "replacement", "original", "association", "compensation"] as const)
  test(`E2E-409 lost ${leg} response cannot replay, relink or cancel an uncertain replacement`, async () => {
    const f = await classPassMoveFixture(); f.lose(leg); if (leg === "compensation") f.deny(["cancelOriginal"]);
    const result = resultValue(await f.run()); assert.equal(result.kind, leg === "review" ? "notSent" : "needsReview");
    assert.deepEqual(f.writes.map(w => w.leg), leg === "review" ? [] : leg === "replacement" ? ["replacement"] : leg === "original" ? ["replacement", "original"] : leg === "compensation" ? ["replacement", "compensation"] : ["replacement", "original", "association"]);
    if (leg === "association") assert.equal(result.caseAssociation, "uncertain");
    assert.equal((await f.run()).ok, false);
  });
test("E2E-409 an auto-associated replacement never authorizes original cancellation or financial compensation", async () => {
  const f = await classPassMoveFixture(); f.onWrite(leg => { if (leg === "replacement") f.attendees.find(row => row.id === "401")!.patient_case = link("patient_cases", f.sourceCaseId); });
  const result = resultValue(await f.run()); assert.equal(result.kind, "needsReview"); assert.equal(result.caseAssociation, "uncertain");
  assert.equal(f.original.cancelled_at, null); assert.deepEqual(f.writes.map(w => w.leg), ["replacement"]);
});
for (const fault of ["authority", "entitlement", "caseRule", "depleted", "proof"] as const) test(`E2E-409 ${fault} drift after review and before replacement cannot start native mutation`, async () => {
  const f = await classPassMoveFixture(); let changed = false;
  f.onRead(path => {
    if (changed || !f.recalls.length || !path.startsWith("/v1/patient_cases/")) return; changed = true;
    if (fault === "authority") f.denyPass(); if (fault === "entitlement") f.changeEntitlement();
    if (fault === "caseRule") f.records[f.sourceCaseId]!.include_cancelled_attendees = true;
    if (fault === "depleted") f.records[f.destinationCaseId]!.max_sessions = 1;
    if (fault === "proof") f.revoke();
  });
  const result = resultValue(await f.run()); assert.equal(result.kind, "notSent"); assert.equal(f.writes.length, 0); assert.equal(f.original.cancelled_at, null);
});
for (const fault of ["extraUse", "sameNetSwap", "rule", "capacity"] as const) test(`E2E-409 ${fault} after association cannot confirm a moved pass attendance`, async () => {
  const f = await classPassMoveFixture({ differentCase: true });
  f.onWrite(leg => {
    if (leg !== "association") return;
    if (fault === "extraUse") f.attendees.push({ ...attendee("605", "705", "42"), patient_case: link("patient_cases", f.destinationCaseId), arrived: null });
    if (fault === "sameNetSwap") { const row = f.attendees.find(row => row.id === "602")!; row.id = "606"; row.links = link("attendees", "606").links; }
    if (fault === "rule") f.records[f.sourceCaseId]!.include_cancelled_attendees = true;
    if (fault === "capacity") for (const id of ["901", "902", "903"]) f.attendees.push(attendee(id, "94", id));
  });
  const result = resultValue(await f.run()); assert.equal(result.kind, "needsReview"); assert.equal(f.writes.length, 3); assert.equal((await f.run()).ok, false);
});
test("E2E-409 pass-aware coordinator and request must agree; legacy mode cannot inherit native membership", async () => {
  const f = await classPassMoveFixture();
  assert.equal(ClinikoClassAttendanceMove.create({ ...f.config, casePass: undefined } as unknown as typeof f.config).ok, false);
  const { casePass: _casePass, ...legacyConfig } = f.config;
  const legacy = resultValue(ClinikoClassAttendanceMove.create(legacyConfig));
  assert.equal((await legacy.executeOnce(f.request, f.lifetime.signal, f.permit)).ok, false); assert.equal(f.writes.length, 0);
});
test("E2E-409 compact pass review preserves all context, enforces its header and rejects invented money or effects", async () => {
  const f = await classPassMoveFixture(); resultValue(await f.run());
  const decoded = resultValue(decodeClinikoReview(f.recalls[0]!.notes)), encoded = resultValue(encodeClinikoReview(decoded.marker, decoded.request));
  assert.equal(encoded, f.recalls[0]!.notes);
  assert.equal(decodeClinikoReview(encoded.replace("Abby class pass movement review v1", "Abby class movement review v1")).ok, false);
  const pass = decoded.request.operation.kind === "classMove" ? decoded.request.operation.pass! : undefined; assert.ok(pass);
  for (const patch of [{ paid: true }, { stagingContractVersion: "unapproved\nversion" }, { destination: { ...pass.destination, used: 1001 } },
    { source: { ...pass.source, effect: "refund" } }]) {
    const request = structuredClone(decoded.request); assert.equal(request.operation.kind, "classMove");
    Object.assign(request.operation, { pass: { ...pass, ...patch } }); assert.equal(encodeClinikoReview(decoded.marker, request).ok, false);
  }
});
test("E2E-409 restoring the exact original before association is caught by the complete source case even without another source roster read", async () => {
  const f = await classPassMoveFixture({ differentCase: true, differentService: true }); let changed = false;
  f.onRead(path => {
    if (!changed && path === "/v1/group_appointments/94" && f.original.cancelled_at !== null) { changed = true; f.original.cancelled_at = null; }
  });
  const result = resultValue(await f.run()); assert.equal(changed, true); assert.equal(result.kind, "needsReview");
  assert.deepEqual(f.writes.map(w => w.leg), ["replacement", "original"]); assert.equal(f.original.cancelled_at, null);
});
test("E2E-409 compensation proves the cancelled replacement is still unlinked and cannot hide late case association", async () => {
  const f = await classPassMoveFixture(); f.deny(["cancelOriginal"]);
  f.onWrite(leg => { if (leg === "compensation") f.attendees.find(row => row.id === "401")!.patient_case = link("patient_cases", f.destinationCaseId); });
  const result = resultValue(await f.run()); assert.equal(result.kind, "needsReview"); assert.equal(f.original.cancelled_at, null);
  assert.deepEqual(f.writes.map(w => w.leg), ["replacement", "compensation"]);
});
test("E2E-409 private movement selection rejects foreign scope before authority or native reads", async () => {
  const f = await classPassMoveFixture(), claims = f.claims, selections = f.authorityQueries.length;
  assert.equal(await f.passes.select({ ...f.request, scope: { ...f.scope, locationId: "foreign" } }, "proposal", f.lifetime.signal), undefined);
  assert.equal(f.claims, claims); assert.equal(f.authorityQueries.length, selections);
});
test("E2E-409 pass authority withdrawn during final destination observation cannot confirm a native move", async () => {
  const f = await classPassMoveFixture({ differentService: true });
  f.onRead(path => { if (path === "/v1/group_appointments/94" && f.writes.some(w => w.leg === "association")) f.denyPass(); });
  assert.equal(resultValue(await f.run()).kind, "needsReview"); assert.equal(f.writes.length, 3);
});
test("E2E-409 compact tuples reject truncation, extra slots and header substitution without changing the note-size bound", async () => {
  const f = await classPassMoveFixture(); resultValue(await f.run()); const notes = String(f.recalls[0]!.notes), lines = notes.split("\n");
  for (const alter of [(v: unknown[]) => v.pop(), (v: unknown[]) => v.push("invented"), (v: unknown[]) => (v[9] as unknown[]).push("paid")]) {
    const payload = JSON.parse(inflateRawSync(Buffer.from(lines[2]!.slice(3), "base64url")).toString()); alter(payload);
    const changed = [...lines]; changed[2] = `z1:${deflateRawSync(Buffer.from(JSON.stringify(payload))).toString("base64url")}`;
    assert.equal(decodeClinikoReview(changed.join("\n")).ok, false);
  }
  const entropy = (seed: string, length: number) => Array.from({ length: Math.ceil(length / 64) }, (_, i) => createHash("sha256").update(`${seed}:${i}`).digest("hex")).join("").slice(0, length);
  const parsed = resultValue(decodeClinikoReview(notes)), oversized = { ...parsed.request, policyVersion: entropy("policy", 256), termsVersion: entropy("terms", 256),
    scope: { tenantId: entropy("tenant", 256), clinicId: entropy("clinic", 256), locationId: entropy("location", 256) } };
  assert.ok(oversized.operation.kind === "classMove");
  Object.assign(oversized.operation.pass!.source, { entitlementRef: entropy("source", 128) });
  Object.assign(oversized.operation.pass!.destination, { entitlementRef: entropy("destination", 128) });
  Object.assign(oversized.operation.pass!, { stagingContractVersion: entropy("staging", 128) });
  assert.equal(encodeClinikoReview(parsed.marker, oversized).ok, false, "complete context is rejected rather than truncated when it cannot fit");
});
test("E2E-409 full-width native identifiers and UUID-scoped pass references round-trip losslessly within the unchanged review limit", async () => {
  const f = await classPassMoveFixture({ differentCase: true, differentService: true }); resultValue(await f.run());
  const parsed = resultValue(decodeClinikoReview(f.recalls[0]!.notes)), request = structuredClone(parsed.request); assert.ok(request.operation.kind === "classMove");
  Object.assign(request, { scope: { tenantId: randomUUID(), clinicId: randomUUID(), locationId: randomUUID() }, patientId: "8112223334445556668", businessId: "8112223334445556669",
    policyVersion: `policy:${randomUUID()}`, termsVersion: `class-move:${createHash("sha256").update(randomUUID()).digest("hex")}` });
  for (const [index, field] of ["practitionerId", "appointmentTypeId", "sessionId", "attendeeId", "newSessionId", "newPractitionerId", "newAppointmentTypeId"].entries())
    Object.assign(request.operation, { [field]: `822333444555666777${index}` });
  for (const [index, side] of (["source", "destination"] as const).entries()) Object.assign(request.operation.pass![side], {
    patientCaseId: `833444555666777888${index}`, entitlementRef: `entitlement:${randomUUID()}`, usageFingerprint: createHash("sha256").update(randomUUID()).digest("hex") });
  Object.assign(request.operation.pass!, { stagingContractVersion: `pass-recovery:${randomUUID()}` });
  const encoded = resultValue(encodeClinikoReview(parsed.marker, request)); assert.ok(encoded.split("\n").slice(1).join("\n").length <= 1000);
  assert.deepEqual(resultValue(decodeClinikoReview(encoded)), { marker: parsed.marker, request });
});
test("E2E-409 compressed review rejects oversized inflation, corrupt data, invalid UTF-8 and noncanonical base64 without exposing a partial record", async () => {
  const f = await classPassMoveFixture(); resultValue(await f.run()); const lines = String(f.recalls[0]!.notes).split("\n");
  const payloads = ["z1:bad!payload", "z1:AAAA", `${lines[2]}=`,
    `z1:${deflateRawSync(Buffer.alloc(8193, "x")).toString("base64url")}`, `z1:${deflateRawSync(Buffer.from([0xff, 0xff])).toString("base64url")}`];
  for (const payload of payloads) { const changed = [...lines]; changed[2] = payload; assert.equal(decodeClinikoReview(changed.join("\n")).ok, false); }
  const parsed = resultValue(decodeClinikoReview(lines.join("\n"))), escaped = "\ud800".repeat(256);
  const oversizedInflation = { ...parsed.request, policyVersion: escaped, termsVersion: escaped, scope: { tenantId: escaped, clinicId: escaped, locationId: escaped } };
  assert.equal(encodeClinikoReview(parsed.marker, oversizedInflation).ok, false, "encoding cannot accept context that its bounded decoder would reject");
});
