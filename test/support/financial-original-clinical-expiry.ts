/** Conditional expiry uses the actual caller's played terms and created target. */
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { sql } from "kysely";
import { financialIndividualCaller } from "./financial-individual-caller.ts";
import { withClassFinancialCaller } from "./financial-class-caller-context.ts";
import type { FinancialClassVoiceBooking } from "./financial-class-voice-journey.ts";
import type { FinancialCallerActor } from "./financial-caller-context.ts";
import { financialConsumerPeer } from "./financial-consumer-peer.ts";
import type { FinancialConsumerCycle } from "../../src/standalone/cliniko-financial-consumer.ts";
import type { FinancialConsumerClassExpirySetup } from "./financial-consumer-process.ts";
import { withSmtpVerificationServer } from "./smtp-verification-server.ts";

export type OriginalClinicalKind = "individual" | "ordinaryClass" | "passClass" | "reviewTerms";
const cancellationTerms = "If the deposit remains unpaid and unwaived at the deadline, the clinic may cancel this exact appointment.";
const caseTerms = { version: "case-cancel-1", releaseOne: "Cancelling releases one counted session.",
  unchanged: "Cancelling leaves the counted sessions unchanged.", consumeOne: "Cancelling consumes one counted session." };
const approvedTerms = (kind: OriginalClinicalKind) => cancellationTerms + (kind === "passClass" ? ` ${caseTerms.releaseOne}` : "");
type Original = Readonly<{ cancellations: readonly unknown[]; timeZone: string;
  classSetup?: FinancialConsumerClassExpirySetup; classBooking?: FinancialClassVoiceBooking["booking"] }>;

export async function financialOriginalClinicalExpiry(kind: OriginalClinicalKind, stage: (value: number) => void): Promise<void> {
  if (kind === "individual" || kind === "reviewTerms") {
    await financialIndividualCaller("closedUnpaid", stage, (context, f) => run(context, kind, stage,
      { cancellations: f.cancellations, timeZone: f.timeZone }), kind === "individual" ? approvedTerms(kind) : undefined);
  } else {
    await withClassFinancialCaller(kind === "passClass", stage, (context, f) => run(context, kind, stage,
      { cancellations: f.cancellations, timeZone: f.classSessionConfig.cliniko.timeZone, classBooking: f,
        classSetup: { path: f.path, directoryPath: f.accountPath, binding: f.policy.binding() } }),
    { clinical: true, approvedTerms: approvedTerms(kind), ...(kind === "passClass" ? { caseCancellation: caseTerms } : {}) });
  }
}

