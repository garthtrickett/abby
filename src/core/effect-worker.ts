import type { HostWriteReceipt, StaffTaskReceipt } from "./model.ts";
import type { HostEffects } from "./host.ts";
import { CallRuntime } from "./runtime.ts";

export class EffectWorker {
  private readonly runtime: CallRuntime;
  private readonly host: HostEffects;

  constructor(runtime: CallRuntime, host: HostEffects) {
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
