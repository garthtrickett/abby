import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ClinikoPatientUpdateEdge } from "../../src/cliniko/patient-update.ts";
import type { PatientUpdateAuthority, PatientUpdateQuery, PatientUpdateRequest } from "../../src/cliniko/patient-update.ts";
import { patientDetailChangesDigest, patientDetailFields, patientDetailsDigest, patientDetailsSnapshot, validPatientDetailChanges } from "../../src/cliniko/patient-details.ts";
import type { PatientDetailChanges } from "../../src/cliniko/patient-details.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const now = "2026-10-13T10:00:00.000Z", base = "https://api.au5.cliniko.com/v1", apiKey = "synthetic-patient-update-au5";
const scope = { tenantId: "update-test", clinicId: "clinic", locationId: "main" };
const query: PatientUpdateQuery = { scope, callId: "call-1", sessionId: "session-1", patientId: "42", policyVersion: "1", verificationRef: "private-proof" };
function fixture() {
  let row = { id: "42", archived_at: null, merged_at: null, updated_at: now, links: { self: `${base}/patients/42` },
    first_name: "Synthetic", last_name: "Patient", date_of_birth: "1980-01-02", email: "old@example.test",
    patient_phone_numbers: [{ number: "+61400111222", phone_type: "Mobile" }],
    address_1: "1 Example Road", address_2: null, address_3: null, city: "Example", state: "VIC", post_code: "3000", country_code: "AU",
    notes: "private-chart-canary", invoice_email: "billing-canary@example.test", accepted_email_marketing: false };
  let permitted = true, prospective = true, confirmed = true, allowed = [...patientDetailFields], mode = "", claims = 0, syncs = 0;
  let onClaim = async () => {}, onRead = async () => {}, onPatch = async () => {}, onSync = async (_request: PatientUpdateRequest) => true;
  const traffic: { method: string; body?: Record<string, unknown> }[] = [];
  const authority: PatientUpdateAuthority = {
    attest: async (incoming, phase) => {
      if (!permitted) return null;
      return { ...query, operation: "patients.update", recordScope: "clinikoAccount", credentialFingerprint: clinikoCredentialFingerprint(apiKey),
        allowedFields: allowed, expiresAt: "2026-10-13T10:04:00.000Z", independentPermission: true, selfAuthorized: true,
        ...(phase !== "read" && "changes" in incoming ? { attemptRef: incoming.attemptRef, consentRef: incoming.consentRef,
          expectedDigest: incoming.expectedDigest, changesDigest: patientDetailChangesDigest(incoming.changes), ...(confirmed ? { confirmationPlayed: true as const } : {}),
          ...(prospective && incoming.prospectiveEmailRef ? { prospectiveEmailRef: incoming.prospectiveEmailRef,
            prospectiveEmailDigest: createHash("sha256").update(JSON.stringify(incoming.changes.email ?? null)).digest("hex") } : {}) } : {}) };
    },
    contactChanged: async request => { syncs++; return onSync(request); },
  };
  const fetchPort: typeof fetch = async (value, init) => {
    assert.equal(String(value), `${base}/patients/42`); assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers); assert.equal(headers.get("Authorization"), `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`);
    assert.equal(headers.get("User-Agent"), "Abby (owner@example.test)");
    assert.ok(init?.signal); assert.equal(init.signal.aborted, false);
    const method = init?.method ?? "GET";
    traffic.push({ method, ...(method === "PATCH" ? { body: JSON.parse(String(init?.body)) } : {}) });
    if (method === "GET") { await onRead(); return Response.json(row); }
    assert.equal(method, "PATCH"); row = { ...row, ...JSON.parse(String(init?.body)), updated_at: "2026-10-13T10:00:01.000Z" };
    await onPatch();
    if (mode === "lost") throw new Error("synthetic lost update response");
    if (mode === "badResponse") return Response.json({ ...row, id: "43" });
    if (mode === "server") return new Response(null, { status: 500 });
    return Response.json(row);
  };
  const edge = resultValue(ClinikoPatientUpdateEdge.create({ scope, apiKey, contactEmail: "owner@example.test",
    rateBudget: { claim: async () => { claims++; await onClaim(); return mode === "budget" ? { kind: "unavailable" } : null; },
      observe429: async () => ({ kind: "rateLimited" }) } }, authority, fetchPort, () => now));
  const snapshot = patientDetailsSnapshot(row, "42", base)!;
  const request = (changes: PatientDetailChanges = { email: "new@example.test", post_code: "3001" }): PatientUpdateRequest => ({ ...query,
    attemptRef: "attempt-1", consentRef: "private-played-correction", expectedDigest: patientDetailsDigest(snapshot), changes,
    ...(Object.hasOwn(changes, "email") ? { prospectiveEmailRef: "private-prospective-email-proof" } : {}) });
  return { edge, traffic, request, snapshot, get row() { return row; }, get syncs() { return syncs; }, get claims() { return claims; },
    permission: (value: boolean) => { permitted = value; }, prospective: (value: boolean) => { prospective = value; }, confirmed: (value: boolean) => { confirmed = value; },
    allowed: (value: typeof allowed) => { allowed = value; }, mode: (value: string) => { mode = value; }, change: (value: Partial<typeof row>) => { row = { ...row, ...value }; },
    onClaim: (value: typeof onClaim) => { onClaim = value; }, onRead: (value: typeof onRead) => { onRead = value; }, onPatch: (value: typeof onPatch) => { onPatch = value; }, onSync: (value: typeof onSync) => { onSync = value; } };
}

