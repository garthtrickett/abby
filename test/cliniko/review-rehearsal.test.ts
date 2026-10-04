import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ClinikoReviewRehearsal, reviewRehearsalType } from "../../phase-0/probes/cliniko_review_rehearsal.ts";

const key = "synthetic-rehearsal-secret-au5", base = "https://api.au5.cliniko.com/v1";
const config = { apiKey: key, contactEmail: "owner@example.test", clock: () => new Date("2026-10-04T04:00:00Z") };
type Row = Record<string, unknown>;
function provider() {
  const tables: Record<string, Row[]> = { recall_types: [], patients: [], recalls: [], individual_appointments: [],
    businesses: [{ id: "11", archived_at: null, time_zone_identifier: "Australia/Sydney" }],
    practitioners: [{ id: "22", archived_at: null }], appointment_types: [{ id: "33", archived_at: null }] };
  const calls: { method: string; path: string }[] = [];
  let counter = 90, fault: ((method: string, url: URL, body: Row | undefined) => Response | undefined) | undefined;
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    const path = url.pathname.replace("/v1", ""), [resource, rowId, action] = path.slice(1).split("/");
    calls.push({ method, path });
    assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    const body = init?.body ? JSON.parse(String(init.body)) as Row : undefined;
    const failed = fault?.(method, url, body); if (failed) return failed;
    const table = tables[resource!]; assert.ok(table, "no appointment mutation route exists in this fixture");
    if (method === "POST") {
      if (action === "archive") {
        const row = table.find(item => item.id === rowId)!; row.archived_at = "2026-10-04T05:00:00Z";
        return new Response(null, { status: 204 });
      }
      assert.ok(["recall_types", "patients", "recalls"].includes(resource!)); assert.ok(body);
      const row: Row = { ...body, id: String(++counter), archived_at: null };
      if (resource === "recalls") {
        row.patient = { links: { self: `${base}/patients/${body.patient_id}` } };
        row.recall_type = { links: { self: `${base}/recall_types/${body.recall_type_id}` } };
      }
      table.push(row); return Response.json(row, { status: 201 });
    }
    assert.equal(method, "GET", "API never marks a request recalled on staff's behalf");
    if (rowId) return Response.json(table.find(row => row.id === rowId));
    let rows = table.filter(row => row.archived_at === null);
    const filter = url.searchParams.get("q[]");
    if (filter?.startsWith("patient_id:=")) rows = rows.filter(row => row.patient_id === filter.slice(12));
    return Response.json({ [resource!]: rows, total_entries: rows.length });
  };
  return { tables, calls, fetchPort, setFault(value: typeof fault) { fault = value; } };
}

test("E2E-271 prepare, fresh owner status, staff marker observation and independently verified cleanup", async () => {
  const fake = provider();
  const created = await new ClinikoReviewRehearsal(config, fake.fetchPort).run("prepare"); assert.ok(created.ok);
  assert.deepEqual(created.value, { kind: "clinikoReviewRehearsal", types: 1, patients: 1, pending: 1,
    providerMarkedRecalled: 0, invalid: 0, ambiguous: 0, clinicalWrites: 0 });
  assert.equal(fake.tables.recalls![0]!.recalled, false);
  const posts = fake.calls.filter(call => call.method === "POST").length;
  assert.deepEqual(await new ClinikoReviewRehearsal(config, fake.fetchPort).run("status"), created);
  assert.deepEqual(await new ClinikoReviewRehearsal(config, fake.fetchPort).run("prepare"), created);
  assert.equal(fake.calls.filter(call => call.method === "POST").length, posts);
  fake.tables.recalls![0]!.recalled = true; // Simulated outside staff action, never performed by the probe.
  const reviewed = await new ClinikoReviewRehearsal(config, fake.fetchPort).run("status"); assert.ok(reviewed.ok);
  assert.equal(reviewed.value.providerMarkedRecalled, 1); assert.equal(reviewed.value.pending, 0);
  const clean = await new ClinikoReviewRehearsal(config, fake.fetchPort).run("cleanup"); assert.ok(clean.ok);
  assert.equal(clean.value.types + clean.value.patients + clean.value.pending + clean.value.providerMarkedRecalled, 0);
  assert.deepEqual(fake.calls.filter(call => call.path.endsWith("archive")).map(call => call.path.split("/")[1]),
    ["recalls", "patients", "recall_types"]);
  const output = JSON.stringify([created, reviewed, clean]);
  for (const privateValue of [key, config.contactEmail, String(fake.tables.patients![0]!.old_reference_id), String(fake.tables.recalls![0]!.notes)]) {
    assert.ok(!output.includes(privateValue));
  }
});

test("E2E-271 unknown creation responses stop setup without retry or appointment dispatch", async () => {
  for (const failingResource of ["recall_types", "patients", "recalls"]) {
    const fake = provider();
    fake.setFault((method, url) => method === "POST" && url.pathname.endsWith(`/${failingResource}`)
      ? new Response("private provider detail", { status: 503 }) : undefined);
    const result = await new ClinikoReviewRehearsal(config, fake.fetchPort).run("prepare");
    assert.deepEqual(result, { ok: false, error: { kind: "uncertainSetup" } });
    assert.equal(fake.calls.filter(call => call.method === "POST" && call.path === `/${failingResource}`).length, 1);
    assert.equal(fake.calls.filter(call => call.path.includes("appointments") && call.method !== "GET").length, 0);
  }
});