async function run({ actor: c, observation, clock, advanceTo, directory, connectionString, db }: FinancialCallerActor,
  kind: OriginalClinicalKind, stage: (value: number) => void, original: Original): Promise<void> {
  let peer: Awaited<ReturnType<typeof financialConsumerPeer>> | undefined;
  let financial = false, clinical = false, seenFinancial = false, seenClinical = false;
  const output: string[] = [];
  const until = async (predicate: (cycle: FinancialConsumerCycle) => boolean, label: string) => {
    const deadline = performance.now() + 95_000;
    while (true) {
      assert.ok(performance.now() < deadline, label);
      const cycle = await peer!.nextCycle(); if (predicate(cycle)) return cycle;
    }
  };
  const stop = async () => { await peer!.kill(); output.push(...peer!.output); peer = undefined; };
  const noClinicalClaim = async () => {
    const rows = await sql`select effect_ref from financial_effect_barriers where tenant_id = ${c.intent.scope.tenantId}
      and effect_ref = ${c.intent.effects.clinicalExpiry}::uuid`.execute(db);
    assert.deepEqual(rows.rows, []); assert.equal(original.cancellations.length, 0);
  };
  try {
    await withSmtpVerificationServer(async smtp => {
      const baseApproval = () => ({ policyVersion: c.intent.payment.policyVersion, termsVersion: c.intent.payment.termsVersion,
        approvedTerms: approvedTerms(kind), timeZone: original.timeZone, cancellationReason: 50 as const });
      const launch = () => financialConsumerPeer(c, smtp.config, directory, {
        connectionString, voiceRunner: true, advancingClock: true, now: clock(), reviewDate: "2026-10-05", enableCheckoutExpiry: true,
        ...(kind === "individual" || kind === "reviewTerms" ? { enableClinicalExpiry: true } : {}),
        ...(kind === "ordinaryClass" ? { classClinicalExpiry: original.classSetup! } : {}),
        ...(kind === "passClass" ? { caseClassClinicalExpiry: { ...original.classSetup!, maximumAuthorityRequests: 0 } } : {}),
        allows: (purpose, raw) => {
          if (!["clinicalFinancial", "classClinicalFinancial", "caseClassClinicalFinancial"].includes(purpose)) return true;
          seenFinancial = true;
          const query = raw as { sources: { intent: { intent: { actionRef: string } }; booking: { observation: { targetRef: string } } } };
          assert.equal(query.sources.intent.intent.actionRef, c.intent.actionRef);
          assert.equal(query.sources.booking.observation.targetRef, observation.targetRef);
          return financial;
        },
        clinicalApproval: async q => {
          seenClinical = true; assert.equal(`cliniko:appointment:${q.target.appointmentId}`, observation.targetRef);
          return clinical ? { ...baseApproval(), kind: "cancelUnpaidIndividual" } : null;
        },
        classClinicalApproval: async q => {
          seenClinical = true; assert.equal(`cliniko:attendee:${q.target.attendeeId}`, observation.targetRef);
          return clinical ? { ...baseApproval(), kind: "cancelUnpaidUnlinkedClass", classPolicyVersion: original.classBooking!.approval.policyVersion } : null;
        },
        caseClassClinicalApproval: async q => {
          seenClinical = true; const f = original.classBooking!;
          assert.equal(`cliniko:attendee:${q.target.attendeeId}`, observation.targetRef);
          assert.equal(q.target.patientCase.patientCaseId, f.pass.caseId); assert.equal(q.target.patientCase.effect, "releaseOne");
          assert.equal(observation.classCreationRequest?.patientCaseId, f.pass.caseId);
          return clinical ? { ...baseApproval(), kind: "cancelUnpaidCaseClass", classPolicyVersion: f.approval.policyVersion,
            caseTermsVersion: caseTerms.version, approvedCaseTerms: caseTerms.releaseOne, patientCaseId: f.pass.caseId,
            entitlementRef: f.pass.entitlementRef, caseEffect: "releaseOne" } : null;
        },
      });
      peer = await launch();
      await until(cycle => cycle.messageAccepted === 1 && smtp.messages.length === 1 && c.receipts.length === 1, "one original Checkout and link");
      assert.equal(c.sessions.length, 1); assert.equal(original.cancellations.length, 0); stage(3); await stop();
      assert.equal(c.sessions[0]!.expires_at, Date.parse(c.intent.payment.deadline) / 1000);
      advanceTo(new Date(Date.parse(c.intent.payment.deadline) + 1000).toISOString());
      Object.assign(c.sessions[0]!, { status: "expired", payment_status: "unpaid", url: null });
      assert.equal(c.sessions[0]!.payment_intent, null);
      clinical = true; peer = await launch();
      const denied = await until(() => seenFinancial, "current independent financial cancellation permission");
      assert.equal(denied.clinicalExpiryCancelled, 0); await noClinicalClaim(); await stop();
      financial = true; clinical = false; seenClinical = false; peer = await launch();
      const noApproval = await until(() => seenClinical, "current exact clinical approval was consulted");
      assert.equal(noApproval.clinicalExpiryCancelled, 0); await noClinicalClaim(); await stop(); stage(4);
      clinical = true; seenClinical = false; peer = await launch();
      if (kind === "reviewTerms") {
        const mismatch = await until(() => seenClinical, "original clinic-review terms cannot become cancellation consent");
        assert.equal(mismatch.clinicalExpiryCancelled, 0); assert.ok(mismatch.reviewRequired > 0); await noClinicalClaim(); stage(5);
      } else {
        const cancelled = await until(cycle => cycle.clinicalExpiryCancelled === 1, "one independently approved original target cancellation");
        assert.ok(seenClinical); assert.equal(cancelled.checkoutExpiryAcknowledged, 0); assert.equal(original.cancellations.length, 1); stage(5);
        if (kind === "passClass") {
          const f = original.classBooking!;
          assert.deepEqual(f.pass.record.attendee_ids, ["601", "401"]);
          assert.equal(f.pass.rows.filter(row => row.cancelled_at == null).length, 1);
          assert.deepEqual(f.pass.rows.find(row => row.id === "401")!.patient_case,
            { links: { self: `https://api.au5.cliniko.com/v1/patient_cases/${f.pass.caseId}` } });
        }
        await stop(); peer = await launch(); await peer.nextCycle(); await peer.nextCycle();
        assert.equal(original.cancellations.length, 1, "cold replay must not submit another clinical mutation");
      }
      await stop(); assert.equal(smtp.messages.length, 1); assert.equal(c.sessions.length, 1); assert.equal(c.receipts.length, 1);
      assert.equal(c.requests.filter(r => r.method === "POST").length, 1, "no manufactured late-open expiry or second Checkout");
      assert.deepEqual(await readdir(directory), []); stage(6);
    });
    const workers = kind === "reviewTerms" ? 4 : 5;
    assert.match(output.join(""), new RegExp(`^(Abby voice local listener ready on 127\\.0\\.0\\.1:\\d+; calls disabled\\n){${workers}}$`));
  } finally { await peer?.kill(); }
}
