import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import type { HostActor } from "../reference/command-gateway.ts";
import { operationalDays } from "../voice/operational-counts.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { approvalRef, approvalInstant, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import { validAdminAccount } from "./identity/magic-link.ts";
import type { AdminAccount, AdminDirectory } from "./identity/magic-link.ts";
import { parseAggregateAlertThresholds, validOperationalAlert } from "./operational-alert.ts";
import type { AggregateAlertKind, OperationalAlert } from "./operational-alert.ts";
import { OperatorAlertStateStore } from "./operator-alert-state.ts";
import type { OperatorAlertState } from "./operator-alert-state.ts";
import { VoiceOperationalAlertInbox } from "./voice-operational-alert-inbox.ts";

export type OperatorResponseApproval = ClinicApproval & Readonly<{ channel: "authenticatedOperatorInbox"; ownerRef: string; backupRef: string;
  escalateAfterMinutes: number; responsibilityMinutes: number; alertKinds: readonly AggregateAlertKind[] }>;
export type OperatorAlertWorkflowConfig = Readonly<{ scope: LocationScope; inbox: VoiceOperationalAlertInbox; stateDirectory: string;
  approvalPath: string; directory: AdminDirectory; clock?: () => string }>;
export type OperatorAlertView = Readonly<{ alert: OperationalAlert; version: number; state: "awaitingOwner" | "awaitingBackup" | "acknowledged";
  assignedTo: "you" | "owner" | "backup"; canAcknowledge: boolean; responsibilityUntil?: string }>;
const unavailable = () => new Error("operator alert workflow unavailable");
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const alertFingerprint = (alert: OperationalAlert) => fingerprint([alert.date, alert.kind, alert.count, alert.threshold]);
function decode(value: unknown, scope: LocationScope): OperatorResponseApproval | undefined {
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "channel", "ownerRef", "backupRef", "escalateAfterMinutes", "responsibilityMinutes", "alertKinds"])) return undefined;
  const row = value as Record<string, unknown>;
  if (row.channel !== "authenticatedOperatorInbox" || !approvalRef(row.ownerRef) || !approvalRef(row.backupRef) || row.ownerRef === row.backupRef ||
      [row.escalateAfterMinutes, row.responsibilityMinutes].some(v => !Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > 1440) ||
      !Array.isArray(row.alertKinds) || !row.alertKinds.length || row.alertKinds.length > 12 || new Set(row.alertKinds).size !== row.alertKinds.length) return undefined;
  try { parseAggregateAlertThresholds(JSON.stringify(Object.fromEntries(row.alertKinds.map(kind => [kind, 1])))); } catch { return undefined; }
  return row as unknown as OperatorResponseApproval;
}
type Authority = Readonly<{ approval: OperatorResponseApproval; owner: AdminAccount; backup: AdminAccount; fingerprint: string }>;

/** A genuine authenticated operator action records bounded responsibility.
 * Transport receipts remain immutable and separate; neither acknowledgment nor
 * backup assignment changes a patient request or promises clinical completion. */
