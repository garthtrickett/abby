import type { HostWriteReceipt, OperatorAlertReceipt, StaffChangeReceipt, StaffTaskReceipt } from "./model.ts";
import type { HostEffects, OperatorAlertHost, StaffLifecycleHost } from "./host.ts";
import { CallRuntime } from "./runtime.ts";

export class EffectWorker {
  private readonly runtime: CallRuntime;
  private readonly host: HostEffects & Partial<StaffLifecycleHost & OperatorAlertHost>;

  constructor(runtime: CallRuntime, host: HostEffects & Partial<StaffLifecycleHost & OperatorAlertHost>) {
    this.runtime = runtime;
    this.host = host;
  }

  async process(callId: string, effectId: string, now: string): Promise<void> {
    const read = await this.runtime.read(callId);
    if (!read.ok) throw new Error(read.error.kind);
    const effect = read.value.effects[effectId];
    if (!effect) throw new Error("effectUnknown");
    if (effect.kind === "hostWrite") {
      if (effect.status !== "pending") throw new Error("invalidTransition");
      const marked = await this.runtime.markHostPossiblySent(callId, effectId, now);
      if (!marked.ok) throw new Error(marked.error.kind);
      let receipt: HostWriteReceipt;
      try {
        receipt = await this.host.write(effect.mutation, now);
      } catch {
        receipt = {
          kind: "uncertain",
          actionKey: effect.actionKey,
          reconcileAfter: now,
          deadline: new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(),
        };
      }
      const resolved = await this.runtime.acceptHostResult(callId, effectId, receipt, now);
      if (!resolved.ok) throw new Error(resolved.error.kind);
      return;
    }
    if (effect.kind === "hostReconcile") {
      if (effect.status !== "pending") throw new Error("invalidTransition");
      const original = read.value.effects[effect.originalEffectId];
      if (!original || original.kind !== "hostWrite") throw new Error("effectUnknown");
      const observation = await this.host.reconcile(original.mutation);
      const resolved = await this.runtime.acceptReconciliation(callId, effectId, observation, now);
      if (!resolved.ok) throw new Error(resolved.error.kind);
      return;
    }
    if (effect.kind === "staffReconcile") {
      if (effect.status !== "pending") throw new Error("invalidTransition");
      const original = read.value.effects[effect.originalEffectId];
      if (!original || original.kind !== "staffTask" || original.status !== "uncertain") throw new Error("effectUnknown");
      const observation = await this.host.reconcileTask(effect.originalItem);
      const resolved = await this.runtime.acceptStaffReconciliation(callId, effectId, observation);
      if (!resolved.ok) throw new Error(resolved.error.kind);
      return;
    }
    if (effect.kind === "staffChange") {
      if (effect.status !== "pending") throw new Error("invalidTransition");
      const marked = await this.runtime.markStaffChangePossiblySent(callId, effectId, now);
      if (!marked.ok) throw new Error(marked.error.kind);
      let receipt: StaffChangeReceipt;
      try {
        receipt = this.host.advanceTask
          ? await this.host.advanceTask(effect.change)
          : { kind: "rejected", commandKey: effect.change.commandKey, taskKey: effect.taskKey };
      } catch {
        receipt = { kind: "uncertain", commandKey: effect.change.commandKey, taskKey: effect.taskKey };
      }
      const resolved = await this.runtime.acceptStaffChangeResult(callId, effectId, receipt);
      if (!resolved.ok) throw new Error(resolved.error.kind);
      return;
    }
    if (effect.kind === "staffChangeReconcile") {
      if (effect.status !== "pending") throw new Error("invalidTransition");
      const original = read.value.effects[effect.originalEffectId];
      if (!original || original.kind !== "staffChange" || original.status !== "uncertain") throw new Error("effectUnknown");
      const observation = this.host.reconcileTaskChange
        ? await this.host.reconcileTaskChange(effect.change)
        : { kind: "stillUnknown" as const, commandKey: effect.change.commandKey, taskKey: effect.taskKey };
      const resolved = await this.runtime.acceptStaffChangeReconciliation(callId, effectId, observation);
      if (!resolved.ok) throw new Error(resolved.error.kind);
      return;
    }
    if (effect.kind === "operatorAlert") {
      if (effect.status !== "pending" || !this.host.sendAlert) throw new Error("alertUnavailable");
      const marked = await this.runtime.markOperatorAlertPossiblySent(callId, effectId, now);
      if (!marked.ok) throw new Error(marked.error.kind);
      if (marked.value.effects[effectId]?.status === "canceled") return;
      let receipt: OperatorAlertReceipt;
      try { receipt = await this.host.sendAlert(effect.alert); }
      catch { receipt = { kind: "uncertain", alertKey: effect.alert.alertKey }; }
      const resolved = await this.runtime.acceptOperatorAlertResult(callId, effectId, receipt, now);
      if (!resolved.ok) throw new Error(resolved.error.kind);
      if (receipt.kind === "failed") throw new Error("alertDeliveryFailed");
      return;
    }
    if (effect.kind === "operatorAlertReconcile") {
      if (effect.status !== "pending" || !this.host.reconcileAlert) throw new Error("alertUnavailable");
      const observation = await this.host.reconcileAlert(effect.alert);
      const resolved = await this.runtime.acceptOperatorAlertReconciliation(callId, effectId, observation, now);
      if (!resolved.ok) throw new Error(resolved.error.kind);
      if (observation.kind !== "exactDelivered") throw new Error("alertDeliveryUnproven");
      return;
    }
    if (effect.status !== "pending") throw new Error("invalidTransition");
    const item = read.value.staffItems[effect.taskKey];
    if (!item) throw new Error("effectUnknown");
    const marked = await this.runtime.markStaffPossiblySent(callId, effectId, now);
    if (!marked.ok) throw new Error(marked.error.kind);
    let receipt: StaffTaskReceipt;
    try {
      receipt = await this.host.openTask(item);
    } catch {
      receipt = { kind: "uncertain", taskKey: item.key };
    }
    const resolved = await this.runtime.acceptStaffResult(callId, effectId, receipt);
    if (!resolved.ok) throw new Error(resolved.error.kind);
  }
}
