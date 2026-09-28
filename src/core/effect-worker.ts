import type { HostWriteReceipt, OperatorAlertReceipt, StaffChangeReceipt, StaffTaskReceipt } from "./model.ts";
import type { HostEffects, KnowledgeHost, OperatorAlertHost, StaffLifecycleHost } from "./host.ts";
import { CallRuntime } from "./runtime.ts";
import { err } from "./model.ts";
import type { ModelWork } from "../model/work.ts";
import { createHash } from "node:crypto";
import { systemTimer } from "./timer.ts";
import type { TimerPort } from "./timer.ts";
import type { EffectCallLeaseGuard } from "./effect-call-lease.ts";

export type EffectWorkerOptions = Readonly<{ hostDeadlineMs?: number; timer?: TimerPort; signal?: AbortSignal; leaseGuard?: EffectCallLeaseGuard }>;

export class EffectWorker {
  private readonly runtime: CallRuntime;
  private readonly host: HostEffects & Partial<KnowledgeHost & StaffLifecycleHost & OperatorAlertHost>;
  private readonly model: ModelWork | undefined;
  private readonly knowledge: KnowledgeHost | undefined;
  private readonly hostDeadlineMs: number;
  private readonly timer: TimerPort;
  private readonly signal: AbortSignal | undefined;

