import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { ModelInput, ModelProposal } from "./proposal.ts";
import { ModelIngress } from "./proposal.ts";

const TASK_TTL_MS = 60_000;
const MAX_TRANSIENT_TASKS = 1_000;
const MAX_MODEL_TURN_CHARS = 4_000;
export type ModelTaskFailure = Readonly<{ kind: "keyMismatch" | "capacityExceeded" | "invalidInput" | "tooLong" }>;

type Task = {
  input: ModelInput;
  fingerprint: string;
  answer?: Extract<ModelProposal, { kind: "answer" }>;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export function modelTaskRef(input: Pick<ModelInput, "scope" | "turn">): string {
  return createHash("sha256").update(JSON.stringify([
    input.scope.tenantId, input.scope.clinicId, input.scope.locationId, input.turn.callId, input.turn.turnId,
  ])).digest("hex");
}

/** Process-local caller words and unapproved answer text. Losing this store fails a task safely. */
export class ModelWork {
  readonly ingress: ModelIngress;
  readonly promptVersion: string;
  readonly deadlineMs: number;
  private readonly maxTasks: number;
  private readonly tasks = new Map<string, Task>();

  constructor(ingress: ModelIngress, promptVersion: string, deadlineMs = 10_000, maxTasks = MAX_TRANSIENT_TASKS) {
    if (!promptVersion.trim() || promptVersion.length > 128 || !Number.isSafeInteger(deadlineMs) ||
        deadlineMs < 1 || deadlineMs > 30_000 || !Number.isSafeInteger(maxTasks) || maxTasks < 1 ||
        maxTasks > MAX_TRANSIENT_TASKS) throw new Error("invalid model configuration");
    this.ingress = ingress;
    this.promptVersion = promptVersion;
    this.deadlineMs = deadlineMs;
    this.maxTasks = maxTasks;
  }

  prepare(input: ModelInput): Result<{ taskRef: string; created: boolean }, ModelTaskFailure> {
    if (!input.turn.turnId || input.turn.turnId.length > 256 || typeof input.turn.text !== "string" ||
        !input.turn.text.trim()) return err({ kind: "invalidInput" });
    if (input.turn.text.length > MAX_MODEL_TURN_CHARS) return err({ kind: "tooLong" });
    const taskRef = modelTaskRef(input);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = this.current(taskRef);
    if (existing) return existing.fingerprint === fingerprint ? ok({ taskRef, created: false }) : err({ kind: "keyMismatch" });
    if (this.tasks.size >= this.maxTasks) return err({ kind: "capacityExceeded" });
    const expiresAt = Date.now() + TASK_TTL_MS;
    const timer = setTimeout(() => this.tasks.delete(taskRef), TASK_TTL_MS);
    timer.unref();
    this.tasks.set(taskRef, { input: structuredClone(input), fingerprint, expiresAt, timer });
    return ok({ taskRef, created: true });
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
    if (task) clearTimeout(task.timer);
    this.tasks.delete(taskRef);
  }
}
