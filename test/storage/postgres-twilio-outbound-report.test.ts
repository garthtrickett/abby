import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { twilioOutboundReportValue } from "../support/twilio-outbound-report.ts";
import { value } from "../support/outbound-records.ts";
import type { TwilioOutboundReportQuery } from "../../src/cliniko/twilio-outbound-report-records.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { approvedSyntheticPolicy } from "../support/approved-voice.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL), peer = connectPostgres(process.env.DATABASE_URL);
const publicScope = { tenantId: `report-public-profile-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
const publicPolicy = approvedSyntheticPolicy({ ...referenceDefaultPolicy(publicScope), policyVersion: "1" });
assert.equal(publicPolicy.voiceProfile!.configurationHash, "1".repeat(64));
// This legitimate public fixture already exists elsewhere in the shared CI
// cohort. Keep it present during every all-column and unfiltered backup check.
await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
  values (${publicScope.tenantId}, ${publicScope.clinicId}, ${publicScope.locationId}, 1, ${JSON.stringify(publicPolicy)}::jsonb)`.execute(db);
after(async () => { await sql`delete from clinic_settings where tenant_id = ${publicScope.tenantId}`.execute(db);
  await Promise.all([db.destroy(), peer.destroy()]); });
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { ClinikoTwilioOutboundReportRecords, twilioOutboundReportRecordBinding } = await import(new URL("cliniko/twilio-outbound-report-records.js", emitted).href) as typeof import("../../src/cliniko/twilio-outbound-report-records.ts");
const { TwilioOutboundReportAuthentication, encodeTwilioOutboundReport } = await import(new URL("cliniko/twilio-outbound-report.js", emitted).href) as typeof import("../../src/cliniko/twilio-outbound-report.ts");
const { ClinikoTwilioOutboundReportHistory } = await import(new URL("cliniko/twilio-outbound-report-history.js", emitted).href) as typeof import("../../src/cliniko/twilio-outbound-report-history.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");

for (const scenario of ["concurrent", "lostAck", "unstored", "edited", "quota", "grantLoss", "preterminalStop", "noStop"] as const)
  test(`emitted native Twilio report native180 independent SQL and backup privacy: ${scenario}`, { timeout: 30000 }, async () => {
    const apiKey = `synthetic-provider-report-${randomUUID()}-au5`, scope = { tenantId: `report-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
    const patientId = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString();
    const f = twilioOutboundReportValue(scenario !== "noStop", { credentialFingerprint: clinikoCredentialFingerprint(apiKey), scope, patientId,
      Authentication: TwilioOutboundReportAuthentication, key: randomBytes(32) });
    if (scenario === "preterminalStop") f.report = value(f.auth.sign({ ...f.unsigned, terminal: null,
      reportedAt: "2026-11-01T10:01:10.000Z", recordedAt: "2026-11-01T10:01:11.000Z" }));
    const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
    const config = { scope, apiKey, businessId: f.report.businessId, contactEmail: "clinic@example.invalid", outboundProviderReportRecallTypeId: "64",
      providerReportPolicyDigest: "a".repeat(64), clock: () => f.report.recordedAt, rateBudget: budget };
    const owner = twilioOutboundReportRecordBinding(config, f.auth)!, base = "https://api.au5.cliniko.com/v1";
    const rows = new Map<string, Record<string, unknown>>(), queries: TwilioOutboundReportQuery[] = []; let posts = 0, live = true;
    const authenticationBinding = f.auth.authenticationBinding();
    const authority = { allows: async (q: TwilioOutboundReportQuery) => { queries.push(q); return q.authenticationBinding === authenticationBinding; },
      current: (q: Readonly<{ authenticationBinding: string }>) => live && q.authenticationBinding === authenticationBinding, producerAdmitted: async () => true };
    const native: typeof fetch = async (input, init) => {
      const u = new URL(String(input)); assert.equal(u.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`);
      if (init?.method === "POST") {
        posts++; if (scenario === "unstored") throw Error("Synthetic native write never observed");
        const body = JSON.parse(String(init.body)); assert.equal(body.recall_type_id, "64"); assert.equal(body.patient_id, f.report.patientId);
        assert.equal(u.pathname, "/v1/recalls"); assert.equal(body.notes, value(encodeTwilioOutboundReport(f.report)));
        const id = String(800 + posts), row = { id, links: { self: `${base}/recalls/${id}` }, patient: { links: { self: `${base}/patients/${body.patient_id}` } },
          recall_type: { links: { self: `${base}/recall_types/64` } }, notes: body.notes, recall_at: body.recall_at,
          recalled: false, recalled_at: null, archived_at: null, created_at: f.report.recordedAt, updated_at: f.report.recordedAt };
        rows.set(id, row);
        if (scenario === "lostAck") throw Error("Synthetic exact native ACK lost");
        return Response.json(row, { status: 201 });
      }
      assert.equal(init?.method, "GET");
      if (u.pathname === "/v1/recalls") {
        assert.deepEqual(u.searchParams.getAll("q[]"), [`patient_id:=${f.report.patientId}`, "archived_at:*"]);
        const page = Number(u.searchParams.get("page")), all = [...rows.values()].sort((a, b) => Number(a.id) - Number(b.id));
        return Response.json({ recalls: all.slice((page - 1) * 100, page * 100), total_entries: all.length });
      }
      assert.deepEqual(u.searchParams.getAll("q[]"), ["archived_at:*"]);
      return Response.json(rows.get(u.pathname.split("/").at(-1)!) ?? {}, { status: rows.has(u.pathname.split("/").at(-1)!) ? 200 : 404 });
    };
    const make = (connection = db) => value(ClinikoTwilioOutboundReportRecords.create(config, f.auth, authority,
      new PostgresOutboundEffectBarrier(connection, scope, owner), native));
    const retain = (connection = db) => make(connection).retainReportOnce(f.report, f.context, f.report.accountSid, "2026-11-02", new AbortController().signal);
    if (scenario === "quota") for (let n = 0; n < 180; n++) assert.equal(await budget.claim(), null);
    if (scenario === "grantLoss") {
      authority.producerAdmitted = async () => { live = false; return true; };
    }
    const results = scenario === "concurrent" ? await Promise.all([retain(db), retain(peer)]) : [await retain()];
    if (scenario === "quota" || scenario === "grantLoss") { assert.equal(results[0]!.ok, false); assert.equal(posts, 0); }
    else {
      assert.equal(posts, 1);
      if (scenario === "concurrent") assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1);
      if (scenario === "lostAck" || scenario === "unstored") assert.equal(value(results[0]!).kind, "uncertain");
      if (scenario !== "unstored") {
        const row = rows.get("801")!; row.recalled = true; row.recalled_at = f.report.recordedAt; row.archived_at = f.report.recordedAt;
        if (scenario === "edited") row.notes = value(encodeTwilioOutboundReport({ ...f.report, contact: { kind: "completeNoStop" } }));
        const cold = value(ClinikoTwilioOutboundReportHistory.create(config,
          new TwilioOutboundReportAuthentication(f.key, f.auth.binding()), { allowsHistoryRead: async q => q.authenticationBinding === authenticationBinding, allowsRecordRead: authority.allows, current: authority.current }, native));
        const result = await cold.findForOriginal(f.context, f.report.accountSid, new AbortController().signal);
        if (scenario === "edited") assert.equal(result.ok, false);
        else { assert.deepEqual(value(result).record?.record, f.report); assert.equal(value(result).record?.archivedAt, f.report.recordedAt); }
      }
      assert.equal((await retain(peer)).ok, false); assert.equal(posts, 1);
    }
    const effects = (await sql<{ effect_ref: string }>`select effect_ref from outbound_effect_barriers where tenant_id = ${scope.tenantId}`.execute(db)).rows;
    assert.ok(effects.every(e => e.effect_ref === f.context.reportActionRef));
    assert.equal(effects.length, scenario === "grantLoss" ? 0 : 1);
    assert.ok(queries.every(q => q.outboundProviderReportRecallTypeId === "64" && q.ownerBinding === owner));
    const canaries = [apiKey, f.report.number, f.report.callSid, f.report.patientId, f.report.original.digest, f.report.authentication,
      f.report.original.recallRef, value(encodeTwilioOutboundReport(f.report)), f.key.toString("hex")];
    // Keep the scanner's existing256-character/12-canary limits. Cover every
    // byte of a longer native note rather than dropping it from privacy checks.
    const scanCanaries = canaries.flatMap((text, index) => Array.from({ length: Math.ceil(text.length / 256) }, (_, part) => {
      const chunk = text.slice(part * 256, (part + 1) * 256);
      return { label: `provider_report_${index}_${part}`, value: chunk.length < 4 ? text.slice(-4) : chunk };
    }));
    assert.ok(scanCanaries.every(c => c.value.length >= 4 && c.value.length <= 256));
    for (let offset = 0; offset < scanCanaries.length; offset += 12)
      assert.deepEqual(await scanPatientDataCanaries(db, scanCanaries.slice(offset, offset + 12)), { ok: true, value: [] });
    const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
    for (const c of canaries) assert.equal(dump.includes(c), false);
  });

