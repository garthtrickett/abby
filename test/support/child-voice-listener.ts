import type { ChildProcess } from "node:child_process";

/** Wait for this exact runner child to bind before a test routes signed traffic to it. */
export function waitForVoiceListener(child: ChildProcess, timeoutMs = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("local voice listener did not bind")); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("kind" in message) ||
          message.kind !== "listenerReady" || !("port" in message) ||
          typeof message.port !== "number" || !Number.isInteger(message.port) ||
          message.port < 1 || message.port > 65_535) return;
      cleanup();
      resolve(message.port);
    };
    const onExit = () => { cleanup(); reject(new Error("local voice listener exited before binding")); };
    child.on("message", onMessage);
    child.on("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}
