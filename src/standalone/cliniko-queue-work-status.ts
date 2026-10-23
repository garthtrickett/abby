import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

export type QueueWorkSelection = Readonly<{ name: string; manager: "user" | "system"; appRoot: string;
  nodeBin: string; envFile: string; pollEveryMinutes: number }>;
export type QueueWorkStatus = "recentCompletion" | "neverCompleted" | "pending" | "running" | "stalled" |
  "missed" | "disabled" | "failed" | "unavailable";
export type QueueWorkSource = Readonly<{ properties: string; timerTrigger: string }>;
export type QueueWorkPorts = Readonly<{
  read(selection: QueueWorkSelection, signal: AbortSignal): Promise<QueueWorkSource>;
  nowMicros(): bigint;
}>;

const properties = ["Id", "LoadState", "ActiveState", "SubState", "Type", "RemainAfterExit", "SuccessExitStatus",
  "Result", "ExecMainCode", "ExecMainStatus", "MainPID", "ExecMainPID", "ExecMainStartTimestampMonotonic", "ExecMainExitTimestampMonotonic",
  "ExecStart", "WorkingDirectory", "Job", "NeedDaemonReload", "DropInPaths", "ConditionResult", "AssertResult",
  "InvocationID", "InactiveEnterTimestampMonotonic", "InactiveExitTimestampMonotonic", "Unit", "Triggers"] as const;
const keys = new Set<string>(properties);
const path = (s: unknown): s is string => typeof s === "string" && s.length <= 512 &&
  /^\/[A-Za-z0-9_./-]+$/.test(s) && !s.includes("..") && resolve(s) === s;
const uint = (s: string | undefined) => typeof s === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(s)
  && BigInt(s) <= 18446744073709551615n ? BigInt(s) : undefined;
const runtimeMicros = 210_000_000n;
const failures = new Set(["resources", "timeout", "exit-code", "signal", "core-dump", "watchdog",
  "start-limit-hit", "protocol", "oom-kill"]);
const command = promisify(execFile);

async function readNative(c: QueueWorkSelection, signal: AbortSignal): Promise<QueueWorkSource> {
  const service = c.name + ".service", timer = c.name + ".timer";
  const prefix = c.manager === "user" ? ["--user"] : [];
  const options = { signal, timeout: 2000, maxBuffer: 24_576, encoding: "utf8" as const };
  const values = await command("/usr/bin/systemctl", [...prefix, "--no-pager", "show", "--all",
    "--property=" + properties.join(","), service, timer], options);
  // Unit names are restricted below; systemd's object-label escaping is byte-exact for these ASCII names.
  const object = "/org/freedesktop/systemd1/unit/" + timer.replace(/[^A-Za-z0-9]/g,
    s => "_" + s.charCodeAt(0).toString(16).padStart(2, "0"));
  const trigger = await command("/usr/bin/busctl", [...prefix, "--no-pager", "get-property",
    "org.freedesktop.systemd1", object, "org.freedesktop.systemd1.Timer", "LastTriggerUSecMonotonic"], options);
  return { properties: values.stdout, timerTrigger: trigger.stdout };
}

