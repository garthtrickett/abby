import assert from "node:assert/strict";
import test, { after } from "node:test";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { createReferenceStandaloneTextComposition } from "../support/reference-standalone-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresKnowledgeCatalogue } from "../../src/storage/postgres-knowledge-catalogue.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("PostgreSQL knowledge approval is scoped, durable, and compare-and-swap protected", async () => {
  const scope = { tenantId: "knowledge-tenant", clinicId: "knowledge-clinic", locationId: "knowledge-location" };
  const other = { ...scope, locationId: "other-location" };
  const host = new ReferenceClinicHost([], []);
  const composition = createReferenceStandaloneTextComposition(db, host, "requestOnly");
  const catalogue = composition.knowledge as PostgresKnowledgeCatalogue;
  const admin = new CommandGateway({ actorRef: "knowledge-admin", role: "clinicAdmin", scope },
    composition.policy, composition.reception, undefined, undefined, undefined, undefined, catalogue);
  const staff = new CommandGateway({ actorRef: "knowledge-staff", role: "staff", scope },
    composition.policy, composition.reception, undefined, undefined, undefined, undefined, catalogue);
  const sourceRef = "parking";
  const draft = { kind: "knowledge.draft.save.v1" as const, sourceRef, expectedVersion: "0", ownerRef: "clinic-manager",
    text: "Parking is behind the clinic.", effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2026-10-01T00:00:00.000Z" };
  const [first, competing] = await Promise.all([admin.submit(draft), admin.submit({ ...draft, text: "Wrong competing text" })]);
  assert.equal([first, competing].filter(result => result.ok).length, 1);
  assert.equal([first, competing].filter(result => !result.ok && result.error.kind === "versionConflict").length, 1);
  const unpublished = await catalogue.readKnowledge(scope, [sourceRef]);
  assert.ok(unpublished.ok);
  assert.deepEqual(unpublished.value, []);
  const approve = await admin.submit({ kind: "knowledge.approve.v1", sourceRef, expectedVersion: "1" });
  assert.ok(approve.ok);
  const restarted = new PostgresKnowledgeCatalogue(db);
  const approved = await restarted.readKnowledge(scope, [sourceRef]);
  assert.ok(approved.ok);
  assert.equal(approved.value[0]?.approvedText, first.ok ? draft.text : "Wrong competing text");
  const at = "2026-09-28T10:00:00.000Z";
  const started = await composition.reception.startCall("knowledge-pg-call", scope, at);
  assert.ok(started.ok);
  const reloadedCall = await new PostgresLedger(db).read("knowledge-pg-call", scope);
  assert.ok(reloadedCall.ok);
  assert.deepEqual(reloadedCall.value.policy.knowledgeSnapshot, [{ sourceRef, version: "2" }]);
  const spoken = await composition.reception.answer(scope,
    { callId: "knowledge-pg-call", turnId: "approved-answer", text: "Where can I park?", quality: "clear", at },
    [sourceRef], approved.value[0]!.approvedText, at);
  assert.ok(spoken.ok);
  assert.equal(spoken.value.callerMessages.at(-1), approved.value[0]!.approvedText);
  assert.deepEqual(spoken.value.policy.knowledgeSnapshot, [{ sourceRef, version: "2" }]);
  const editDraft = await admin.submit({ ...draft, expectedVersion: "2", text: "Parking is across the road." });
  assert.ok(editDraft.ok);
  const stillOld = await composition.reception.answer(scope,
    { callId: "knowledge-pg-call", turnId: "draft-answer", text: "Where can I park?", quality: "clear", at },
    [sourceRef], approved.value[0]!.approvedText, at);
  assert.ok(stillOld.ok);
  assert.equal(stillOld.value.knowledgeAnswers.at(-1)?.version, "2");
  assert.ok((await admin.submit({ kind: "knowledge.approve.v1", sourceRef, expectedVersion: "3" })).ok);
  const editedOldCall = await composition.reception.answer(scope,
    { callId: "knowledge-pg-call", turnId: "edited-old-call", text: "Where can I park?", quality: "clear", at },
    [sourceRef], "Parking is across the road.", at);
  assert.ok(editedOldCall.ok);
  assert.equal(editedOldCall.value.callerMessages.at(-1), "I can't verify that information right now.");
  assert.ok((await composition.reception.startCall("knowledge-pg-next-call", scope, at)).ok);
  const editedNewCall = await composition.reception.answer(scope,
    { callId: "knowledge-pg-next-call", turnId: "edited-new-call", text: "Where can I park?", quality: "clear", at },
    [sourceRef], "Parking is across the road.", at);
  assert.ok(editedNewCall.ok);
  assert.equal(editedNewCall.value.knowledgeAnswers.at(-1)?.version, "4");
  const foreign = await restarted.readKnowledge(other, [sourceRef]);
  assert.ok(foreign.ok);
  assert.deepEqual(foreign.value, []);
  const listed = await admin.submit({ kind: "knowledge.list.v1" });
  assert.ok(listed.ok && listed.value.kind === "knowledgeList");
  assert.deepEqual(listed.value.entries.map(entry => entry.status), ["draft", "approved", "draft", "approved"]);
  const forbidden = await staff.submit({ kind: "knowledge.revoke.v1", sourceRef, expectedVersion: "4" });
  assert.ok(!forbidden.ok && forbidden.error.kind === "forbidden");
  const revoked = await admin.submit({ kind: "knowledge.revoke.v1", sourceRef, expectedVersion: "4" });
  assert.ok(revoked.ok);
  const later = await admin.submit({ ...draft, expectedVersion: "5", text: "New parking text" });
  assert.ok(later.ok);
  const stillRevoked = await restarted.readKnowledge(scope, [sourceRef]);
  assert.ok(stillRevoked.ok);
  assert.deepEqual(stillRevoked.value, []);
  const blocked = await composition.reception.answer(scope,
    { callId: "knowledge-pg-next-call", turnId: "revoked-answer", text: "Where can I park?", quality: "clear", at },
    [sourceRef], "Parking is across the road.", at);
  assert.ok(blocked.ok);
  assert.equal(blocked.value.callerMessages.at(-1), "I can't verify that information right now.");
});
