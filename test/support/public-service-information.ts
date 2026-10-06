import { clinicFAQFixture } from "./clinic-faqs.ts";

export const publicServices = "Demo North lists Initial visit: a first appointment with the clinic, and Follow-up visit: a return appointment. These descriptions do not recommend treatment. If you are unsure which service you need, contact clinic staff for guidance. These descriptions do not select an appointment type or reserve a time.";
export const publicPrices = "Demo North's published price is $120 for an Initial visit and $80 for a Follow-up visit. Cancellation fees depend on the appointment and the approved cancellation terms; contact the clinic to confirm the fee for your visit. This information does not waive a fee or approve a refund.";
export async function publicServiceInformationFixture(options: Readonly<{ services?: boolean; prices?: boolean }> = {}) {
  const f = await clinicFAQFixture();
  try {
    await f.replaceFAQs({ facts: [...f.faqApproval.facts,
      ...(options.services === false ? [] : [{ topic: "serviceGuidance" as const, approvedText: publicServices }]),
      ...(options.prices === false ? [] : [{ topic: "priceAndFees" as const, approvedText: publicPrices }])] });
    return f;
  } catch (error) { await f.close(); throw error; }
}
