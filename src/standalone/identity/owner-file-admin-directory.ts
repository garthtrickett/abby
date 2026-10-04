import { readOwnerJson } from "../../shared/owner-json.ts";
import { isAbsolute } from "node:path";
import { ok } from "../../core/model.ts";
import type { LocationScope, Result } from "../../core/model.ts";
import { identityUnavailable, validAdminAccount } from "./magic-link.ts";
import type { AdminAccount, AdminDirectory, IdentityFailure } from "./magic-link.ts";

const maxBytes = 65_536;
const scopeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Owner-provisioned accounts for one configured location; no signup, stale cache or request-owned membership. */
export class OwnerFileAdminDirectory implements AdminDirectory {
  private readonly path: string;
  private readonly scope: LocationScope;
  constructor(path: string, scope: LocationScope) {
    if (!isAbsolute(path) || typeof process.getuid !== "function" ||
        ![scope?.tenantId, scope?.clinicId, scope?.locationId].every(value => typeof value === "string" && scopeId.test(value))) {
      throw new RangeError("invalid administrator directory configuration");
    }
    this.path = path; this.scope = structuredClone(scope);
  }
  private async readAccounts(): Promise<Result<readonly AdminAccount[], IdentityFailure>> {
    try {
      const value = await readOwnerJson(this.path, maxBytes);
      if (!Array.isArray(value) || value.length > 128) return identityUnavailable();
      const emails = new Set<string>(), refs = new Set<string>();
      for (const account of value) {
        if (!validAdminAccount(account) || account.actor.scope.tenantId !== this.scope.tenantId ||
            account.actor.scope.clinicId !== this.scope.clinicId || account.actor.scope.locationId !== this.scope.locationId ||
            emails.has(account.email) || refs.has(account.actor.actorRef)) return identityUnavailable();
        emails.add(account.email); refs.add(account.actor.actorRef);
      }
      return ok(value as AdminAccount[]);
    } catch { return identityUnavailable(); }
  }
  async findByEmail(email: string): Promise<Result<AdminAccount | undefined, IdentityFailure>> {
    const accounts = await this.readAccounts();
    return accounts.ok ? ok(accounts.value.find(account => account.email === email)) : accounts;
  }
  async findByRef(actorRef: string): Promise<Result<AdminAccount | undefined, IdentityFailure>> {
    const accounts = await this.readAccounts();
    return accounts.ok ? ok(accounts.value.find(account => account.actor.actorRef === actorRef)) : accounts;
  }
}
