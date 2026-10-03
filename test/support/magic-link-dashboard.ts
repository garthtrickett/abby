import type { MagicLinkIdentity } from "../../src/standalone/identity/magic-link.ts";
import { createMagicLinkHttp, magicLinkDashboardIdentity } from "../../src/standalone/identity/magic-link-http.ts";
import { createHostAuthenticatedDashboardRequestHandler } from "../../src/standalone/dashboard/server.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { PolicyStore } from "../../src/core/host.ts";
import { TextReception } from "../../src/reference/text-reception.ts";

/** Actual HTTP dispatcher and command gateway; authentication is always the magic-link session. */
export async function magicLinkDashboard(identity: MagicLinkIdentity, policy: PolicyStore,
  bundles: Readonly<{ dashboard: string; signIn: string }>) {
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const dashboard = await createHostAuthenticatedDashboardRequestHandler({ ...magicLinkDashboardIdentity(identity),
    gatewayFor: actor => new CommandGateway(actor, policy, reception),
  }, bundles.dashboard);
  return createMagicLinkHttp(identity, dashboard, bundles.signIn);
}
