import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { appointmentNoticeTerms, validNoticeRanges } from "../../src/standalone/appointment-notice-policy.ts";
import type { AppointmentNoticeRange } from "../../src/standalone/appointment-notice-policy.ts";
import { OwnerFileCancellationPolicy } from "../../src/standalone/owner-file-cancellation-policy.ts";
import { OwnerFileReschedulingPolicy } from "../../src/standalone/owner-file-rescheduling-policy.ts";
import { concreteCancellationFixture } from "../support/cancellation-authority.ts";
import { cancellationNow } from "../support/standalone-cancellation.ts";
import { reschedulingAuthorityFixture } from "../support/rescheduling-authority.ts";
import { verificationNow } from "../support/caller-verification.ts";

const ranges: readonly AppointmentNoticeRange[] = [
  { withinHours: 48, handling: "automatic", terms: { version: "under48", approvedText: "Clinic's under-48-hour terms." } },
  { withinHours: 3, handling: "staffReview", terms: { version: "under3", approvedText: "Please contact the clinic for this change." } },
  { withinHours: 24, handling: "automatic", terms: { version: "under24", approvedText: "Clinic's under-24-hour terms." } },
];

test("clinic notice windows select the narrowest range with strict boundaries for both policy owners", async () => {
  const f = await concreteCancellationFixture({ noticeRanges: ranges });
  try {
    for (const owner of [OwnerFileCancellationPolicy, OwnerFileReschedulingPolicy]) {
      const at = (hours: number) => owner.termsFor(f.record, new Date(Date.parse(cancellationNow) + hours * 3_600_000).toISOString(), cancellationNow);
      assert.equal(at(49)?.version, "standard-1");
      assert.equal(at(48)?.version, "standard-1");
      assert.equal(at(47)?.version, "under48");
      assert.equal(at(24)?.version, "under48");
      assert.equal(at(23)?.version, "under24");
      assert.equal(at(3)?.version, "under24");
      assert.equal(at(2), undefined);
      assert.equal(at(0), undefined);
    }
    assert.equal(f.record.noticeRanges?.[0]?.withinHours, 48, "selection must not sort or mutate source");
  } finally { await f.close(); }
});

test("clinic notice schema refuses ambiguous ranges, private fields and improvised waivers", () => {
  assert.equal(validNoticeRanges(ranges, "standard", 500), true);
  const first = ranges[0]!;
  for (const value of [[], null, [first, first], [...ranges, first], [{ ...first, withinHours: 0 }],
    [{ ...first, withinHours: 169 }], [{ ...first, withinHours: 1.5 }], [{ ...first, handling: "waive" }],
    [{ ...first, patientId: "42" }], [{ ...first, terms: { ...first.terms, reason: "unwell" } }],
    [{ ...first, terms: { ...first.terms, approvedText: "bad\nline" } }],
    [{ ...first, terms: { ...first.terms, approvedText: "x".repeat(501) } }],
    [{ ...first, terms: { ...first.terms, version: "standard" } }],
    [first, { ...ranges[1], terms: first.terms }]]) assert.equal(validNoticeRanges(value, "standard", 500), false);
});

test("individual cancellation authority enforces staff-only windows before producing a proposal or mutation", async () => {
  const f = await concreteCancellationFixture({ noticeRanges: ranges, startsAt: "2026-10-04T06:00:00.000Z" });
  try {
    const proof = await f.verify(), selected = await f.select(proof);
    assert.equal((await f.source.resolve(f.query(proof, selected))).ok, false);
    assert.equal((await f.propose(proof, selected)).ok, false);
    assert.equal(Object.keys((await f.state()).actions).length, 0);
    assert.equal(f.recalls.length, 0);
    assert.equal(f.patches, 0);
    assert.equal(f.traffic.some(line => line.includes("POST /v1/recalls")), false);
  } finally { await f.close(); }
});