export class OperatorAlertWorkflow {
  readonly #config: OperatorAlertWorkflowConfig;
  readonly #source: OwnerFileClinicApproval<OperatorResponseApproval>;
  readonly #store: OperatorAlertStateStore;
  private constructor(config: OperatorAlertWorkflowConfig, source: OwnerFileClinicApproval<OperatorResponseApproval>) {
    this.#config = config; this.#source = source; this.#store = new OperatorAlertStateStore(config.stateDirectory, config.scope);
  }
  static async create(incoming: OperatorAlertWorkflowConfig) {
    try {
      if (!(incoming.inbox instanceof VoiceOperationalAlertInbox) || !sameScope(incoming.scope, incoming.inbox.binding())) throw unavailable();
      const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
      const source = await OwnerFileClinicApproval.capture({ path: config.approvalPath, scope: config.scope, directory: config.directory, decode,
        ...(config.clock ? { clock: config.clock } : {}) });
      if (!source.ok) throw unavailable(); const workflow = new OperatorAlertWorkflow(config, source.value);
      await workflow.observe(); return ok(workflow);
    } catch { return err({ kind: "operatorWorkflowUnavailable" as const }); }
  }
  #now() { const now = (this.#config.clock ?? (() => new Date().toISOString()))(); if (approvalInstant(now) === undefined) throw unavailable(); return now; }
  binding(): LocationScope { return { ...this.#config.scope }; }
  async #authority(): Promise<Authority> {
    const c = this.#config, result = await this.#source.current(c.scope); if (!result.ok || !result.value) throw unavailable();
    const approval = result.value;
    const owner = await c.directory.findByRef(approval.ownerRef), backup = await c.directory.findByRef(approval.backupRef);
    if (!owner.ok || !backup.ok || !owner.value || !backup.value || owner.value.actor.actorRef !== approval.ownerRef ||
      backup.value.actor.actorRef !== approval.backupRef || ![owner.value, backup.value].every(account =>
      validAdminAccount(account) && sameScope(account.actor.scope, c.scope))) throw unavailable();
    const again = await this.#source.current(c.scope); if (!again.ok || !again.value || fingerprint(again.value) !== fingerprint(approval)) throw unavailable();
    return { approval, owner: owner.value, backup: backup.value, fingerprint: fingerprint([this.#source.bindingFingerprint(), owner.value, backup.value]) };
  }
  #member(actor: HostActor, authority: Authority): AdminAccount {
    const member = [authority.owner, authority.backup].find(account => account.actor.actorRef === actor?.actorRef &&
      account.actor.role === actor.role && sameScope(account.actor.scope, actor.scope));
    if (!member) throw unavailable(); return member;
  }
  #assignment(state: OperatorAlertState, authority: Authority, instant = this.#now()) {
    const now = Date.parse(instant); if (now < Date.parse(state.firstObservedAt)) throw unavailable();
    const ack = state.acknowledgment, member = ack && [authority.owner, authority.backup].find(m => m.actor.actorRef === ack.actorRef);
    if (ack && now < Date.parse(ack.at)) throw unavailable();
    const until = ack ? Math.min(Date.parse(ack.at) + authority.approval.responsibilityMinutes * 60_000, Date.parse(authority.approval.effectiveUntil)) : 0;
    const active = !!ack && state.policyFingerprint === authority.fingerprint && member && fingerprint(member) === ack.membershipFingerprint && now < until;
    return active ? { state: "acknowledged" as const, actorRef: ack.actorRef, until: new Date(until).toISOString() }
      : ack || now >= Date.parse(state.firstObservedAt) + authority.approval.escalateAfterMinutes * 60_000
        ? { state: "awaitingBackup" as const, actorRef: authority.approval.backupRef }
        : { state: "awaitingOwner" as const, actorRef: authority.approval.ownerRef };
  }
  async #observe(authority: Authority): Promise<readonly OperatorAlertState[]> {
    const snapshot = await this.#config.inbox.snapshot(), states: OperatorAlertState[] = [];
    await this.#store.prune(operationalDays(this.#now())[0]!);
    for (const alert of snapshot.alerts.filter(a => authority.approval.alertKinds.includes(a.kind))) {
      let state = await this.#store.read(alert);
      if (!state) {
        const initial: OperatorAlertState = { schemaVersion: 1, version: 0, alert, policyFingerprint: authority.fingerprint,
          firstObservedAt: this.#now(), acknowledgment: null };
        const current = await this.#authority(); if (current.fingerprint !== authority.fingerprint) throw unavailable();
        await this.#store.compareAndSet(undefined, initial); state = await this.#store.read(alert);
      }
      if (!state) throw unavailable(); states.push(state);
    }
    if ((await this.#authority()).fingerprint !== authority.fingerprint) throw unavailable(); return states;
  }
  async observe(): Promise<void> { await this.#observe(await this.#authority()); }
  async view(actor: HostActor): Promise<readonly OperatorAlertView[]> {
    const authority = await this.#authority(); this.#member(actor, authority);
    const states = await this.#observe(authority);
    return states.map(state => { const assignment = this.#assignment(state, authority); return {
      alert: { ...state.alert }, version: state.version, state: assignment.state,
      assignedTo: assignment.actorRef === actor.actorRef ? "you" : assignment.actorRef === authority.approval.ownerRef ? "owner" : "backup",
      canAcknowledge: assignment.state !== "acknowledged" && assignment.actorRef === actor.actorRef,
      ...("until" in assignment ? { responsibilityUntil: assignment.until } : {}),
    }; });
  }
  async acknowledge(actor: HostActor, alert: OperationalAlert, expectedVersion: number): Promise<"acknowledged" | "conflict" | "forbidden"> {
    const authority = await this.#authority(), member = this.#member(actor, authority);
    if (!validOperationalAlert(alert) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return "forbidden";
    const state = (await this.#observe(authority)).find(s => alertFingerprint(s.alert) === alertFingerprint(alert)); if (!state) return "forbidden";
    const assignment = this.#assignment(state, authority);
    if (assignment.state === "acknowledged") return assignment.actorRef === actor.actorRef ? "acknowledged" : "conflict";
    if (assignment.actorRef !== actor.actorRef) return "forbidden"; if (state.version !== expectedVersion) return "conflict";
    if ((await this.#authority()).fingerprint !== authority.fingerprint) throw unavailable();
    const at = this.#now(), finalAssignment = this.#assignment(state, authority, at);
    if (finalAssignment.state === "acknowledged" || finalAssignment.actorRef !== actor.actorRef) return "conflict";
    const next: OperatorAlertState = { ...state, version: state.version + 1, policyFingerprint: authority.fingerprint,
      acknowledgment: { actorRef: actor.actorRef, membershipFingerprint: fingerprint(member), at } };
    if (await this.#store.compareAndSet(state.version, next)) return "acknowledged";
    const current = await this.#store.read(alert);
    return current && this.#assignment(current, authority).state === "acknowledged" && current.acknowledgment?.actorRef === actor.actorRef ? "acknowledged" : "conflict";
  }
}
