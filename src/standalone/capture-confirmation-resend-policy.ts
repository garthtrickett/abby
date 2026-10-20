import type { CallPolicy } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OwnerFileConfirmationResendPolicy } from "./owner-file-confirmation-resend-policy.ts";

/** Trusted admission/current-policy composition. Saved flags alone cannot grant resend execution. */
export async function captureConfirmationResendPolicy(incoming: CallPolicy, approval?: OwnerFileConfirmationResendPolicy): Promise<CallPolicy> {
  const { confirmationResendVersion: _version, ...base } = structuredClone(incoming);
  void _version;
  const { confirmationResend: _mode, ...capabilities } = base.capabilities;
  void _mode;
  const disabled = { ...base, capabilities };
  if (!(approval instanceof OwnerFileConfirmationResendPolicy)) return disabled;
  try {
    const current = await awaitUntilAbort(approval.current(base.scope), AbortSignal.timeout(1500));
    return current?.ok && current.value.policyVersion === base.policyVersion
      ? { ...disabled, confirmationResendVersion: approval.bindingFingerprint(), capabilities: { ...capabilities, confirmationResend: "execute" } }
      : disabled;
  } catch { return disabled; }
}
