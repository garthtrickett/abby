import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { sql } from "kysely";
import { ClinikoPatientIntakeEdge } from "../../src/cliniko/patient-intake.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import type { EffectCallLeaseStore } from "../../src/core/effect-call-lease.ts";
import type { PolicyStore } from "../../src/core/host.ts";
import { err, ok } from "../../src/core/model.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { TransientIntakeAuthority } from "../../src/standalone/transient-intake-authority.ts";
import type { HostIntakeEvidence } from "../../src/standalone/transient-intake-authority.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { now, scope, draftRef, runEmbeddedIntakeBookingCall as runCall } from "../support/embedded-intake-booking-call.ts";

async function clinicIntakeSettingCalls(ledger: LedgerStore & EffectCallLeaseStore, policy: PolicyStore): Promise<void> {
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  assert.ok((await policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok);
  await runCall("rejected", false, false, undefined, false,
    { ledger, policy, expected: { enabled: false, version: "0", mode: "unavailable" } });
  assert.ok((await policy.changeFirstTimeIntakeEnabled(scope, "0", true, "clinic-admin")).ok);
  await runCall("rejected", false, false, undefined, false, {
    ledger, policy, expected: { enabled: true, version: "1", mode: "execute" }, afterAdmission: async () => {
      assert.ok((await policy.changeFirstTimeIntakeEnabled(scope, "1", false, "clinic-admin")).ok);
    },
  });
  await runCall("rejected", false, false, undefined, false,
    { ledger, policy, expected: { enabled: false, version: "2", mode: "unavailable" } });
  assert.ok((await policy.changeFirstTimeIntakeEnabled(scope, "2", true, "clinic-admin")).ok);
  await runCall("rejected", false, true, undefined, false,
    { ledger, policy, expected: { enabled: true, version: "3", mode: "execute" } });
  await runCall("rejected", true, false, undefined, false,
    { ledger, policy, expected: { enabled: true, version: "3", mode: "execute" } });
  const history = await policy.listFirstTimeIntakeChanges(scope);
  assert.ok(history.ok);
  assert.deepEqual(history.value.entries.map(row => [row.version, row.enabled, row.previousEnabled]),
    [["1", true, false], ["2", false, true], ["3", true, false]]);
}

test("E2E-255 clinic intake setting gates complete voice calls and preserves the admitted call", async () => {
  const ready = async () => ok(true as const);
  await clinicIntakeSettingCalls(new MemoryLedger(ready),
    new MemoryPolicyStore("execute", () => now, ready, { intake: "execute" }));
  const denied = new MemoryPolicyStore("execute", () => now, ready, { intake: "unavailable" });
  assert.ok((await denied.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  assert.ok((await denied.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok);
  assert.ok((await denied.changeFirstTimeIntakeEnabled(scope, "0", true, "clinic-admin")).ok);
  await runCall("rejected", false, false, undefined, false,
    { ledger: new MemoryLedger(ready), policy: denied, expected: { enabled: true, version: "1", mode: "unavailable" } });
});

test("E2E-255 PostgreSQL clinic intake setting gates complete voice calls after durable edits",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
  assert.ok(process.env.DATABASE_URL);
  const admin = connectPostgres(process.env.DATABASE_URL);
  const name = `abby_intake_setting_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(process.env.DATABASE_URL);
  target.pathname = `/${name}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    const ready = async () => ok(true as const);
    const ledger = new PostgresLedger(db, suggested => suggested, ready, "unsafeReference");
    await clinicIntakeSettingCalls(ledger, new PostgresPolicyStore(db, referenceDefaultPolicy,
      "execute", ready, true, "unsafeReference", false, { intake: "execute" }));
    const denied = new PostgresPolicyStore(db, referenceDefaultPolicy,
      "execute", ready, true, "unsafeReference", false, { intake: "unavailable" });
    await runCall("rejected", false, false, undefined, false,
      { ledger, policy: denied, expected: { enabled: true, version: "3", mode: "unavailable" } });
  } finally {
    await db?.destroy();
    if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin);
    await admin.destroy();
  }
});

test("E2E-016 embedded voice retains created patient after rejected booking", () => runCall("rejected"));
test("E2E-073 embedded voice retains created patient after uncertain booking", () => runCall("uncertain"));
test("E2E-016 embedded voice rejects an unapproved intake draft without a write", () => runCall("rejected", true));
test("E2E-016 embedded voice rejects incomplete host consent evidence without a write", () => runCall("rejected", false, true));

test("E2E-016 a TCP reset after patient creation never claims saved details or replays the POST", async () => {
  let posts = 0;
  let created = false;
  const server = createServer(async (request, response) => {
    assert.equal(request.url?.split("?")[0], "/v1/patients");
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ total_entries: 0, patients: [] }));
      return;
    }
    assert.equal(request.method, "POST");
    posts += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    assert.equal(body.first_name, "Synthetic");
    assert.equal(body.last_name, "Caller");
    created = true;
    response.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const providerFetch: typeof fetch = (input, init) => {
    const original = new URL(String(input));
    assert.equal(original.origin, "https://api.au5.cliniko.com");
    return fetch(`http://127.0.0.1:${address.port}${original.pathname}${original.search}`, init);
  };
  try {
    await runCall("rejected", false, false, async () => {
      const callId = callIdFor({ accountRef: "buyer-provider", providerCallRef: "intake-rejected" });
      const sessionId = "session-rejected";
      const refs = { draftRef, consentRef: "consent:local-reset", authorityRef: "authority:local-reset" };
      const evidence: HostIntakeEvidence = { scope, callId, sessionId, policyVersion: "1", ...refs,
        draft: { firstName: "Synthetic", lastName: "Caller", email: "synthetic-caller@example.test",
          dateOfBirth: "1990-05-21", patientPhone: "+61455500000", phoneType: "Mobile" },
        caller: "patient", privacyAccepted: true, proxyAuthorized: false,
        expiresAt: "2026-09-29T10:05:00.000Z" };
      const authority = new TransientIntakeAuthority({ scope, callId, sessionId, policyVersion: "1",
        clock: () => now, source: { async resolve(query) {
          return query.callId === callId && query.sessionId === sessionId &&
            query.draftRef === draftRef && query.consentRef === refs.consentRef &&
            query.authorityRef === refs.authorityRef ? ok(evidence) : err({ kind: "denied" as const });
        } } });
      try {
        const prepared = await authority.prepare(refs.draftRef, refs.consentRef, refs.authorityRef);
        assert.ok(prepared.ok);
        const edge = ClinikoPatientIntakeEdge.create({ scope, countryCallingCode: "61", apiKey: "synthetic-key-au5",
          contactEmail: "dev@example.test" }, authority, providerFetch, () => now);
        assert.ok(edge.ok);
        const first = await edge.value.createOnce(prepared.value);
        assert.deepEqual(first, ok({ kind: "uncertain" }));
        assert.deepEqual(await edge.value.createOnce(prepared.value), err({ kind: "invalidQuery" }));
        return undefined;
      } finally { authority.dispose(); }
    }, true);
    assert.equal(created, true, "the provider committed before dropping its response");
    assert.equal(posts, 1, "uncertain intake cannot send a second patient POST");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
