import assert from "node:assert/strict";
import { test } from "node:test";
import { mixedClassTasksFixture } from "../support/mixed-class-tasks.ts";
import type { MixedTaskKind } from "../support/mixed-class-tasks.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

for (const firstKind of ["class", "individual"] as const) {
  const secondKind: MixedTaskKind = firstKind === "class" ? "individual" : "class";
  test(`E2E-381 mixed approved tasks ${firstKind} to ${secondKind} retain independent proof, consent, native writes and receipts`, async () => {
    const f = await mixedClassTasksFixture();
    try {
      await f.start(firstKind); const first = await f.book(); assert.equal(first.status, "committed");
      await f.start(secondKind); assert.equal(f.flow.verificationRequired, true);
      assert.equal(first.mutation.request.kind, "book");
      if (first.mutation.request.kind !== "book") throw new Error("wrong first task");
      assert.equal((await f.flow.resolveBooking(f.scope, first.mutation.request.patient.verificationRef,
        first.mutation.request.offer.offerRef, verificationNow)).ok, false, "the first task's proof and offer cannot authorize the next service");
      assert.equal((await f.flow.publicIntentContext())?.lastAction, null);
      assert.equal(f.writes.length + f.individualWrites.length, 1, "fresh task startup cannot write");
      const second = await f.book(); assert.equal(second.status, "committed");
      assert.notEqual(first.key, second.key); assert.notEqual(first.hostRef, second.hostRef);
      assert.deepEqual((await f.state()).actions[first.key], first);
      assert.deepEqual([f.writes.length, f.individualWrites.length, f.recalls.length, f.individualRecalls.length, f.mail.length], [1, 1, 1, 1, 2]);
      assert.deepEqual(await f.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
      assert.deepEqual(await f.flow.write(first.mutation, verificationNow), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
      assert.deepEqual(await f.flow.reconcile({ ...first.mutation, payloadDigest: "f".repeat(64) }), { kind: "stillUnknown", actionKey: first.key });
      assert.equal((await f.flow.choose("book")).ok, false, "sequence maximum remains enforced");
      for (const secret of [verificationCanaries[0]!, verificationCanaries[1]!, ...f.mail.map(item => item.code)])
        assert.equal(JSON.stringify(await f.state()).includes(secret), false);
    } finally { await f.close(); }
  });

  test(`E2E-381 mixed approved tasks ${firstKind} to ${secondKind} preserve separately checked native pass consumption`, async () => {
    const f = await mixedClassTasksFixture({ passes: true });
    try {
      await f.start(firstKind); const first = await f.book(); assert.equal(first.status, "committed");
      await f.start(secondKind); const second = await f.book(); assert.equal(second.status, "committed");
      assert.equal(f.writes[0]!.patient_case_id, f.pass.caseId);
      assert.equal(Object.hasOwn(f.individualWrites[0]!, "patient_case_id"), false);
      assert.ok(f.pass.queries.length > 0);
      assert.equal(f.pass.rows.filter(row => row.id === "401").length, 1);
      assert.deepEqual((await f.state()).actions[first.key], first);
      for (const secret of [f.pass.caseId, f.pass.entitlementRef]) assert.equal(JSON.stringify(await f.state()).includes(secret), false);
    } finally { await f.close(); }
  });

  test(`E2E-381 mixed tasks ${firstKind} to ${secondKind} require sequence approval even after a settled write`, async () => {
    const f = await mixedClassTasksFixture({ sequence: false });
    try {
      await f.start(firstKind); const first = await f.book(); assert.equal(first.status, "committed");
      assert.equal((await f.flow.choose("book", undefined, false, undefined, undefined, false, secondKind === "class")).ok, false);
      assert.equal(f.mail.length, 1); assert.equal(f.writes.length + f.individualWrites.length, 1);
      assert.deepEqual((await f.state()).actions[first.key], first);
    } finally { await f.close(); }
  });

  test(`E2E-381 mixed tasks ${firstKind} to ${secondKind} cannot replace a task awaiting confirmation`, async () => {
    const f = await mixedClassTasksFixture();
    try {
      await f.start(firstKind); const action = await f.propose();
      assert.equal((await f.flow.choose("book", undefined, false, undefined, undefined, false, secondKind === "class")).ok, false);
      assert.deepEqual((await f.state()).actions[action.key], action);
      assert.equal(f.mail.length, 1); assert.equal(f.writes.length + f.individualWrites.length, 0);
    } finally { await f.close(); }
  });

  test(`E2E-381 mixed tasks ${firstKind} to ${secondKind} keep a possible first write blocked without replay`, async () => {
    const f = await mixedClassTasksFixture();
    try {
      if (firstKind === "class") f.loseWrite(); else f.loseIndividual();
      await f.start(firstKind); const first = await f.book(); assert.ok(["uncertain", "needsReview"].includes(first.status));
      assert.equal((await f.flow.choose("book", undefined, false, undefined, undefined, false, secondKind === "class")).ok, false);
      assert.equal(f.mail.length, 1); assert.equal(f.writes.length + f.individualWrites.length, 1);
      assert.deepEqual((await f.state()).actions[first.key], first);
    } finally { await f.close(); }
  });

  test(`E2E-381 mixed tasks ${firstKind} to ${secondKind} recheck sequence, target service and approving membership`, async () => {
    for (const fault of ["sequence", "target", "membership"] as const) {
      const f = await mixedClassTasksFixture();
      try {
        await f.start(firstKind); const first = await f.book(); assert.equal(first.status, "committed");
        if (fault === "sequence") await f.tasks.replace({ enabled: false });
        if (fault === "membership") await f.replaceAccount({ membershipVersion: "changed" });
        if (fault === "target") {
          if (secondKind === "class") await f.replacePolicy({ enabled: false }); else await f.replaceIndividual({ enabled: false });
        }
        assert.equal((await f.flow.choose("book", undefined, false, undefined, undefined, false, secondKind === "class")).ok, false);
        assert.equal(f.mail.length, 1); assert.equal(f.writes.length + f.individualWrites.length, 1);
        assert.deepEqual((await f.state()).actions[first.key], first);
      } finally { await f.close(); }
    }
  });

  test(`E2E-381 mixed tasks ${firstKind} to ${secondKind} refuse changed caller candidates after the next task starts`, async () => {
    const f = await mixedClassTasksFixture();
    try {
      await f.start(firstKind); const first = await f.book(); assert.equal(first.status, "committed");
      await f.start(secondKind); f.setCandidates({ kind: "one", candidateIds: ["99"] });
      assert.equal((await f.flow.submitCode(f.mail.at(-1)!.code)).verified, false);
      assert.equal(f.writes.length + f.individualWrites.length, 1);
      assert.deepEqual((await f.state()).actions[first.key], first);
    } finally { await f.close(); }
  });

  test(`E2E-381 mixed tasks ${firstKind} to ${secondKind} cannot write after authority is withdrawn following played consent`, async () => {
    for (const fault of ["sequence", "target"] as const) {
      const f = await mixedClassTasksFixture();
      try {
        await f.start(firstKind); const first = await f.book(); assert.equal(first.status, "committed");
        await f.start(secondKind); const second = await f.propose();
        if (fault === "sequence") await f.tasks.replace({ enabled: false });
        else if (secondKind === "class") await f.replacePolicy({ enabled: false }); else await f.replaceIndividual({ enabled: false });
        await f.reception.affirm(f.scope, f.turn("withdrawn-yes", "Yes"), second.key, second.digest, verificationNow);
        resultValue(await f.reception.drain(f.scope, f.callId, verificationNow)); await f.play();
        const state = await f.state();
        assert.ok(["awaitingConfirmation", "rejected", "canceled"].includes(state.actions[second.key]!.status));
        assert.equal(f.writes.length + f.individualWrites.length, 1, "withdrawn authority cannot send the second clinical write");
        assert.deepEqual(state.actions[first.key], first);
      } finally { await f.close(); }
    }
  });
}