  constructor(runtime: CallRuntime, host: HostEffects & Partial<KnowledgeHost & StaffLifecycleHost & OperatorAlertHost>, model?: ModelWork,
              knowledge?: KnowledgeHost, options: EffectWorkerOptions = {}) {
    const deadline = options.hostDeadlineMs ?? 15_000;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 120_000) throw new RangeError("hostDeadlineMs must be 1..120000");
    this.runtime = options.leaseGuard ? runtime.withEffectLease(options.leaseGuard) : runtime;
    this.host = host;
    this.model = model;
    this.knowledge = knowledge ?? (host.readKnowledge ? host as KnowledgeHost : undefined);
    this.hostDeadlineMs = deadline;
    this.timer = options.timer ?? systemTimer;
    this.signal = options.signal;
  }

  private async hostCall<Value>(work: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
    if (this.signal?.aborted) throw new Error("effectLeaseLost");
    let handle: unknown;
    const controller = new AbortController();
    const timeout = new Promise<never>((_, reject) => {
      handle = this.timer.schedule(() => {
        controller.abort();
        reject(new Error("hostDeadlineExceeded"));
      }, this.hostDeadlineMs);
    });
    let onLeaseAbort: (() => void) | undefined;
    const leaseLost = new Promise<never>((_, reject) => {
      if (!this.signal) return;
      onLeaseAbort = () => { controller.abort(); reject(new Error("effectLeaseLost")); };
      this.signal.addEventListener("abort", onLeaseAbort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout, leaseLost]); }
    finally {
      this.timer.cancel(handle);
      if (this.signal && onLeaseAbort) this.signal.removeEventListener("abort", onLeaseAbort);
    }
  }

  async process(callId: string, effectId: string, now: string): Promise<void> {
    if (this.signal?.aborted) throw new Error("effectLeaseLost");
    const read = await this.runtime.read(callId);
    if (!read.ok) throw new Error(read.error.kind);
    const effect = read.value.effects[effectId];
    if (!effect) throw new Error("effectUnknown");
    if (effect.kind === "model") {
      if (effect.status !== "pending") throw new Error("invalidTransition");
      const input = this.model?.input(effect.taskRef);
      const valid = input && input.turn.callId === callId && input.turn.turnId === effect.turnId &&
        input.conversationRevision === effect.conversationRevision && input.policyVersion === read.value.policy.policyVersion &&
        input.scope.tenantId === read.value.policy.scope.tenantId && input.scope.clinicId === read.value.policy.scope.clinicId &&
        input.scope.locationId === read.value.policy.scope.locationId;
      const result = valid && this.model
        ? await this.model.ingress.propose(input, this.model.deadlineMs)
        : err({ kind: "unavailable" as const });
      if (result.ok && result.value.kind === "answer") this.model?.rememberAnswer(effect.taskRef, result.value);
      const resolved = await this.runtime.acceptModelResult(callId, effectId, result, now);
      if (!resolved.ok) throw new Error(resolved.error.kind);
      if (resolved.value.effects[`${effectId}:knowledge`]?.status !== "pending") this.model?.forget(effect.taskRef);
      return;
    }
    if (effect.kind === "modelKnowledge") {
      if (effect.status !== "pending") throw new Error("invalidTransition");
      const answer = this.model?.answer(effect.taskRef);
      const valid = answer && createHash("sha256").update(JSON.stringify(answer.sourceRefs)).digest("hex") === effect.sourceRefsDigest;
      let result: Awaited<ReturnType<KnowledgeHost["readKnowledge"]>> = err({ kind: "unavailable" });
      if (valid && this.knowledge) {
        try { result = await this.hostCall(signal => this.knowledge!.readKnowledge(read.value.policy.scope, answer.sourceRefs, signal)); }
        catch { result = err({ kind: "unavailable" }); }
      }
      const resolved = await this.runtime.acceptModelKnowledge(callId, effectId, result, now, valid ? answer.proposedText : undefined);
      if (!resolved.ok) throw new Error(resolved.error.kind);
      this.model?.forget(effect.taskRef);
      return;
    }
    if (effect.kind === "hostWrite") {
      if (effect.status !== "pending") throw new Error("invalidTransition");
      const marked = await this.runtime.markHostPossiblySent(callId, effectId, now);
      if (!marked.ok) throw new Error(marked.error.kind);
      if (marked.value.effects[effectId]?.status === "canceled") return;
      let receipt: HostWriteReceipt;
      try {
        receipt = await this.hostCall(signal => this.host.write(effect.mutation, now, signal));
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
      const observation = await this.hostCall(signal => this.host.reconcile(original.mutation, signal));
      const resolved = await this.runtime.acceptReconciliation(callId, effectId, observation, now);
      if (!resolved.ok) throw new Error(resolved.error.kind);
      return;
    }
    if (effect.kind === "staffReconcile") {
      if (effect.status !== "pending") throw new Error("invalidTransition");
      const original = read.value.effects[effect.originalEffectId];
      if (!original || original.kind !== "staffTask" || original.status !== "uncertain") throw new Error("effectUnknown");
      const observation = await this.hostCall(signal => this.host.reconcileTask(effect.originalItem, signal));
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
          ? await this.hostCall(signal => this.host.advanceTask!(effect.change, signal))
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
        ? await this.hostCall(signal => this.host.reconcileTaskChange!(effect.change, signal))
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
      try { receipt = await this.hostCall(signal => this.host.sendAlert!(effect.alert, signal)); }
      catch { receipt = { kind: "uncertain", alertKey: effect.alert.alertKey }; }
      const resolved = await this.runtime.acceptOperatorAlertResult(callId, effectId, receipt, now);
      if (!resolved.ok) throw new Error(resolved.error.kind);
      if (receipt.kind === "failed") throw new Error("alertDeliveryFailed");
      return;
    }
    if (effect.kind === "operatorAlertReconcile") {
      if (effect.status !== "pending" || !this.host.reconcileAlert) throw new Error("alertUnavailable");
      const observation = await this.hostCall(signal => this.host.reconcileAlert!(effect.alert, signal));
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
      receipt = await this.hostCall(signal => this.host.openTask(item, signal));
    } catch {
      receipt = { kind: "uncertain", taskKey: item.key };
    }
    const resolved = await this.runtime.acceptStaffResult(callId, effectId, receipt);
    if (!resolved.ok) throw new Error(resolved.error.kind);
  }
}