test("individual cancellation authority presents the same range terms used by class cancellation", async () => {
  const callRange = { withinHours: 168, handling: "automatic" as const, terms: { version: "call-window-1", approvedText: "The clinic's approved change terms apply." } };
  const f = await concreteCancellationFixture({ noticeRanges: [callRange] });
  try {
    const proof = await f.verify(), selected = await f.select(proof), result = await f.source.resolve(f.query(proof, selected));
    assert.ok(result.ok);
    assert.deepEqual(result.value.terms, OwnerFileCancellationPolicy.termsFor(f.record, "2026-10-08T04:00:00.000Z", cancellationNow));
    assert.equal(result.value.terms.version, "call-window-1");
    assert.equal((await f.propose(proof, selected)).ok, true);
    const action = Object.values((await f.state()).actions)[0]!;
    assert.equal(action.mutation.request.kind, "cancel");
    if (action.mutation.request.kind === "cancel") assert.equal(action.mutation.request.terms.approvedText, callRange.terms.approvedText);
    const presentation = (await f.state()).presentations[action.presentationId]!;
    assert.equal(presentation.kind, "speech");
    if (presentation.kind === "speech") assert.ok(presentation.approvedText.includes(callRange.terms.approvedText));
    assert.equal(f.patches, 0);
    await f.confirm(); await f.drain();
    assert.equal(f.patches, 1); assert.equal(f.recalls.length, 1);
    assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  } finally { await f.close(); }
});

test("range policy remains current-file bound and malformed optional ranges cannot be captured", async () => {
  const f = await concreteCancellationFixture({ noticeRanges: ranges });
  try {
    const config = { path: f.path, ...f.feePolicy.binding(), directory: f.directory, clock: () => cancellationNow };
    for (const value of [[], null, [{ ...ranges[0], handling: "waive" }]]) {
      await writeFile(f.path, JSON.stringify({ ...f.record, noticeRanges: value }));
      assert.equal((await OwnerFileCancellationPolicy.capture(config)).ok, false);
    }
    await writeFile(f.path, JSON.stringify(f.record));
    assert.equal((await f.feePolicy.current(f.scope)).ok, true);
    await f.replacePolicy({ noticeRanges: [{ ...ranges[0]!, handling: "staffReview" }] });
    assert.equal((await f.feePolicy.current(f.scope)).ok, false);
  } finally { await f.close(); }
});

test("rescheduling captures only valid optional windows and retains current-file membership checks", async () => {
  const f = await reschedulingAuthorityFixture();
  try {
    const config = { ...f.feePolicy.binding(), path: f.path, directory: f.directory, clock: () => verificationNow };
    for (const value of [[], null, [{ ...ranges[0], handling: "waive" }], [{ ...ranges[0], terms: { version: "x", approvedText: "x".repeat(501) } }]]) {
      await writeFile(f.path, JSON.stringify({ ...f.approval, noticeRanges: value }));
      assert.equal((await OwnerFileReschedulingPolicy.capture(config)).ok, false);
    }
    await writeFile(f.path, JSON.stringify({ ...f.approval, noticeRanges: ranges }));
    const captured = await OwnerFileReschedulingPolicy.capture(config);
    assert.ok(captured.ok);
    assert.equal((await captured.value.current(f.scope)).ok, true);
    await f.replacePolicy({ enabled: false });
    assert.equal((await captured.value.current(f.scope)).ok, false);
  } finally { await f.close(); }
});

test("notice policies preserve legacy terms and reject naive or normalized invalid dates", async () => {
  const f = await concreteCancellationFixture();
  try {
    assert.equal(appointmentNoticeTerms(f.record, "2026-10-05T03:59:59.999Z", cancellationNow)?.version, "late-1");
    assert.equal(appointmentNoticeTerms(f.record, "2026-10-05T04:00:00.000Z", cancellationNow)?.version, "standard-1");
    for (const start of ["2026-10-05T04:00:00", "2026-10-05T04:00:00Z", "2026-02-30T04:00:00.000Z"])
      assert.equal(OwnerFileCancellationPolicy.termsFor(f.record, start, cancellationNow), undefined);
  } finally { await f.close(); }
});