test("E2E-271 ambiguous, edited or foreign review work blocks cleanup and repeat setup", async () => {
  for (const edit of ["duplicatePatient", "editedEnvelope", "foreignRecall", "appointment", "contact", "wrongType"]) {
    const fake = provider(); assert.ok((await new ClinikoReviewRehearsal(config, fake.fetchPort).run("prepare")).ok);
    switch (edit) {
      case "duplicatePatient": fake.tables.patients!.push({ ...fake.tables.patients![0], id: "100" }); break;
      case "editedEnvelope": fake.tables.recalls![0]!.notes = "private edited staff notes"; break;
      case "foreignRecall": fake.tables.recalls!.push({ ...fake.tables.recalls![0], id: "100", recall_type: { links: { self: `${base}/recall_types/1` } } }); break;
      case "appointment": fake.tables.individual_appointments!.push({ id: "100", patient_id: fake.tables.patients![0]!.id, archived_at: null }); break;
      case "contact": fake.tables.patients![0]!.email = "person@example.test"; break;
      case "wrongType": fake.tables.recall_types![0]!.default_duration = 2; break;
    }
    const posts = fake.calls.filter(call => call.method === "POST").length;
    const result = await new ClinikoReviewRehearsal(config, fake.fetchPort).run("cleanup"); assert.equal(result.ok, false);
    assert.equal(fake.calls.filter(call => call.method === "POST").length, posts);
    await new ClinikoReviewRehearsal(config, fake.fetchPort).run("prepare");
    assert.equal(fake.calls.filter(call => call.method === "POST").length, posts);
  }
});

test("E2E-271 incomplete scans and unverified archives cannot continue mutation", async () => {
  const fake = provider();
  fake.setFault((_method, url) => url.pathname.endsWith("/patients") ? Response.json({ patients: [], total_entries: 501 }) : undefined);
  assert.deepEqual(await new ClinikoReviewRehearsal(config, fake.fetchPort).run("prepare"), { ok: false, error: { kind: "unavailable" } });
  assert.equal(fake.calls.filter(call => call.method === "POST").length, 0);
  fake.setFault(undefined); assert.ok((await new ClinikoReviewRehearsal(config, fake.fetchPort).run("prepare")).ok);
  fake.setFault((method, url) => method === "POST" && /\/recalls\/\d+\/archive$/.test(url.pathname) ? new Response(null, { status: 503 }) : undefined);
  assert.deepEqual(await new ClinikoReviewRehearsal(config, fake.fetchPort).run("cleanup"), { ok: false, error: { kind: "unsafeCleanup" } });
  assert.equal(fake.calls.filter(call => call.path.endsWith("archive")).length, 1);
  assert.equal(fake.tables.patients![0]!.archived_at, null); assert.equal(fake.tables.recall_types![0]!.archived_at, null);
});

test("E2E-271 CLI denies absent opt-in without exposing credential values", () => {
  const child = spawnSync(process.execPath, ["scripts/rehearse-cliniko-review.ts", "prepare"],
    { encoding: "utf8", env: { ...process.env, ABBY_LIVE_CLINIKO_EVAL: "0", ABBY_CLINIKO_API_KEY: key } });
  assert.equal(child.status, 1); assert.equal(child.stdout, "");
  assert.equal(child.stderr, "Cliniko review rehearsal unavailable\n"); assert.ok(!child.stderr.includes(key));
  assert.equal(reviewRehearsalType, "Abby supervised review rehearsal");
});

test("E2E-271 lost patient acknowledgment leaves visible partial setup and never creates a second patient", async () => {
  const fake = provider();
  fake.setFault((method, url, body) => {
    if (method === "POST" && url.pathname.endsWith("/patients")) {
      fake.tables.patients!.push({ ...body, id: "92", archived_at: null });
      throw new Error("synthetic lost response after provider commit");
    }
    return undefined;
  });
  assert.deepEqual(await new ClinikoReviewRehearsal(config, fake.fetchPort).run("prepare"), { ok: false, error: { kind: "uncertainSetup" } });
  fake.setFault(undefined);
  const fresh = await new ClinikoReviewRehearsal(config, fake.fetchPort).run("status"); assert.ok(fresh.ok);
  assert.equal(fresh.value.patients, 1); assert.equal(fresh.value.pending, 0);
  assert.deepEqual(await new ClinikoReviewRehearsal(config, fake.fetchPort).run("prepare"), fresh);
  assert.equal(fake.calls.filter(call => call.method === "POST" && call.path === "/patients").length, 1);
  assert.equal(fake.calls.filter(call => call.method === "POST" && call.path === "/recalls").length, 0);
});

test("E2E-271 fresh archive read detects a revision race or a false archive acknowledgment", async () => {
  for (const mode of ["editedRevision", "falseAcknowledgment"]) {
    const fake = provider(); assert.ok((await new ClinikoReviewRehearsal(config, fake.fetchPort).run("prepare")).ok);
    const recall = fake.tables.recalls![0]!;
    fake.setFault((method, url) => {
      if (mode === "editedRevision" && method === "GET" && url.pathname === `/v1/recalls/${recall.id}`) {
        return Response.json({ ...recall, notes: "outside staff edited request" });
      }
      if (mode === "falseAcknowledgment" && method === "POST" && url.pathname === `/v1/recalls/${recall.id}/archive`) {
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    assert.deepEqual(await new ClinikoReviewRehearsal(config, fake.fetchPort).run("cleanup"), { ok: false, error: { kind: "unsafeCleanup" } });
    assert.equal(fake.calls.filter(call => call.method === "POST" && /^\/(patients|recall_types)\/\d+\/archive$/.test(call.path)).length, 0);
    assert.equal(recall.archived_at, null);
  }
});
