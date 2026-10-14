import { isDeepStrictEqual } from "node:util";
import type { ActionState, CallState, HostMutation, LocationScope, ReconcileObservation, WorkflowOperation } from "../core/model.ts";
import type { CallerCandidateLookup } from "../voice/caller-candidates.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { err } from "../core/model.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";

const operations = ["book", "cancel", "reschedule", "patientUpdate", "confirmationResend", "appointments.read"] as const;
type Approval = ClinicApproval & Readonly<{
  policyVersion: string; businessId: string; credentialFingerprint: string; timeZone: string;
  maximumTasks: number; operations: readonly typeof operations[number][];
  patientSelection: "sameVerifiedCaller"; verification: "freshEachTask"; unresolvedActions: "denyNextTask";
}>;
type Config = Readonly<{ path: string; scope: LocationScope; policyVersion: string; businessId: string;
  credentialFingerprint: string; timeZone: string; callId: string; sessionId: string; directory: AdminDirectory; signal: AbortSignal; clock: () => string }>;
function decode(value: unknown, scope: LocationScope): Approval | undefined {
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "credentialFingerprint", "timeZone",
    "maximumTasks", "operations", "patientSelection", "verification", "unresolvedActions"])) return undefined;
  const row = value as Approval;
  if (!approvalRef(row.policyVersion) || !validClinikoId(row.businessId) || !/^[a-f0-9]{64}$/.test(row.credentialFingerprint) ||
      typeof row.timeZone !== "string" || row.timeZone.length > 128 || !Number.isSafeInteger(row.maximumTasks) || row.maximumTasks < 2 || row.maximumTasks > 10 ||
      !Array.isArray(row.operations) || !row.operations.length || row.operations.length > operations.length || new Set(row.operations).size !== row.operations.length ||
      row.operations.some(kind => !operations.includes(kind)) || row.patientSelection !== "sameVerifiedCaller" ||
      row.verification !== "freshEachTask" || row.unresolvedActions !== "denyNextTask") return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: row.timeZone }); } catch { return undefined; }
  return row;
}

/** Private call-owned sequence. Prior receipts stay in the authoritative call;
 * this module never clears actions, grants patient authority or retries a write. */
