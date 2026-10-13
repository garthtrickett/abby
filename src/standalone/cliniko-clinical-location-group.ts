import { err } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import type { PolicyStore } from "../core/host.ts";
import type { ClinikoSelectionApproval } from "../cliniko/catalogue-setup.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { ClinikoVoiceClinicalHost } from "./cliniko-voice-clinical-host.ts";
import type { ClinikoVoiceWorkflow } from "./transient-voice-composition.ts";

type Location = Readonly<{ scope: LocationScope; host: ClinikoVoiceClinicalHost; approval: ClinikoSelectionApproval }>;
/** Public pre-location policy reads and scoped clinical owners share no patient
 * proof. Every policy use rechecks the original independent route approval. */
export class ClinikoClinicalLocationGroup {
  readonly #locations: readonly Location[];
  readonly #read: (scope: LocationScope) => Promise<ClinikoSelectionApproval | null>;
  constructor(locations: readonly Location[], read: (scope: LocationScope) => Promise<ClinikoSelectionApproval | null>) {
    if (locations.length < 2 || locations.length > 32 || new Set(locations.map(row => row.scope.locationId)).size !== locations.length ||
      locations.some(row => !(row.host instanceof ClinikoVoiceClinicalHost) || !sameScope(row.scope, row.approval.scope) || !row.host.matches(row.approval) ||
        row.scope.tenantId !== locations[0]!.scope.tenantId || row.scope.clinicId !== locations[0]!.scope.clinicId)) throw new TypeError("invalid clinical location group");
    this.#locations = locations.map(row => Object.freeze({ scope: Object.freeze({ ...row.scope }), host: row.host, approval: structuredClone(row.approval) }));
    this.#read = read;
  }
  get policyVersions() { return this.#locations.map(row => ({ scope: row.scope, policyVersion: row.approval.selection.policyVersion })); }
  get serviceSources() {
    return this.#locations.map(row => {
      const source = row.host.locationServiceSource;
      if (!source) throw new TypeError("shared-number clinical location requires approved service catalogue");
      return source;
    });
  }
  async #current(scope: LocationScope) {
    const row = this.#locations.find(row => sameScope(row.scope, scope)); if (!row) return undefined;
    try {
      const current = await this.#read(scope);
      return current && JSON.stringify(current) === JSON.stringify(row.approval) && row.host.matches(current) ? row.host.workflow(current) : undefined;
    } catch { return undefined; }
  }
  workflow(): ClinikoVoiceWorkflow {
    const rows = this.#locations.map(row => ({ ...row, workflow: row.host.workflow(row.approval) }));
    const base = rows[0]!.workflow.policies;
    const policies = new Proxy(base, { get: (target, property) => {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return async (scope: LocationScope, ...args: unknown[]) => {
        const current = await this.#current(scope);
        const method = current && Reflect.get(current.policies, property);
        return typeof method === "function" ? method.apply(current!.policies, [scope, ...args]) : err({ kind: "invalidValue" });
      };
    } }) as PolicyStore;
    let selected: typeof rows[number] | undefined;
    return { policies,
      publicKnowledgeByLocation: rows.flatMap(row => row.workflow.publicKnowledge ? [{ scope: row.scope, source: row.workflow.publicKnowledge }] : []),
      ...(rows.some(row => row.workflow.privateIntakeTranscription) ? { privateIntakeTranscription: (sessionId: string) => {
        if (!selected?.workflow.privateIntakeTranscription) throw new Error("selected location private input unavailable");
        return selected.workflow.privateIntakeTranscription(sessionId);
      } } : {}),
      create: context => {
        const row = rows.find(row => sameScope(row.scope, context.receipt.scope));
        if (!row || selected && !sameScope(selected.scope, row.scope)) throw new Error("clinical location binding mismatch");
        selected = row; return row.workflow.create(context);
      },
      intent: owner => {
        if (!selected) throw new Error("clinical location not selected");
        return selected.workflow.intent(owner);
      } };
  }
}
