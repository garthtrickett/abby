import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { financialBookingFixture } from "../support/financial-booking.ts";
import { financialFeePolicyFixture } from "../support/financial-fee-policy.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";
import { ApprovedFinancialBookingPolicy } from "../../src/standalone/approved-financial-booking-policy.ts";
import { ClinikoFinancialBookingRecipient } from "../../src/cliniko/financial-booking-recipient.ts";
import { OwnerFileFinancialFeePolicy } from "../../src/standalone/owner-file-financial-fee-policy.ts";
import type { FinancialBookingPolicy } from "../../src/standalone/cliniko-financial-booking-preparation.ts";
const signal = () => new AbortController().signal;
async function fixture() {
  const fees = await financialFeePolicyFixture(); let policy: FinancialBookingPolicy | undefined, allowed = true;
  const forwarding: FinancialBookingPolicy = { quote: (s, stop) => policy!.quote(s, stop), current: (s, a, stop) => policy!.current(s, a, stop), currentForSend: (s, a, stop) => policy!.currentForSend(s, a, stop) };
  let host: Awaited<ReturnType<typeof financialBookingFixture>> | undefined;
  try {
    host = await financialBookingFixture({ scope: fees.approval.scope, policy: forwarding });
    const approval = { ...fees.approval, approvedAt: "2026-10-01T00:00:00.000Z", effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z",
      selection: { ...fees.approval.selection, policyVersion: host.evidence.policyVersion, businessId: host.evidence.businessId,
        credentialFingerprint: host.evidence.credentialFingerprint, practitionerId: host.evidence.practitionerId, appointmentTypeId: host.evidence.appointmentTypeId } };
    await writeFile(fees.path, JSON.stringify(approval));
    const source = resultValue(await OwnerFileFinancialFeePolicy.capture({ ...fees.config, clock: () => verificationNow }, signal()));
    const recipient = resultValue(ClinikoFinancialBookingRecipient.create({ ...host.config.native, clock: () => verificationNow },
      { allows: async q => allowed && q.booking.patientId === verificationCanaries[2], current: () => allowed }, host.config.fetchPort));
    policy = new ApprovedFinancialBookingPolicy({ fees: source, recipient, clock: () => verificationNow });
    return { host, fees, denyRecipient: () => { allowed = false; }, withdrawFees: () => writeFile(fees.path, JSON.stringify({ ...approval, enabled: false })),
      close: async () => { await host!.close(); await fees.close(); } };
  } catch (error) { await host?.close(); await fees.close(); throw error; }
}
async function select(f: Awaited<ReturnType<typeof fixture>>) {
  const host = f.host, ref = await host.verify(); resultValue(await host.propose(ref, "approved-fee-selection"));
  const state = await host.state(), pending = state.pendingPresentationId;
  if (pending && state.presentations[pending]?.kind === "notice") {
    resultValue(await host.runtime.startPresentation(host.callId, pending, host.sessionId, verificationNow));
    resultValue(await host.runtime.resolvePresentation(host.callId, pending, "played", host.sessionId, verificationNow));
  }
  return ref;
}

test("actual booking host uses clinic file fees and independently authorized native recipient before separate clinical confirmation", async t => {
  const f = await fixture(); t.after(f.close); const ref = await select(f);
  assert.equal(f.host.rows.size, 1); assert.equal(Object.keys((await f.host.state()).actions).length, 0);
  await f.host.play(); await f.host.accept();
  assert.ok(f.host.texts.join(" ").includes("AUD 50.00")); assert.ok(f.host.texts.join(" ").includes(verificationCanaries[0]!));
  resultValue(await f.host.propose(ref, "approved-fee-resume")); resultValue(await f.host.confirm()); resultValue(await f.host.drain());
  assert.equal(f.host.posts, 1); assert.ok(f.host.proof().financialConsent);
  const local = JSON.stringify(await f.host.state()); assert.equal(local.includes("AUD 50.00"), false); assert.equal(local.includes(verificationCanaries[0]!), false);
});
for (const denial of ["fees", "recipient"] as const)
test(`actual booking host refuses ${denial} withdrawal after played financial consent`, async t => {
  const f = await fixture(); t.after(f.close); const ref = await select(f); await f.host.play(); await f.host.accept();
  if (denial === "fees") await f.withdrawFees(); else f.denyRecipient();
  resultValue(await f.host.propose(ref, "withdrawn-fee-resume")); assert.equal(f.host.posts, 0);
  assert.equal(Object.keys((await f.host.state()).actions).length, 0);
});
