import { stat, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

const fields = new Set(["app-root", "node-bin", "env-file", "service-user", "name", "out-dir"]);
const safePath = /^\/[A-Za-z0-9_./-]+$/;
const profiles = {
  alert: { script: "send-voice-operational-alerts.ts", description: "aggregate voice alert sender",
    schedule: "*:0/15", timeout: "30s", delay: "RandomizedDelaySec=30s\n" },
  retention: { script: "prune-voice-operations.ts", description: "aggregate voice retention cleanup",
    schedule: "*-*-* 00:00:00 UTC", timeout: "2min", delay: "AccuracySec=1s\n" },
  queue: { script: "dist/runtime/scripts/monitor-cliniko-queue.js", description: "approved Cliniko queue monitor",
    timeout: "210s", delay: "AccuracySec=1s\n" },
};

function options(argv, kind) {
  const allowed = kind === "queue" ? new Set([...fields, "poll-minutes"]) : fields;
  if (argv.length !== allowed.size * 2) throw new RangeError("invalid systemd render arguments");
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!argv[index]?.startsWith("--") || !allowed.has(key) || !value || parsed[key]) {
      throw new RangeError("invalid systemd render arguments");
    }
    parsed[key] = value;
  }
  if (kind === "queue" && !/^(?:[1-9]|[1-5][0-9]|60)$/.test(parsed["poll-minutes"])) throw new RangeError("invalid systemd render arguments");
  if ([parsed["app-root"], parsed["node-bin"], parsed["env-file"], parsed["out-dir"]]
    .some(value => !safePath.test(value) || value.includes("..")) ||
    !/^[a-z_][a-z0-9_-]{0,63}$/.test(parsed["service-user"]) ||
    !/^[a-z][a-z0-9-]{0,47}$/.test(parsed.name)) {
    throw new RangeError("invalid systemd render arguments");
  }
  return parsed;
}

/** Render only paths and a service identity; the owner-only config value never enters a unit. */
export async function renderVoiceOpsSystemd(argv, kind) {
  const profile = profiles[kind];
  if (!profile) throw new RangeError("invalid systemd task");
  const selected = options(argv, kind);
  const taskPath = kind === "queue" ? profile.script : `scripts/${profile.script}`;
  const [app, node, config, task] = await Promise.all([
    stat(selected["app-root"]), stat(selected["node-bin"]), stat(selected["env-file"]),
    stat(join(selected["app-root"], taskPath)),
  ]);
  if (!app.isDirectory() || !node.isFile() || !(node.mode & 0o111) ||
      !config.isFile() || (config.mode & 0o077) !== 0 || !task.isFile()) {
    throw new RangeError("systemd task source unavailable");
  }
  const name = selected.name;
  const cadence = kind === "queue" ? `Environment=ABBY_CLINIKO_QUEUE_POLL_MINUTES=${selected["poll-minutes"]}\n` : "";
  const schedule = kind === "queue" ? `*:0/${selected["poll-minutes"]} UTC` : profile.schedule;
  const service = `[Unit]\nDescription=Abby ${profile.description} (${name})\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=oneshot\nUser=${selected["service-user"]}\nWorkingDirectory=${selected["app-root"]}\n${cadence}ExecStart=${selected["node-bin"]} --env-file=${selected["env-file"]} ${selected["app-root"]}/${taskPath}\nTimeoutStartSec=${profile.timeout}\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\n`;
  const timer = `[Unit]\nDescription=Schedule Abby ${profile.description} (${name})\n\n[Timer]\nOnCalendar=${schedule}\nPersistent=true\n${profile.delay}Unit=${name}.service\n\n[Install]\nWantedBy=timers.target\n`;
  await mkdir(selected["out-dir"], { recursive: true, mode: 0o700 });
  const servicePath = join(selected["out-dir"], `${name}.service`);
  const timerPath = join(selected["out-dir"], `${name}.timer`);
  await writeFile(servicePath, service, { flag: "wx", mode: 0o600 });
  try { await writeFile(timerPath, timer, { flag: "wx", mode: 0o600 }); }
  catch (error) { await unlink(servicePath); throw error; }
  return { service: `${name}.service`, timer: `${name}.timer` };
}
