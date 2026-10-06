import { join } from "node:path";
import { rename, writeFile } from "node:fs/promises";
import { OwnerFileClinicFAQs } from "../../src/standalone/owner-file-clinic-faqs.ts";
import type { ClinicFAQApproval } from "../../src/standalone/owner-file-clinic-faqs.ts";
import { bookingCallFlowFixture } from "./cliniko-call-flow.ts";

export const publicDirections = "Demo North is at 10 Example Street. The entrance faces Example Street. Parking is behind the clinic.";
export async function clinicFAQFixture() {
  const f = await bookingCallFlowFixture(); f.flow.dispose();
  const path = join(f.folder, "public-clinic-faqs.json");
  let row: ClinicFAQApproval = { scope: f.scope, revision: "public-faqs-1", approverRef: "synthetic-admin",
    policyVersion: f.flowConfig.policyVersion, approvedAt: "2026-10-04T05:59:00.000Z", effectiveFrom: "2026-10-04T06:00:00.000Z",
    effectiveUntil: "2026-10-05T06:00:00.000Z", approved: true, enabled: true,
    facts: [{ topic: "directionsAndParking", approvedText: publicDirections },
      { topic: "openingHours", approvedText: "Demo North opens Monday to Friday from 9 am to 5 pm." },
      { topic: "contact", approvedText: "You can contact Demo North on 02 5550 0199." }] };
  const replace = async (patch: Partial<ClinicFAQApproval>) => {
    row = { ...row, ...patch }; await writeFile(`${path}.new`, JSON.stringify(row), { mode: 0o600 }); await rename(`${path}.new`, path);
  };
  try {
    await replace({});
    const knowledge = new OwnerFileClinicFAQs({ path, scope: f.scope, policyVersion: f.flowConfig.policyVersion,
      policies: f.policies, directory: f.directory, ...(f.flowConfig.clock ? { clock: f.flowConfig.clock } : {}) });
    return { ...f, knowledge, faqPath: path, replaceFAQs: replace, flowConfig: { ...f.flowConfig, publicKnowledge: knowledge },
      get faqApproval() { return structuredClone(row); } };
  } catch (error) { await f.close(); throw error; }
}
