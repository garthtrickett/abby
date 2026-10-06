import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CancellationApproval } from "../../src/standalone/owner-file-cancellation-policy.ts";
import { reschedulingCallFlowFixture } from "./cliniko-call-flow.ts";

/** Both operations independently approved and executable, but each new owner
 * still requires its own operation-bound OTP grant. No production approval. */
export async function appointmentChangeCallFlowFixture() {
  const f = await reschedulingCallFlowFixture({ cancellationExecute: true });
  try {
    const caller = JSON.parse(await readFile(f.config.callerApprovalPath, "utf8"));
    caller.operations = ["appointments.cancel", "appointments.reschedule"];
    await writeFile(f.config.callerApprovalPath, JSON.stringify(caller), { mode: 0o600 });
    const policy: CancellationApproval = { ...f.approval, revision: "synthetic-cancel-change-1", cancellationReason: 50,
      standardTerms: { version: "synthetic-cancel-standard-1", approvedText: "There is no fee for this cancellation." },
      lateTerms: { version: "synthetic-cancel-late-1", approvedText: "A cancellation fee of $20 applies." } };
    const cancellation = join(f.folder, "independent-cancellation.json");
    await writeFile(cancellation, JSON.stringify(policy), { mode: 0o600 });
    return { ...f, flowConfig: { ...f.flowConfig, approvals: { ...f.flowConfig.approvals, cancellation } } };
  } catch (error) { await f.close(); throw error; }
}
