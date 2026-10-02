import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { test as base, expect } from "@playwright/test";

export { expect };

const gate = process.env.ABBY_BROWSER_ORDER_GATE;

/** Ordinary runs use the original fixtures; ordered runs warm the browser before releasing the case. */
export const test: typeof base = gate ? base.extend<{ schedulingGate: void }>({
  schedulingGate: [async ({ page, request }, use, info) => {
    void page; void request;
    const event = { file: relative(process.cwd(), info.file), line: info.line, title: info.title };
    process.stdout.write(`ABBY_BROWSER_EVENT ${JSON.stringify({ kind: "ready", ...event })}\n`);
    const deadline = Date.now() + info.timeout;
    while (true) {
      let permit;
      try { permit = await readFile(gate, "utf8"); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      if (permit !== undefined) {
        if (permit !== "run\n") throw new Error("invalid browser scheduling permit");
        break;
      }
      if (Date.now() >= deadline) throw new Error("browser scheduling permit timed out");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    process.stdout.write(`ABBY_BROWSER_EVENT ${JSON.stringify({ kind: "started", ...event })}\n`);
    await use();
  }, { auto: true }],
}) : base;
