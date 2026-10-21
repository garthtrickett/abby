import assert from "node:assert/strict";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { outboundClinicalVoiceFixture } from "./outbound-clinical-voice.ts";
import { subjectMemoFixture } from "./subject-memo.ts";
import { verificationCanaries, verificationNow } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import type { OutboundEffectBarrier } from "../../src/core/outbound-effect-barrier.ts";
import type { LocationScope } from "../../src/core/model.ts";

export type OutboundMemoOperation = "book" | "cancel" | "reschedule";
export type OutboundMemoMode = "accepted" | "wrongSubjectGrant" | "withdrawn" | "lostStored" | "nativeUncertain";

/** Real signed clinical fixture and independent memo grants; remote ports remain synthetic. */
export async function outboundMemoFixture(operation: OutboundMemoOperation, mode: OutboundMemoMode, options: {
  apiKey?: string;
  budget?: ClinikoRequestBudget;
  verificationBudgetFor?: (scope: LocationScope) => NonNullable<ClinikoCallFlowConfig["verificationBudget"]>;
  sessionEffects?: (scope: LocationScope, binding: string) => OutboundEffectBarrier;
  barrierFor?: (scope: LocationScope, binding: string) => OutboundEffectBarrier;
} = {}) {
  let memo: ReturnType<typeof subjectMemoFixture> | undefined;
  const f = await outboundClinicalVoiceFixture({ budget: options.budget ?? new ClinikoReadBudget(180),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}), realElapsedTime: true,
    ...(mode === "nativeUncertain" ? { lostClinicalResponse: true } : {}),
    ...(options.sessionEffects ? { sessionEffects: options.sessionEffects } : {}),
    ...(options.verificationBudgetFor ? { verificationBudgetFor: options.verificationBudgetFor } : {}),
    ...(operation === "book" ? { purpose: "followUp" } : { sickDayAction: operation }),
    memo: ({ scope, cliniko, clock }) => {
      memo = subjectMemoFixture({ scope, ...cliniko, clock, deadlineMs: 5000,
        authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) } }, verificationCanaries[2]!, {
        ...(mode === "wrongSubjectGrant" ? { approvedPatientId: "583746192837465" } : {}),
        ...(mode === "lostStored" ? { lostStored: true } : {}),
        ...(options.barrierFor ? { barrierFor: options.barrierFor } : {})
      });
      return memo.config;
    } });
  const close = async () => { try { await f.close(); } finally { memo?.close(); } };
  assert.ok(memo); const retained = memo;
  return { f, memo: retained, close, async complete() {
    await f.open(); assert.equal(f.mail.length, 0); assert.equal(retained.posts.length, 0); await f.mark();
    await f.say(`I would like to ${operation} an appointment`, { kind: "workflow", operation });
    const code = await f.waitForMail(); assert.equal(f.mail.at(-1)!.email, verificationCanaries[0]);
    await f.mark(); await f.privateCode(code);
    if (operation === "book") {
      await f.say("What times are available", { kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" }); await f.mark();
      await f.say("The first time", { kind: "bookingChoice", choice: 1 });
    } else if (operation === "cancel") {
      const proof = await f.flow.cancellationProof(); assert.ok(proof);
      await f.say("Which appointment can I cancel", { kind: "appointments", verificationRef: proof.verificationRef,
        from: verificationNow, to: "2026-10-09T06:00:00.000Z" }); await f.mark();
      await f.say("Cancel that appointment", { kind: "cancel", verificationRef: proof.verificationRef, targetRef: "selected" });
    } else {
      for (const stage of ["targets", "offers"] as const) {
        await f.say(`Which ${stage}`, { kind: "reschedulingMenu", stage,
          from: stage === "targets" ? verificationNow : "2026-10-08", to: stage === "targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08" });
        await f.mark(); await f.say(`First ${stage}`, { kind: "reschedulingChoice", stage, choice: 1 });
        if (stage === "targets") await f.mark();
      }
    }
    const proposed = Object.values((await f.current()).actions)[0]!;
    assert.equal(proposed.kind, operation); assert.equal(proposed.status, "awaitingConfirmation");
    assert.equal(f.bookings + f.cancellations + f.patches, 0); assert.equal(retained.posts.length, 0);
    await f.mark(); if (mode === "withdrawn") retained.control.permitted = false;
    await f.say("Yes", { kind: "affirm" });
    if (mode !== "nativeUncertain") await retained.memoSettled;
    assert.equal(f.bookings + f.cancellations + f.patches, 1);
    assert.equal(Object.values((await f.current()).actions)[0]!.status, mode === "nativeUncertain" ? "uncertain" : "committed");
    const nativeNotes = operation === "book" ? String(f.bookingRequests[0]!.notes) : String(f.recalls[0]!.notes);
    const source = operation === "book" ? /^Abby booking ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(nativeNotes)?.[1]
      : resultValue(decodeClinikoReview(nativeNotes)).marker;
    assert.ok(source, "actual native source marker is independent of memo retention");
    const denied = mode === "wrongSubjectGrant" || mode === "withdrawn" || mode === "nativeUncertain";
    assert.equal(retained.posts.length, denied ? 0 : 1); assert.equal(retained.rows.length, denied ? 0 : 1);
    if (mode === "nativeUncertain") assert.ok(retained.outcomes.every(outcome => outcome.kind === "unavailable"));
    else assert.equal(retained.outcomes[0]!.kind, denied ? "unavailable" : mode === "lostStored" ? "uncertain" : "accepted");
    if (!denied) {
      const decoded = resultValue(decodeAdministrativeMemo(retained.posts[0]!.content));
      assert.equal(decoded.direction, "outbound"); assert.equal(decoded.patientId, verificationCanaries[2]);
      assert.equal(decoded.outcome.kind, operation === "book" ? "bookingConfirmed" : operation === "cancel" ? "cancellationObserved" : "reschedulingObserved");
      assert.equal(decoded.sourceActionRef, source);
      assert.deepEqual(resultValue(await retained.config.barrier.claimOnce(decoded.actionRef)), { claimed: false });
    }
    if (mode === "nativeUncertain") {
      // Independent synthetic provider oracle, never supplied back to Abby.
      assert.equal(await retained.config.native.rateBudget.claim(), null);
      const native = retained.config.native;
      const response = await f.retainedNative.fetchPort("https://api.au5.cliniko.com/v1/individual_appointments/91", { method: "GET", redirect: "error",
        headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${native.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${native.contactEmail})` },
        signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); const row = await response.json();
      if (operation === "book") assert.equal(row.notes, nativeNotes);
      else if (operation === "cancel") assert.ok(row.cancelled_at);
      else assert.equal(row.starts_at, "2026-10-08T05:00:00.000Z");
    }
    await f.mark(); await f.say("Did it finish", { kind: "outcome" });
    assert.equal(f.bookings + f.cancellations + f.patches, 1); assert.equal(retained.posts.length, denied ? 0 : 1);
    assert.equal(Object.values((await f.current()).actions)[0]!.status, mode === "nativeUncertain" ? "uncertain" : "committed");
    const publicData = JSON.stringify([f.spoken, f.modelTurns, f.transcripts, f.sent, await f.flow.publicIntentContext()]);
    const privateValues = [...verificationCanaries, code, f.recipientNumber, f.requestNotes, nativeNotes, source, retained.config.native.apiKey,
      ...f.recalls.map(row => String(row.notes)), ...retained.posts.flatMap(row => [String(row.content), JSON.stringify(row)]), retained.key.toString("hex"), retained.key.toString("base64")];
    for (const secret of privateValues)
      assert.equal(publicData.includes(secret), false);
    return { code, publicData, privateValues };
  } };
}