test("a distinct actual private report key remains detectable beside legitimate repeated public profile hashes", { timeout: 30000 }, async t => {
  const f = twilioOutboundReportValue(true, { key: randomBytes(32), Authentication: TwilioOutboundReportAuthentication });
  const key = f.key.toString("hex"), publicHash = publicPolicy.voiceProfile!.configurationHash;
  assert.notEqual(key, publicHash);
  const publicHits = value(await scanPatientDataCanaries(db, [{ label: "public_profile_hash", value: publicHash }]));
  assert.ok(publicHits.some(h => h.table === "clinic_settings" && h.column === "policy"));
  assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "actual_private_key", value: key }]), { ok: true, value: [] });
  const scope = { ...publicScope, tenantId: `report-key-injection-${randomUUID()}` };
  const policy = { ...publicPolicy, scope, voiceProfile: { ...publicPolicy.voiceProfile!, configurationHash: key } };
  const cleanup = () => sql`delete from clinic_settings where tenant_id = ${scope.tenantId}`.execute(db); t.after(cleanup);
  await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
    values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, 1, ${JSON.stringify(policy)}::jsonb)`.execute(db);
  assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "actual_private_key", value: key }]),
    { ok: true, value: [{ label: "actual_private_key", table: "clinic_settings", column: "policy" }] });
  const backup = () => execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  assert.equal(backup().includes(key), true);
  await cleanup();
  assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "actual_private_key", value: key }]), { ok: true, value: [] });
  const clean = backup(); assert.equal(clean.includes(key), false); assert.equal(clean.includes(publicHash), true);
});