function decode(source: QueueWorkSource, c: QueueWorkSelection) {
  if (!source || typeof source.properties !== "string" || Buffer.byteLength(source.properties) > 24_576 ||
      typeof source.timerTrigger !== "string" || source.timerTrigger.length > 64 ||
      !/^t (?:0|[1-9][0-9]{0,19})\n?$/.test(source.timerTrigger)) throw Error();
  const blocks = source.properties.trim().split(/\n\n/);
  if (blocks.length !== 2) throw Error();
  const decoded = blocks.map(block => {
    const row: Record<string, string> = Object.create(null);
    for (const line of block.split("\n")) {
      const at = line.indexOf("="), key = line.slice(0, at), value = line.slice(at + 1);
      if (at < 1 || !keys.has(key) || Object.hasOwn(row, key) || /[\r\0]/.test(value)) throw Error();
      row[key] = value;
    }
    return row;
  });
  const service = decoded.find(row => row.Id === c.name + ".service"), timer = decoded.find(row => row.Id === c.name + ".timer");
  const trigger = uint(source.timerTrigger.trim().slice(2));
  if (!service || !timer || service === timer || trigger === undefined) throw Error();
  const requiredService = ["ActiveState", "SubState", "Type", "RemainAfterExit", "SuccessExitStatus", "Result",
    "ExecMainCode", "ExecMainStatus", "MainPID", "ExecMainPID", "ExecStart", "WorkingDirectory", "Job", "ConditionResult", "AssertResult",
    "InvocationID", "InactiveEnterTimestampMonotonic", "InactiveExitTimestampMonotonic"];
  const requiredTimer = ["ActiveState", "SubState", "Job", "Unit", "Triggers"];
  if (requiredService.some(key => !Object.hasOwn(service, key)) || requiredTimer.some(key => !Object.hasOwn(timer, key))) throw Error();
  for (const row of [service, timer]) {
    if (row.LoadState !== "loaded" || row.DropInPaths !== "" || row.NeedDaemonReload !== "no") throw Error();
  }
  if (service.Type !== "oneshot" || service.RemainAfterExit !== "no" || service.SuccessExitStatus !== "" ||
      service.WorkingDirectory !== c.appRoot || timer.Unit !== service.Id || timer.Triggers !== service.Id) throw Error();
  const prefix = "{ path=" + c.nodeBin + " ; argv[]=" + c.nodeBin + " --env-file=" + c.envFile + " " +
    c.appRoot + "/dist/runtime/scripts/monitor-cliniko-queue.js ; ignore_errors=no ; ";
  if (!service.ExecStart?.startsWith(prefix) || !service.ExecStart.endsWith(" }") ||
      /[{}\n]/.test(service.ExecStart.slice(prefix.length, -2))) throw Error();
  const start = uint(service.ExecMainStartTimestampMonotonic), end = uint(service.ExecMainExitTimestampMonotonic);
  const activation = uint(service.InactiveExitTimestampMonotonic);
  const currentPid = uint(service.MainPID), lastMainPid = uint(service.ExecMainPID);
  if (start === undefined || end === undefined || activation === undefined || currentPid === undefined ||
      lastMainPid === undefined || currentPid > 4294967295n || lastMainPid > 4294967295n) throw Error();
  const stable = JSON.stringify(decoded.map(row => Object.entries(row).sort()).sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)))) + ":" + trigger;
  return { service, timer, start, end, activation, currentPid, lastMainPid, trigger, stable };
}

/** Fixed selected systemd queue command only. No persistence, provider read, alert send, mutation or clinic-readiness claim.
 * The native clock is explicitly supported on the qualified Linux/Node22.23.0/libuv1.51.0 build: uv_hrtime uses CLOCK_MONOTONIC.
 * Missing/stalled/contradictory reads stay unavailable; even a prior success cannot certify a new pending/running invocation. */
