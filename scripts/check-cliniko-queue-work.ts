import { fileURLToPath } from "node:url";
import { inspectClinikoQueueWork } from "../src/standalone/cliniko-queue-work-status.ts";

/** Operator-selected, read-only schedule observation; no .env values or runtime configuration are loaded here. */
export async function checkClinikoQueueWork(args: readonly string[]) {
  const names = ["name", "manager", "app-root", "node-bin", "env-file", "poll-minutes"];
  if (args.length !== names.length * 2) return { status: "unavailable" as const };
  const values: Record<string, string> = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.slice(2), value = args[index + 1];
    if (!args[index]?.startsWith("--") || !name || !names.includes(name) || Object.hasOwn(values, name) || !value)
      return { status: "unavailable" as const };
    values[name] = value;
  }
  if (!/^(?:[1-9]|[1-5][0-9]|60)$/.test(values["poll-minutes"] ?? "") ||
      (values.manager !== "user" && values.manager !== "system")) return { status: "unavailable" as const };
  return inspectClinikoQueueWork({ name: values.name!, manager: values.manager, appRoot: values["app-root"]!,
    nodeBin: values["node-bin"]!, envFile: values["env-file"]!, pollEveryMinutes: Number(values["poll-minutes"]) },
  AbortSignal.timeout(6000));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await checkClinikoQueueWork(process.argv.slice(2)).catch(() => ({ status: "unavailable" as const }));
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.status !== "recentCompletion") process.exitCode = 2;
}
