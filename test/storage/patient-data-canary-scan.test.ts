import assert from "node:assert/strict";
import test, { after } from "node:test";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { setup } from "../text/fixture.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("database canary scan identifies current patient-data leaks without returning values", async () => {
  assert.equal(process.env.ABBY_LEDGER, "postgres");
  const app = await setup("pg-patient-canary-scan");
  const offerRef = "offer-private-canary-7421";
  const appointmentRef = "appointment-private-canary-8615";
  const callerText = "caller-private-canary-9532";
  await app.turn("offer-turn", callerText, { kind: "requestAction", request: app.book("physio", offerRef) });
  const pending = await app.pendingAction();
  await app.confirm(pending.key);
  await app.turn("cancel-turn", "Please cancel", { kind: "requestAction", request: {
    kind: "cancel", patient: app.patient,
    target: { scope: app.scope, patientRef: app.patient.patientRef, appointmentRef },
  } });

  const scan = await scanPatientDataCanaries(db, [
    { label: "offer", value: offerRef },
    { label: "appointment", value: appointmentRef },
    { label: "caller_text", value: callerText },
  ]);
  assert.equal(scan.ok, true, scan.ok ? "" : scan.error.kind);
  if (!scan.ok) return;
  const locations = new Set(scan.value.map(hit => `${hit.label}:${hit.table}.${hit.column}`));
  assert.equal(locations.has("offer:calls.state"), true);
  assert.equal(locations.has("offer:effect_outbox.payload"), true);
  assert.equal(locations.has("appointment:calls.state"), true);
  assert.equal(locations.has("appointment:staff_items.payload"), true);
  assert.equal(scan.value.some(hit => hit.label === "caller_text"), false);
  assert.equal(JSON.stringify(scan.value).includes(offerRef), false);
  assert.equal(JSON.stringify(scan.value).includes(appointmentRef), false);
});