export async function inspectClinikoQueueWork(input: QueueWorkSelection, external: AbortSignal,
  injected?: QueueWorkPorts): Promise<Readonly<{ status: QueueWorkStatus }>> {
  if (!(external instanceof AbortSignal) || external.aborted) return { status: "unavailable" };
  const began = performance.now(), controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 5000);
  const signal = AbortSignal.any([external, controller.signal]);
  try {
    const c = Object.freeze({ ...input });
    if (Object.keys(c).sort().join(",") !== "appRoot,envFile,manager,name,nodeBin,pollEveryMinutes" ||
        typeof c.name !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(c.name) ||
        !["user", "system"].includes(c.manager) || ![c.appRoot, c.nodeBin, c.envFile].every(path) ||
        !Number.isSafeInteger(c.pollEveryMinutes) || c.pollEveryMinutes < 1 || c.pollEveryMinutes > 60) throw Error();
    if (!injected && (process.platform !== "linux" || process.version !== "v22.23.0" || process.versions.uv !== "1.51.0")) throw Error();
    const ports = injected ?? { read: readNative, nowMicros: () => process.hrtime.bigint() / 1000n };
    const read = ports.read.bind(ports), nowMicros = ports.nowMicros.bind(ports);
    let last = -1n;
    const now = () => {
      const value = nowMicros();
      if (signal.aborted || performance.now() - began > 5000 || typeof value !== "bigint" || value < 0n || value < last) throw Error();
      last = value; return value;
    };
    now();
    const first = await awaitUntilAbort(Promise.resolve().then(() => read(c, signal)), signal);
    if (!first) throw Error();
    const a = decode({ properties: first.properties, timerTrigger: first.timerTrigger }, c); now();
    const second = await awaitUntilAbort(Promise.resolve().then(() => read(c, signal)), signal);
    if (!second) throw Error();
    const b = decode({ properties: second.properties, timerTrigger: second.timerTrigger }, c), at = now();
    if (a.stable !== b.stable || b.start > at || b.end > at || b.activation > at || b.trigger > at) throw Error();
    const { service: s, timer: t, start, end, activation, currentPid, lastMainPid, trigger } = b;
    if (!["active", "inactive", "failed", "activating", "deactivating"].includes(t.ActiveState ?? "") ||
        !["active", "inactive", "failed", "activating", "deactivating"].includes(s.ActiveState ?? "")) throw Error();
    if (![s.Job!, t.Job!].every(value => /^(?:|[1-9][0-9]{0,19})$/.test(value)) ||
        (s.Result !== "success" && !failures.has(s.Result!))) throw Error();
    if (t.ActiveState !== "active" || t.SubState === "elapsed") return { status: "disabled" };
    if (!["waiting", "running"].includes(t.SubState!)) throw Error();
    if (s.Result !== "success" || s.ActiveState === "failed") return { status: "failed" };
    if (s.ActiveState === "activating" || s.ActiveState === "active") {
      if (start === 0n || currentPid === 0n) return { status: trigger > 0n && at - trigger > runtimeMicros ? "missed" : "pending" };
      if (activation === 0n || currentPid !== lastMainPid) throw Error();
      if (!/^[a-f0-9]{32}$/.test(s.InvocationID!)) throw Error();
      return { status: at - start > runtimeMicros ? "stalled" : "running" };
    }
    if (t.Job !== "" || s.Job !== "") return { status: trigger > 0n && at - trigger > runtimeMicros ? "missed" : "pending" };
    if (t.SubState !== "waiting" || s.ActiveState !== "inactive" || s.SubState !== "dead") throw Error();
    if (start === 0n && end === 0n) return { status: trigger === 0n ? "neverCompleted" : at - trigger > runtimeMicros ? "missed" : "pending" };
    const inactive = uint(s.InactiveEnterTimestampMonotonic);
    // systemd spawns a oneshot main before publishing activation. Completion, not fork start, follows that notification.
    if (activation === 0n || end < activation || currentPid !== 0n || lastMainPid === 0n || start === 0n ||
        end < start || inactive === undefined || inactive < end || inactive > at ||
        s.ConditionResult !== "yes" || s.AssertResult !== "yes" || !/^[a-f0-9]{32}$/.test(s.InvocationID ?? "")) throw Error();
    if (s.ExecMainCode !== "1" || s.ExecMainStatus !== "0") return { status: "failed" };
    if (trigger === 0n || trigger > start || start - trigger > runtimeMicros || end - start > runtimeMicros)
      return { status: "missed" };
    return { status: at - end <= BigInt(c.pollEveryMinutes) * 60_000_000n + runtimeMicros ? "recentCompletion" : "missed" };
  } catch { return { status: "unavailable" }; }
  finally { clearTimeout(deadline); controller.abort(); }
}