test("E2E-361 verified field correction sends one narrow PATCH, retains identity/appointments and synchronizes contact state", async () => {
  const f = fixture();
  try {
    const read = resultValue(await f.edge.readTarget(query));
    assert.equal(JSON.stringify(read).includes("private-chart-canary"), false); assert.equal(JSON.stringify(read).includes("billing-canary"), false);
    const request = f.request();
    assert.deepEqual(resultValue(await f.edge.updateOnce(request)), { kind: "updated", patientId: "42" });
    assert.deepEqual(f.traffic.filter(t => t.method === "PATCH"), [{ method: "PATCH", body: { email: "new@example.test", post_code: "3001" } }]);
    assert.equal(f.row.first_name, "Synthetic"); assert.equal(f.row.notes, "private-chart-canary"); assert.equal(f.row.accepted_email_marketing, false);
    assert.equal(f.syncs, 1); assert.equal(f.claims, f.traffic.length);
    assert.equal((await f.edge.updateOnce({ ...request, attemptRef: "another-attempt" })).ok, false);
    assert.equal(f.traffic.filter(t => t.method === "PATCH").length, 1);
  } finally { f.edge.dispose(); }
});

for (const failure of ["permission", "confirmation", "prospective", "allowedFields", "stale", "merged", "archived", "foreignLink", "budget", "latePermission", "futureBirth", "badPhone"] as const) {
  test(`E2E-361 ${failure} correction cannot send a patient PATCH`, async () => {
    const f = fixture();
    try {
      let request = f.request();
      if (failure === "permission") f.permission(false);
      if (failure === "confirmation") f.confirmed(false);
      if (failure === "prospective") f.prospective(false);
      if (failure === "allowedFields") f.allowed(["post_code"]);
      if (failure === "stale") f.change({ first_name: "Another", updated_at: "2026-10-13T10:00:02.000Z" });
      if (failure === "merged") f.change({ merged_at: now } as never);
      if (failure === "archived") f.change({ archived_at: now } as never);
      if (failure === "foreignLink") f.change({ links: { self: "https://foreign.example.test/patients/42" } });
      if (failure === "budget") f.mode("budget");
      if (failure === "latePermission") f.onClaim(async () => { if (f.claims === 2) f.permission(false); });
      if (failure === "futureBirth") request = f.request({ date_of_birth: "2099-01-02" });
      if (failure === "badPhone") request = f.request({ patient_phone_numbers: [{ number: "not-a-phone", phone_type: "Mobile" }] });
      assert.equal((await f.edge.updateOnce(request)).ok, false); assert.equal(f.traffic.some(t => t.method === "PATCH"), false); assert.equal(f.syncs, 0);
    } finally { f.edge.dispose(); }
  });
}

test("E2E-361 unknown fields, unset values, forged subjects and cross-location corrections are rejected before provider IO", async () => {
  const f = fixture();
  try {
    for (const changes of [{ notes: "overwrite" }, { email: undefined }, { accepted_email_marketing: true }, {}, { first_name: "" }, { date_of_birth: "2026-02-30" }]) {
      assert.equal(validPatientDetailChanges(changes), false);
      assert.equal((await f.edge.updateOnce({ ...f.request(), changes } as never)).ok, false);
    }
    assert.equal((await f.edge.updateOnce({ ...f.request(), scope: { ...scope, locationId: "other" } })).ok, false);
    assert.equal((await f.edge.updateOnce({ ...f.request(), patientId: "43" })).ok, false);
    assert.equal((await f.edge.updateOnce({ ...f.request(), force: true } as never)).ok, false);
    assert.equal(f.traffic.length, 0);
  } finally { f.edge.dispose(); }
});

for (const mode of ["lost", "server", "badResponse", "laterChange"] as const) test(`E2E-361 ${mode} after a possible update retains uncertainty and cannot retry`, async () => {
  const f = fixture();
  try {
    if (mode === "laterChange") f.onPatch(async () => { f.change({ city: "Concurrent edit" }); }); else f.mode(mode);
    assert.deepEqual(resultValue(await f.edge.updateOnce(f.request())), { kind: "uncertain" });
    assert.equal(f.syncs, 0); assert.equal((await f.edge.updateOnce({ ...f.request(), attemptRef: "new-ref" })).ok, false);
    assert.equal(f.traffic.filter(t => t.method === "PATCH").length, 1);
  } finally { f.edge.dispose(); }
});

