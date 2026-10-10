import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export class BoundedCommandError extends Error {
  readonly output: string;
  constructor(message: string, output: string, cause?: unknown) {
    super(message, { cause });
    this.output = output;
  }
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

async function stopGroup(pid: number): Promise<void> {
  if (!groupExists(pid)) return;
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + 1_000;
  while (groupExists(pid) && Date.now() < deadline) await delay(25);
  if (!groupExists(pid)) return;
  signalGroup(pid, "SIGKILL");
  const killedDeadline = Date.now() + 1_000;
  while (groupExists(pid) && Date.now() < killedDeadline) await delay(25);
  if (groupExists(pid)) throw new Error("command process group did not stop");
}

/** Own the command's POSIX process group, including workers that outlive its leader. */
export async function runBoundedCommand(command: string, args: readonly string[], timeoutMs: number,
  options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
  if (process.platform === "win32") throw new Error("bounded commands require POSIX process groups");
  const child = spawn(command, [...args], { ...options, detached: true,
    stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(timeoutMs) });
  let output = "";
  let failure: unknown;
  let rejectCompletion: (error: Error) => void = () => {};
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const completion = new Promise<number | null>((resolve, reject) => {
    rejectCompletion = reject;
    child.once("error", reject);
    child.once("exit", resolve);
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    const text = chunk.toString();
    const remaining = 2_000_000 - output.length;
    output += text.slice(0, remaining);
    if (text.length > remaining && failure === undefined) {
      const error = new Error("command output limit exceeded");
      failure = error;
      rejectCompletion(error);
    }
  });
  let code: number | null = null;
  try {
    code = await completion;
    if (code !== 0) failure ??= new Error(`exited ${code}`);
  }
  catch (error) { failure ??= error; }
  finally {
    let cleaned = true;
    if (child.pid) {
      try { await stopGroup(child.pid); }
      catch (error) {
        cleaned = false;
        failure = new AggregateError(failure === undefined ? [error] : [failure, error],
          "command process cleanup failed");
      }
    }
    if (cleaned) {
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      let drained: boolean;
      try {
        drained = await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => {
          drainTimer = setTimeout(() => resolve(false), 1_000);
        })]);
      } finally { if (drainTimer) clearTimeout(drainTimer); }
      if (!drained) {
        const error = new Error("command output streams did not close after process cleanup");
        failure = new AggregateError(failure === undefined ? [error] : [failure, error],
          error.message);
        child.stdout.destroy(); child.stderr.destroy();
      }
    } else { child.stdout.destroy(); child.stderr.destroy(); }
  }
  if (failure !== undefined || code !== 0) {
    const reason = failure instanceof Error ? failure.message : `exited ${code}`;
    throw new BoundedCommandError(`${command} ${args.join(" ")} failed: ${reason}`, output, failure);
  }
  return output;
}
