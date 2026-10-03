import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { PostgresMagicLinkStore } from "../storage/postgres-magic-link-store.ts";
import { createStandaloneClinikoAdminDashboardHandler } from "./cliniko-admin-dashboard.ts";
import type { ClinikoAdminDashboardConfig, ClinikoAdminDashboardFailure } from "./cliniko-admin-dashboard.ts";
import { MagicLinkIdentity, validAdminAccount } from "./identity/magic-link.ts";
import type { AdminAccount, AdminDirectory, IdentityFailure, MagicLinkDelivery } from "./identity/magic-link.ts";
import { createMagicLinkHttp, magicLinkDashboardIdentity } from "./identity/magic-link-http.ts";
import type { MagicLinkHttp } from "./identity/magic-link-http.ts";

export type ClinikoMagicLinkAdminConfig = Omit<ClinikoAdminDashboardConfig, "resolveActor" | "unauthorized" | "signOutPath"> & Readonly<{
  directory: AdminDirectory; delivery: MagicLinkDelivery; rateKeyHex: string; signInBundlePath: string;
}>;

function locationDirectory(directory: AdminDirectory, scope: LocationScope): AdminDirectory {
  async function allowed(pending: Promise<Result<AdminAccount | undefined, IdentityFailure>>) {
    const result = await pending;
    if (!result.ok || !result.value) return result;
    const account = result.value;
    return validAdminAccount(account) && account.actor.scope.tenantId === scope.tenantId &&
      account.actor.scope.clinicId === scope.clinicId && account.actor.scope.locationId === scope.locationId ? result : ok(undefined);
  }
  return { findByEmail: email => allowed(directory.findByEmail(email)), findByRef: ref => allowed(directory.findByRef(ref)) };
}

/** Standalone production composition: PostgreSQL authentication and clinic policy share the supplied database. */
export async function createStandaloneClinikoMagicLinkAdmin(config: ClinikoMagicLinkAdminConfig):
  Promise<Result<MagicLinkHttp, ClinikoAdminDashboardFailure>> {
  try {
    const scope = structuredClone(config.scope);
    const identity = new MagicLinkIdentity({ publicOrigin: config.publicOrigin, rateKeyHex: config.rateKeyHex,
      store: new PostgresMagicLinkStore(config.db), directory: locationDirectory(config.directory, scope), delivery: config.delivery });
    const dashboard = await createStandaloneClinikoAdminDashboardHandler({ ...config, scope, ...magicLinkDashboardIdentity(identity) });
    if (!dashboard.ok) return dashboard;
    return ok(await createMagicLinkHttp(identity, dashboard.value, config.signInBundlePath));
  } catch (error) {
    return err({ kind: error instanceof RangeError ? "invalidConfig" : "dashboardUnavailable" });
  }
}