export class ClinikoCallTasks {
  readonly #config: Config;
  #source: Promise<OwnerFileClinicApproval<Approval> | undefined> | undefined;
  readonly #settled = new Map<string, ActionState>();
  #patientId: string | undefined;
  #taskCount = 0;
  constructor(config: Config) { this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); }
  async #approval() {
    const signal = AbortSignal.any([this.#config.signal, AbortSignal.timeout(3000)]);
    try { return await awaitUntilAbort(this.#readApproval(), signal); } catch { return undefined; }
  }
  async #readApproval() {
    const c = this.#config;
    this.#source ??= OwnerFileClinicApproval.capture({ ...c, decode }).then(found => found.ok ? found.value : undefined, () => undefined);
    const source = await this.#source, found = await source?.current(c.scope);
    const row = found?.ok ? found.value : undefined;
    return row && (["policyVersion", "businessId", "credentialFingerprint", "timeZone"] as const).every(key => row[key] === c[key]) ? row : undefined;
  }
  #active(state: CallState) {
    const c = this.#config, now = Date.parse(c.clock());
    return !c.signal.aborted && state.callId === c.callId && sameScope(state.policy.scope, c.scope) && state.policy.policyVersion === c.policyVersion &&
      state.policy.automationEnabled && !state.callerIdentityDenied && state.lifecycle === "active" &&
      state.sessionLease?.sessionId === c.sessionId && Number.isFinite(now) && Date.parse(state.sessionLease.expiresAt) > now &&
      [...this.#settled].every(([key, action]) => isDeepStrictEqual(state.actions[key], action));
  }
  matches(scope: LocationScope, callId: string, sessionId: string, businessId: string, fingerprint: string, timeZone: string, policyVersion: string): boolean {
    const c = this.#config;
    return !c.signal.aborted && sameScope(c.scope, scope) && c.callId === callId && c.sessionId === sessionId && c.businessId === businessId &&
      c.credentialFingerprint === fingerprint && c.timeZone === timeZone && c.policyVersion === policyVersion;
  }
  currentActions(state: CallState): ActionState[] { return Object.values(state.actions).filter(action => !this.#settled.has(action.key) && !state.previousTaskActionKeys?.includes(action.key)); }
  hasSentCurrentWork(state: CallState): boolean {
    if (!this.#active(state)) return true;
    return Object.values(state.effects).some(effect =>
      effect.kind === "hostWrite" ? !this.#settled.has(effect.mutation.actionKey) && ["possiblySent", "completed", "uncertain"].includes(effect.status) :
        effect.kind === "staffTask" && ["possiblySent", "completed", "uncertain"].includes(effect.status));
  }
  async allows(state: CallState, operation: WorkflowOperation, advancing: boolean): Promise<boolean> {
    const approval = await this.#approval();
    if (!approval || !approval.operations.includes(operation as typeof operations[number]) || !this.#active(state) || (advancing ? this.#taskCount >= approval.maximumTasks : this.#taskCount > approval.maximumTasks)) return false;
    if (!advancing) return true;
    const actions = this.currentActions(state);
    return !!this.#patientId && this.#taskCount > 0 && actions.length > 0 && !state.pendingPresentationId &&
      actions.every(action => ["committed", "rejected", "unsupported", "canceled"].includes(action.status)) &&
      actions.some(action => action.status !== "canceled") &&
      Object.values(state.effects).every(effect => effect.kind !== "hostWrite" && effect.kind !== "staffTask" || ["completed", "canceled"].includes(effect.status)) &&
      Object.values(state.presentations).every(p => p.status !== "started" && p.status !== "possiblySent") &&
      Object.values(state.staffItems).every(item => item.status === "resolved" || item.status === "failed");
  }
  lookup(original: CallerCandidateLookup): CallerCandidateLookup {
    return { candidates: async (scope, phone) => {
      const approval = await this.#approval();
      if (this.#config.signal.aborted || !approval || (scope.tenantId !== this.#config.scope.tenantId || scope.clinicId !== this.#config.scope.clinicId)) return err({ kind: "denied" });
      const result = await original.candidates(scope, phone);
      if (!result.ok || result.value.kind !== "one" || !validClinikoId(result.value.candidateIds[0]) ||
          this.#patientId !== undefined && this.#patientId !== result.value.candidateIds[0] || this.#config.signal.aborted || !await this.#approval()) return err({ kind: "denied" });
      if (this.#config.signal.aborted || this.#patientId !== undefined && this.#patientId !== result.value.candidateIds[0]) return err({ kind: "denied" });
      this.#patientId ??= result.value.candidateIds[0];
      return result;
    } };
  }
  publish(state: CallState, advancing: boolean): void {
    if (advancing) for (const action of this.currentActions(state)) this.#settled.set(action.key, structuredClone(action));
    if (advancing || this.#taskCount === 0 || this.#settled.size === 0) this.#taskCount++;
  }
  isRetired(key: string): boolean { return this.#settled.has(key); }
  receipt(mutation: HostMutation): ReconcileObservation | undefined {
    const action = this.#settled.get(mutation.actionKey);
    if (!action) return undefined;
    if (!isDeepStrictEqual(action.mutation, mutation)) return { kind: "stillUnknown", actionKey: mutation.actionKey };
    return action.status === "committed" && action.hostRef ? { kind: "exactCommit", actionKey: action.key, hostRef: action.hostRef,
      ...(mutation.notification ? { notification: mutation.notification } : {}) } :
      ["rejected", "unsupported", "canceled"].includes(action.status) ? { kind: "definitiveNonCommit", actionKey: action.key } : { kind: "stillUnknown", actionKey: action.key };
  }
}