for (const throws of [false, true]) test(`E2E-361 ${throws ? "throwing" : "failed"} contact synchronization requires review rather than claiming a complete correction`, async () => {
  const f = fixture();
  try {
    f.onSync(async () => { if (throws) throw new Error("synthetic contact synchronization failure"); return false; });
    assert.deepEqual(resultValue(await f.edge.updateOnce(f.request())), { kind: "needsContactReview" });
    assert.equal(f.row.email, "new@example.test"); assert.equal(f.syncs, 1);
    assert.equal(f.traffic.filter(t => t.method === "PATCH").length, 1);
  } finally { f.edge.dispose(); }
});

test("E2E-361 concurrent duplicate calls cannot release another correction's lock or send twice", async () => {
  const f = fixture(); let release = () => {}, entered = () => {};
  const held = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  try {
    f.onRead(async () => { entered(); await waiting; });
    const pending = f.edge.updateOnce(f.request()); await held;
    assert.equal((await f.edge.updateOnce(f.request())).ok, false);
    assert.equal((await f.edge.updateOnce({ ...f.request(), attemptRef: "third-attempt" })).ok, false);
    release(); assert.equal(resultValue(await pending).kind, "updated");
    assert.equal(f.traffic.filter(t => t.method === "PATCH").length, 1);
  } finally { release(); f.edge.dispose(); }
});

test("E2E-361 an unchanged correction observes current authority without writing or revoking contact grants", async () => {
  const f = fixture();
  try {
    assert.deepEqual(resultValue(await f.edge.updateOnce(f.request({ post_code: "3000" }))), { kind: "unchanged", patientId: "42" });
    assert.equal(f.traffic.filter(t => t.method === "PATCH").length, 0); assert.equal(f.syncs, 0);
  } finally { f.edge.dispose(); }
});

for (const phase of ["read", "beforeSend", "afterSend"] as const) test(`E2E-361 abort ${phase} cannot publish late data or retry a possible correction`, async () => {
  const f = fixture(), stop = new AbortController(); let release = () => {}, entered = () => {};
  const held = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  try {
    if (phase === "afterSend") f.onPatch(async () => { entered(); await waiting; });
    else f.onRead(async () => { entered(); await waiting; });
    const pending = phase === "read" ? f.edge.readTarget(query, stop.signal) : f.edge.updateOnce(f.request(), stop.signal);
    await held; stop.abort(); const result = await pending;
    if (phase === "afterSend") { assert.ok(result.ok); assert.deepEqual(result.value, { kind: "uncertain" }); }
    else assert.equal(result.ok, false);
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.syncs, 0); assert.equal(f.traffic.filter(t => t.method === "PATCH").length, phase === "afterSend" ? 1 : 0);
    if (phase === "afterSend") assert.equal((await f.edge.updateOnce({ ...f.request(), attemptRef: "another-ref" })).ok, false);
  } finally { release(); f.edge.dispose(); }
});

test("E2E-361 correction fields are captured before asynchronous authorization and provider reads", async () => {
  const f = fixture(); let release = () => {}, entered = () => {};
  const held = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  try {
    f.onRead(async () => { entered(); await waiting; });
    const request = f.request(), pending = f.edge.updateOnce(request); await held;
    (request.changes as { email: string }).email = "unconfirmed@example.test";
    release(); assert.equal(resultValue(await pending).kind, "updated");
    assert.equal(f.traffic.find(t => t.method === "PATCH")!.body!.email, "new@example.test");
  } finally { release(); f.edge.dispose(); }
});

test("E2E-361 incomplete or malformed versioned snapshots cannot establish a correction baseline", async () => {
  const f = fixture();
  try {
    assert.equal(patientDetailsSnapshot({ ...f.row, email: undefined }, "42", base), undefined);
    assert.equal(patientDetailsSnapshot({ ...f.row, updated_at: "0" }, "42", base), undefined);
    assert.equal(patientDetailsSnapshot({ ...f.row, updated_at: "2026-02-30T10:00:00Z" }, "42", base), undefined);
    assert.equal(patientDetailsSnapshot({ ...f.row, patient_phone_numbers: null }, "42", base), undefined);
  } finally { f.edge.dispose(); }
});

test("E2E-361 contact synchronization cannot mutate the owned correction or retarget its receipt", async () => {
  const f = fixture();
  try {
    f.onSync(async request => { (request as { patientId: string }).patientId = "43"; return true; });
    assert.deepEqual(resultValue(await f.edge.updateOnce(f.request())), { kind: "updated", patientId: "42" });
    assert.equal(f.row.id, "42"); assert.equal(f.traffic.filter(t => t.method === "PATCH").length, 1);
  } finally { f.edge.dispose(); }
});
