import { createMagicLinkHttp, magicLinkDashboardIdentity } from "./identity/magic-link-http.ts";
import { MagicLinkIdentity } from "./identity/magic-link.ts";
import { createOperatorAlertHttp } from "./operator-alert-http.ts";
import type { OperatorAlertWorkflow } from "./operator-alert-workflow.ts";

/** Reuses the host's durable session store, approved directory and delivered
 * sign-in channel. Provisioning and real recipient acceptance remain external. */
export async function createOperatorAlertMagicLink(identity: MagicLinkIdentity, workflow: OperatorAlertWorkflow, signInBundlePath: string) {
  const operator = createOperatorAlertHttp(magicLinkDashboardIdentity(identity), workflow);
  try {
    const login = await createMagicLinkHttp(identity, operator.handle, signInBundlePath);
    return { handle: login.handle, async close() { await login.close(); await operator.close(); } };
  } catch (error) { await operator.close(); throw error; }
}
