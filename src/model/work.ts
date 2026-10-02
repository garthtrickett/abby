import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { ModelInput, ModelProposal } from "./proposal.ts";
import { validPriorCallerTurns } from "./proposal.ts";
import { ModelIngress } from "./proposal.ts";

const TASK_TTL_MS = 60_000;
const MAX_TRANSIENT_TASKS = 1_000;
const MAX_MODEL_TURN_CHARS = 4_000;
const MAX_PRIOR_TURNS = 3;
const HISTORY_TTL_MS = 60_000;
type CallerHistory = { turns: string[]; expiresAt: number; timer: ReturnType<typeof setTimeout> };
export type ModelTaskFailure = Readonly<{ kind: "keyMismatch" | "capacityExceeded" | "invalidInput" | "tooLong" }>;

type Task = {
  input: ModelInput;
  fingerprint: string;
  cancel: AbortController;
  answer?: Extract<ModelProposal, { kind: "answer" }>;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export function modelTaskRef(input: Pick<ModelInput, "scope" | "turn">): string {
  return createHash("sha256").update(JSON.stringify([
    input.scope.tenantId, input.scope.clinicId, input.scope.locationId, input.turn.callId, input.turn.turnId,
  ])).digest("hex");
}

function callHistoryKey(scope: ModelInput["scope"], callId: string): string {
  return createHash("sha256").update(JSON.stringify([
    scope.tenantId, scope.clinicId, scope.locationId, callId,
  ])).digest("hex");
}

/** Process-local caller words and unapproved answer text. Losing this store fails a task safely. */
export class ModelWork {
  readonly ingress: ModelIngress;
  readonly promptVersion: string;
  readonly deadlineMs: number;
  private readonly maxTasks: number;
  private readonly clock: () => number;
  private readonly tasks = new Map<string, Task>();
  private readonly histories = new Map<string, CallerHistory>();

  constructor(ingress: ModelIngress, promptVersion: string, deadlineMs = 10_000,
              maxTasks = MAX_TRANSIENT_TASKS, clock: () => number = Date.now) {
    if (!promptVersion.trim() || promptVersion.length > 128 || !Number.isSafeInteger(deadlineMs) ||
        deadlineMs < 1 || deadlineMs > 30_000 || !Number.isSafeInteger(maxTasks) || maxTasks < 1 ||
        maxTasks > MAX_TRANSIENT_TASKS || typeof clock !== "function") throw new Error("invalid model configuration");
    this.ingress = ingress;
    this.promptVersion = promptVersion;
    this.deadlineMs = deadlineMs;
    this.maxTasks = maxTasks;
    this.clock = clock;
  }

  prepare(input: ModelInput): Result<{ taskRef: string; created: boolean }, ModelTaskFailure> {
    if (!input.turn.turnId || input.turn.turnId.length > 256 || typeof input.turn.text !== "string" ||
        !input.turn.text.trim()) return err({ kind: "invalidInput" });
    if (input.turn.text.length > MAX_MODEL_TURN_CHARS) return err({ kind: "tooLong" });
    if (input.priorCallerTurns !== undefined && !validPriorCallerTurns(input.priorCallerTurns)) {
      return err({ kind: "invalidInput" });
    }
    if (!Array.isArray(input.knowledge) || input.knowledge.length > 8 ||
        input.knowledge.some(source => typeof source?.sourceRef !== "string" || !source.sourceRef.trim() ||
          source.sourceRef.length > 256 || typeof source.approvedText !== "string" ||
          !source.approvedText.trim() || source.approvedText.length > 2_000) ||
        new Set(input.knowledge.map(source => source.sourceRef)).size !== input.knowledge.length) return err({ kind: "invalidInput" });
    const taskRef = modelTaskRef(input);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = this.current(taskRef);
    if (existing) return existing.fingerprint === fingerprint ? ok({ taskRef, created: false }) : err({ kind: "keyMismatch" });
    if (this.tasks.size >= this.maxTasks) return err({ kind: "capacityExceeded" });
    const expiresAt = Date.now() + TASK_TTL_MS;
    const timer = setTimeout(() => this.forget(taskRef), TASK_TTL_MS);
    timer.unref();
    this.tasks.set(taskRef, { input: structuredClone(input), fingerprint, cancel: new AbortController(), expiresAt, timer });
    return ok({ taskRef, created: true });
  }

  private currentHistory(key: string): CallerHistory | undefined {
    const history = this.histories.get(key);
    if (history && this.clock() >= history.expiresAt) {
      clearTimeout(history.timer);
      this.histories.delete(key);
      return undefined;
    }
    return history;
  }

  priorCallerTurns(scope: ModelInput["scope"], callId: string): readonly string[] {
    return [...(this.currentHistory(callHistoryKey(scope, callId))?.turns ?? [])];
  }

  /** Records only an accepted model-routed turn, in memory for at most one minute of inactivity. */
  recordAcceptedTurn(scope: ModelInput["scope"], callId: string, text: string): void {
    if (!text.trim() || text.length > MAX_MODEL_TURN_CHARS) return;
    const key = callHistoryKey(scope, callId);
    const current = this.currentHistory(key);
    if (!current && this.histories.size >= this.maxTasks) return;
    if (current) clearTimeout(current.timer);
    const turns = [...(current?.turns ?? []), text];
    while (turns.length > MAX_PRIOR_TURNS || turns.reduce((length, turn) => length + turn.length, 0) > MAX_MODEL_TURN_CHARS) {
      turns.shift();
    }
    let entry!: CallerHistory;
    const timer = setTimeout(() => {
      if (this.histories.get(key) === entry) this.histories.delete(key);
    }, HISTORY_TTL_MS);
    timer.unref();
    entry = { turns, expiresAt: this.clock() + HISTORY_TTL_MS, timer };
    this.histories.set(key, entry);
  }

  forgetCall(scope: ModelInput["scope"], callId: string): void {
    for (const [taskRef, task] of this.tasks) {
      if (task.input.turn.callId === callId && task.input.scope.tenantId === scope.tenantId &&
          task.input.scope.clinicId === scope.clinicId && task.input.scope.locationId === scope.locationId) {
        this.forget(taskRef);
      }
    }
    const key = callHistoryKey(scope, callId);
    const current = this.histories.get(key);
    if (current) clearTimeout(current.timer);
    this.histories.delete(key);
  }

  private current(taskRef: string): Task | undefined {
    const task = this.tasks.get(taskRef);
    if (task && Date.now() >= task.expiresAt) {
      this.forget(taskRef);
      return undefined;
    }
    return task;
  }

  input(taskRef: string): ModelInput | undefined {
    const task = this.current(taskRef);
    return task ? structuredClone(task.input) : undefined;
  }

  signal(taskRef: string): AbortSignal | undefined {
    return this.current(taskRef)?.cancel.signal;
  }

  /** A qualified caller correction stops only transient model work for this exact call. */
  cancelCall(scope: ModelInput["scope"], callId: string): boolean {
    let canceled = false;
    for (const task of this.tasks.values()) {
      if (task.input.turn.callId !== callId || task.input.scope.tenantId !== scope.tenantId ||
          task.input.scope.clinicId !== scope.clinicId || task.input.scope.locationId !== scope.locationId ||
          task.cancel.signal.aborted) continue;
      task.cancel.abort();
      canceled = true;
    }
    return canceled;
  }

  rememberAnswer(taskRef: string, answer: Extract<ModelProposal, { kind: "answer" }>): boolean {
    const task = this.current(taskRef);
    if (!task) return false;
    task.answer = structuredClone(answer);
    return true;
  }

  answer(taskRef: string): Extract<ModelProposal, { kind: "answer" }> | undefined {
    const answer = this.current(taskRef)?.answer;
    return answer ? structuredClone(answer) : undefined;
  }

  forget(taskRef: string): void {
    const task = this.tasks.get(taskRef);
    if (task) {
      task.cancel.abort();
      clearTimeout(task.timer);
    }
    this.tasks.delete(taskRef);
  }
}
