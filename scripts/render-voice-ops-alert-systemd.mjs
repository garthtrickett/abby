import { stat, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fields = new Set(["app-root", "node-bin", "env-file", "service-user", "name", "out-dir"]);
const safePath = /^\/[A-Za-z0-9_./-]+$/;

function options(argv) {
  if (argv.length !== fields.size * 2) throw new RangeError("invalid systemd render arguments");
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!argv[index]?.startsWith("--") || !fields.has(key) || !value || parsed[key]) {
      throw new RangeError("invalid systemd render arguments");
    }
    parsed[key] = value;
  }
  if ([parsed["app-root"], parsed["node-bin"], parsed["env-file"], parsed["out-dir"]]
    .some(value => !safePath.test(value) || value.includes("..")) ||
    !/^[a-z_][a-z0-9_-]{0,63}$/.test(parsed["service-user"]) ||
    !/^[a-z][a-z0-9-]{0,47}$/.test(parsed.name)) {
    throw new RangeError("invalid systemd render arguments");
  }
  return parsed;
}

/** Render only paths and a service identity; the owner-only config value never enters a unit. */
export async function renderVoiceOpsAlertSystemd(argv) {
  const selected = options(argv);
  const [app, node, config, sender] = await Promise.all([
    stat(selected["app-root"]), stat(selected["node-bin"]), stat(selected["env-file"]),
    stat(join(selected["app-root"], "scripts/send-voice-operational-alerts.ts")),
  ]);
  if (!app.isDirectory() || !node.isFile() || !(node.mode & 0o111) ||
      !config.isFile() || (config.mode & 0o077) !== 0 || !sender.isFile()) {
    throw new RangeError("systemd alert source unavailable");
  }
  const name = selected.name;
  const service = `[Unit]\nDescription=Abby aggregate voice alert sender (${name})\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=oneshot\nUser=${selected["service-user"]}\nWorkingDirectory=${selected["app-root"]}\nExecStart=${selected["node-bin"]} --env-file=${selected["env-file"]} ${selected["app-root"]}/scripts/send-voice-operational-alerts.ts\nTimeoutStartSec=30s\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\n`;
  const timer = `[Unit]\nDescription=Schedule Abby aggregate voice alerts (${name})\n\n[Timer]\nOnCalendar=*:0/15\nPersistent=true\nRandomizedDelaySec=30s\nUnit=${name}.service\n\n[Install]\nWantedBy=timers.target\n`;
  await mkdir(selected["out-dir"], { recursive: true, mode: 0o700 });
  const servicePath = join(selected["out-dir"], `${name}.service`);
  const timerPath = join(selected["out-dir"], `${name}.timer`);
  await writeFile(servicePath, service, { flag: "wx", mode: 0o600 });
  try { await writeFile(timerPath, timer, { flag: "wx", mode: 0o600 }); }
  catch (error) { await unlink(servicePath); throw error; }
  return { service: `${name}.service`, timer: `${name}.timer` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await renderVoiceOpsAlertSystemd(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("operational alert systemd units unavailable\n");
    process.exitCode = 1;
  }
}
