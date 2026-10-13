import assert from "node:assert/strict";
import test from "node:test";
import { previousPractitionerFixture } from "../support/previous-practitioner.ts";
import { verificationNow } from "../support/caller-verification.ts";

test("E2E-351 history approval is distinct from upcoming read and cannot issue authority when absent or revoked", async () => {
  const f = await previousPractitionerFixture();
  try {
    await f.replaceHistory({ approved: false });
    const query = { scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.flowConfig.policyVersion,
      turnId: "history", now: verificationNow, expectedConversationRevision: (await f.state()).conversationRevision, signal: new AbortController().signal };
    assert.equal((await f.flow.readPreviousPractitioner(query)).ok, false);
    assert.equal(f.historyReads, 0); assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

async function verifiedRead(f: Awaited<ReturnType<typeof previousPractitionerFixture>>) {
  const query = { scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.flowConfig.policyVersion,
    turnId: "history-start", now: verificationNow, expectedConversationRevision: (await f.state()).conversationRevision, signal: new AbortController().signal };
  assert.equal((await f.flow.readPreviousPractitioner(query)).ok, true);
  const deadline = Date.now() + 5000;
  while (!f.mail.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.mail.length, 1); assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
  return f.flow.readPreviousPractitioner({ ...query, turnId: "history-result" });
}

test("E2E-351 tied latest records across pages cannot choose a practitioner from a partial page", async () => {
  const f = await previousPractitionerFixture();
  try {
    f.setRows([...Array.from({ length: 100 }, (_, index) => f.row(String(1000 + index))), f.row("2000", "24"),
      f.row("2001", "22", "2026-09-20T04:00:00.000Z")]);
    const result = await verifiedRead(f);
    assert.equal(result.ok && result.value.kind === "history" && result.value.snapshot.result.kind, "ambiguous");
    assert.equal(f.historyReads, 2); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test("E2E-351 a large ordered history can resolve its latest complete timestamp without reading all older records", async () => {
  const f = await previousPractitionerFixture();
  try {
    f.setRows(Array.from({ length: 800 }, (_, index) => f.row(String(1000 + index), index === 0 ? "23" : "22",
      new Date(Date.parse("2026-10-01T04:00:00.000Z") - index * 86400000).toISOString())));
    const result = await verifiedRead(f);
    assert.equal(result.ok && result.value.kind === "history" && result.value.snapshot.result.kind === "found" && result.value.snapshot.result.practitionerName, "Demo B");
    assert.equal(f.historyReads, 1); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test("E2E-351 impossible provider calendar dates cannot name a previous practitioner", async () => {
  const f = await previousPractitionerFixture();
  try {
    f.setRows([{ ...f.row("71"), starts_at: "2026-02-30T04:00:00.000Z", ends_at: "2026-03-02T05:00:00.000Z" }]);
    assert.equal((await verifiedRead(f)).ok, false);
  } finally { await f.close(); }
});
