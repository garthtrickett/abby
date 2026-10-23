import assert from "node:assert/strict";
import test from "node:test";
import { inspectClinikoQueueWork } from "../../src/standalone/cliniko-queue-work-status.ts";
import type { QueueWorkSelection, QueueWorkSource, QueueWorkPorts, QueueWorkStatus } from "../../src/standalone/cliniko-queue-work-status.ts";
import { checkClinikoQueueWork } from "../../scripts/check-cliniko-queue-work.ts";

const selected: QueueWorkSelection = { name: "abby-queue-example", manager: "user", appRoot: "/srv/abby",
  nodeBin: "/opt/node/bin/node", envFile: "/etc/abby/queue.env", pollEveryMinutes: 15 };
function source(service: Record<string, string> = {}, timer: Record<string, string> = {}, trigger = "t 100000000\n"): QueueWorkSource {
  const s = { Id: selected.name + ".service", LoadState: "loaded", ActiveState: "inactive", SubState: "dead",
    Type: "oneshot", RemainAfterExit: "no", SuccessExitStatus: "", Result: "success", ExecMainCode: "1", ExecMainStatus: "0", MainPID: "0", ExecMainPID: "10",
    ExecMainStartTimestampMonotonic: "101000000", ExecMainExitTimestampMonotonic: "102000000",
    ExecStart: "{ path=/opt/node/bin/node ; argv[]=/opt/node/bin/node --env-file=/etc/abby/queue.env /srv/abby/dist/runtime/scripts/monitor-cliniko-queue.js ; ignore_errors=no ; start_time=[test] ; stop_time=[test] ; pid=10 ; code=exited ; status=0 }",
    WorkingDirectory: "/srv/abby", Job: "", NeedDaemonReload: "no", DropInPaths: "", ConditionResult: "yes", AssertResult: "yes",
    InvocationID: "a".repeat(32), InactiveEnterTimestampMonotonic: "102000001", InactiveExitTimestampMonotonic: "100500000", ...service };
  const t = { Id: selected.name + ".timer", LoadState: "loaded", ActiveState: "active", SubState: "waiting",
    Unit: selected.name + ".service", Triggers: selected.name + ".service", Job: "", NeedDaemonReload: "no", DropInPaths: "", ...timer };
  const block = (row: Record<string, string>) => Object.entries(row).map(([key, value]) => key + "=" + value).join("\n");
  return { properties: block(s) + "\n\n" + block(t) + "\n", timerTrigger: trigger };
}
async function inspect(value = source(), at = 103000000n, changes?: QueueWorkSource, elapsedUpper = at) {
  let calls = 0;
  const ports: QueueWorkPorts = { read: async selection => {
    assert.deepEqual(selection, selected); calls++; return calls === 2 && changes ? changes : value;
  }, nowMicros: () => at, elapsedUpperMicros: () => elapsedUpper };
  const result = await inspectClinikoQueueWork(selected, new AbortController().signal, ports);
  return { result, calls };
}

test("E2E-220 R23 selected scheduled command needs two stable successful exit observations, not process UP", async () => {
  assert.deepEqual(await inspect(), { result: { status: "recentCompletion" }, calls: 2 });
});

for (const [label, service, timer, at, trigger, expected] of [
  ["boot defaults", { ExecMainCode: "0", ExecMainStartTimestampMonotonic: "0", ExecMainExitTimestampMonotonic: "0",
    InvocationID: "", ConditionResult: "no", AssertResult: "no", InactiveEnterTimestampMonotonic: "0" }, {}, 103000000n, "t 0\n", "neverCompleted"],
  ["queued new invocation", { Job: "12" }, {}, 103000000n, "t 100000000\n", "pending"],
  ["new running invocation over old success", { ActiveState: "activating", SubState: "start", Job: "12",
    ExecMainStartTimestampMonotonic: "103000000", MainPID: "11", ExecMainPID: "11" }, { SubState: "running" }, 104000000n, "t 102999999\n", "running"],
  ["started but stalled", { ActiveState: "activating", SubState: "start", Job: "12",
    ExecMainStartTimestampMonotonic: "103000000", MainPID: "11", ExecMainPID: "11" }, { SubState: "running" }, 313000001n, "t 102999999\n", "stalled"],
  ["missed next work", {}, {}, 1212000001n, "t 100000000\n", "missed"],
  ["deadline edge is inclusive", {}, {}, 1212000000n, "t 100000000\n", "recentCompletion"],
  ["disabled timer", {}, { ActiveState: "inactive", SubState: "dead" }, 103000000n, "t 100000000\n", "disabled"],
  ["elapsed timer", {}, { SubState: "elapsed" }, 103000000n, "t 100000000\n", "disabled"],
  ["failed service", { Result: "exit-code", ExecMainStatus: "2", ActiveState: "failed", SubState: "failed" }, {}, 103000000n, "t 100000000\n", "failed"],
  ["killed process despite reset success", { ExecMainCode: "2", ExecMainStatus: "15" }, {}, 103000000n, "t 100000000\n", "failed"],
  ["manual run without timer", {}, {}, 103000000n, "t 0\n", "missed"],
  ["later trigger cannot inherit prior completion", {}, {}, 104000000n, "t 103000000\n", "missed"],
  ["unstarted triggered work", { ExecMainCode: "0", ExecMainStartTimestampMonotonic: "0", ExecMainExitTimestampMonotonic: "0",
    InvocationID: "", ConditionResult: "no", AssertResult: "no", InactiveEnterTimestampMonotonic: "0" }, {}, 103000000n, "t 102999999\n", "pending"],
  ["missed triggered work", { ExecMainCode: "0", ExecMainStartTimestampMonotonic: "0", ExecMainExitTimestampMonotonic: "0",
    InvocationID: "", ConditionResult: "no", AssertResult: "no", InactiveEnterTimestampMonotonic: "0" }, {}, 314000000n, "t 102999999\n", "missed"],
] as readonly (readonly [string, Record<string, string>, Record<string, string>, bigint, string, QueueWorkStatus])[]) {
  test("E2E-220 R23 " + label + " retains its distinct work status", async () => {
    assert.deepEqual((await inspect(source(service, timer, trigger), at)).result, { status: expected });
  });
}

for (const [label, service, timer, trigger] of [
  ["foreign command", { ExecStart: source().properties.split("\n").find(line => line.startsWith("ExecStart="))!.slice(10).replace("monitor-cliniko-queue.js", "other.js") }, {}, "t 100000000\n"],
  ["ignored exit", { ExecStart: source().properties.split("\n").find(line => line.startsWith("ExecStart="))!.slice(10).replace("ignore_errors=no", "ignore_errors=yes") }, {}, "t 100000000\n"],
  ["drop-in", { DropInPaths: "/etc/private-override.conf" }, {}, "t 100000000\n"],
  ["reload needed", { NeedDaemonReload: "yes" }, {}, "t 100000000\n"],
  ["wrong directory", { WorkingDirectory: "/srv/other" }, {}, "t 100000000\n"],
  ["retained active profile", { RemainAfterExit: "yes" }, {}, "t 100000000\n"],
  ["custom success exit", { SuccessExitStatus: "2" }, {}, "t 100000000\n"],
  ["unknown result", { Result: "private error canary" }, {}, "t 100000000\n"],
  ["unmatched current main PID", { ActiveState: "activating", SubState: "start", MainPID: "11", ExecMainPID: "10" }, { SubState: "running" }, "t 100000000\n"],
  ["old successful main after a newer unit activation", { InactiveExitTimestampMonotonic: "102500000", InvocationID: "b".repeat(32) }, {}, "t 100000000\n"],
  ["condition skipped over old success", { ConditionResult: "no" }, {}, "t 100000000\n"],
  ["future exit", { ExecMainExitTimestampMonotonic: "104000000" }, {}, "t 100000000\n"],
  ["exit before start", { ExecMainExitTimestampMonotonic: "100000000" }, {}, "t 100000000\n"],
  ["foreign timer target", {}, { Unit: "other.service" }, "t 100000000\n"],
  ["contradictory trigger target", {}, { Triggers: "other.service" }, "t 100000000\n"],
  ["timer override", {}, { DropInPaths: "/etc/private-override.conf" }, "t 100000000\n"],
  ["malformed trigger", {}, {}, "t 10.2\n"],
  ["future trigger", {}, {}, "t 104000000\n"],
] as readonly (readonly [string, Record<string, string>, Record<string, string>, string])[]) {
  test("E2E-220 R23 " + label + " cannot certify selected completed work", async () => {
    assert.deepEqual((await inspect(source(service, timer, trigger))).result, { status: "unavailable" });
  });
}

test("E2E-220 R23 a new activation waiting for its own main is pending despite old process success", async () => {
  const value = source({ ActiveState: "activating", SubState: "start", Job: "12",
    InactiveExitTimestampMonotonic: "103000000", InvocationID: "b".repeat(32) }, { SubState: "running" }, "t 102999999\n");
  assert.deepEqual((await inspect(value, 104000000n)).result, { status: "pending" });
});

test("E2E-220 R23 a real oneshot can start before its activation notification and complete afterward", async () => {
  assert.deepEqual((await inspect(source({ ExecMainStartTimestampMonotonic: "100499855" }))).result, { status: "recentCompletion" });
  assert.deepEqual((await inspect(source({ ActiveState: "activating", SubState: "start", Job: "12",
    ExecMainStartTimestampMonotonic: "103000000", InactiveExitTimestampMonotonic: "103000145",
    MainPID: "11", ExecMainPID: "11" }, { SubState: "running" }, "t 102999999\n"), 104000000n)).result, { status: "running" });
});

test("E2E-220 R23 missing or duplicate required metadata and extra records are unavailable", async () => {
  const good = source();
  for (const key of ["Job", "Result", "InvocationID", "ExecMainCode", "ExecMainStatus", "MainPID", "ExecMainPID", "ExecMainStartTimestampMonotonic",
    "ExecMainExitTimestampMonotonic", "InactiveEnterTimestampMonotonic", "InactiveExitTimestampMonotonic", "ConditionResult", "AssertResult"]) {
    const properties = good.properties.split("\n").filter(line => !line.startsWith(key + "=")).join("\n");
    assert.deepEqual((await inspect({ ...good, properties })).result, { status: "unavailable" }, key);
  }
  for (const properties of [good.properties.replace("Id=", "Id=x\nId="), good.properties + "\nId=extra.service\n",
    good.properties.replace("Id=", "Environment=private-data-canary\nId="), good.properties.repeat(20)]) {
    assert.deepEqual((await inspect({ ...good, properties })).result, { status: "unavailable" });
  }
});

test("E2E-220 R23 changed second observation and a backward monotonic clock cannot publish old success", async () => {
  assert.deepEqual((await inspect(source(), 103000000n, source({ Job: "12" }))).result, { status: "unavailable" });
  let tick = 103000000n;
  assert.deepEqual(await inspectClinikoQueueWork(selected, new AbortController().signal,
    { read: async () => source(), nowMicros: () => tick--, elapsedUpperMicros: () => 103000000n }), { status: "unavailable" });
});

test("E2E-220 R23 invalid selection and already-cancelled checks never start a source read", async () => {
  let calls = 0;
  const ports = { read: async () => { calls++; return source(); }, nowMicros: () => 103000000n, elapsedUpperMicros: () => 103000000n };
  for (const patch of [{ name: "../other" }, { pollEveryMinutes: 0 }, { pollEveryMinutes: 61 }, { appRoot: "/srv/../abby" },
    { envFile: "/etc/a\nprivate" }, { nodeBin: "node" }]) {
    assert.deepEqual(await inspectClinikoQueueWork({ ...selected, ...patch }, new AbortController().signal, ports), { status: "unavailable" });
  }
  const stop = new AbortController(); stop.abort();
  assert.deepEqual(await inspectClinikoQueueWork(selected, stop.signal, ports), { status: "unavailable" });
  assert.equal(calls, 0);
});

test("E2E-220 R23 held read ignores cancellation but cannot delay the caller or publish a late completion", async () => {
  let entered!: () => void, finish!: (value: QueueWorkSource) => void, calls = 0;
  const began = new Promise<void>(resolve => { entered = resolve; }), stop = new AbortController();
  const waiting = inspectClinikoQueueWork(selected, stop.signal, { read: async () => {
    calls++; entered(); return new Promise(resolve => { finish = resolve; });
  }, nowMicros: () => 103000000n, elapsedUpperMicros: () => 103000000n });
  await began; stop.abort();
  assert.deepEqual(await waiting, { status: "unavailable" }); finish(source()); await Promise.resolve(); assert.equal(calls, 1);
});

test("E2E-220 R23 source failures and invalid CLI input emit only fixed status, never private errors or paths", async () => {
  const result = await inspectClinikoQueueWork(selected, new AbortController().signal, {
    read: async () => { throw Error("private-error-patient-canary"); }, nowMicros: () => 103000000n, elapsedUpperMicros: () => 103000000n });
  assert.deepEqual(result, { status: "unavailable" }); assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(await checkClinikoQueueWork(["--name", "private-argument-canary"]), { status: "unavailable" });
});

test("E2E-220 R23 ignored source signal is bounded by the independent five-second observation deadline", { timeout: 8000 }, async () => {
  const began = performance.now();
  const result = await inspectClinikoQueueWork(selected, new AbortController().signal, {
    read: async () => new Promise<QueueWorkSource>(() => {}), nowMicros: () => 103000000n, elapsedUpperMicros: () => 103000000n });
  assert.deepEqual(result, { status: "unavailable" });
  assert.ok(performance.now() - began >= 4500); assert.ok(performance.now() - began < 7500);
});

test("E2E-220 R23 suspend-inclusive upper age refuses a falsely fresh completed command", async () => {
  assert.deepEqual((await inspect(source(), 103000000n, undefined, 3_703000000n)).result, { status: "unavailable" });
  assert.deepEqual((await inspect(source(), 103000000n, undefined, 1212000000n)).result, { status: "recentCompletion" });
  assert.deepEqual((await inspect(source(), 103000000n, undefined, 1212000001n)).result, { status: "unavailable" });
  assert.deepEqual((await inspect(source(), 1212000001n, undefined, 4_812000001n)).result, { status: "missed" });
});

test("E2E-220 R23 suspension cannot certify pending or running work within its age bound", async () => {
  assert.deepEqual((await inspect(source({ Job: "12" }), 103000000n, undefined, 3_703000000n)).result, { status: "unavailable" });
  const running = source({ ActiveState: "activating", SubState: "start", MainPID: "11", ExecMainPID: "11" }, { SubState: "running" });
  assert.deepEqual((await inspect(running, 103000000n, undefined, 3_703000000n)).result, { status: "unavailable" });
});

test("E2E-220 R23 missing or contradictory elapsed-clock bounds stay unavailable", async () => {
  for (const elapsed of [-1n, 102999999n, 18446744073709551616n])
    assert.deepEqual((await inspect(source(), 103000000n, undefined, elapsed)).result, { status: "unavailable" });
  assert.deepEqual(await inspectClinikoQueueWork(selected, new AbortController().signal, {
    read: async () => source(), nowMicros: () => 103000000n,
    elapsedUpperMicros: () => { throw Error("private-clock-source-canary"); } }), { status: "unavailable" });
});

test("E2E-220 R23 a suspended or backward elapsed observation cannot outlive the whole-check bound", async () => {
  for (const [first, second] of [[103000000n, 109000000n], [104000000n, 103000000n]]) {
    let clocks = 0;
    assert.deepEqual(await inspectClinikoQueueWork(selected, new AbortController().signal, {
      read: async () => source(), nowMicros: () => 103000000n,
      elapsedUpperMicros: () => ++clocks === 1 ? first! : second! }), { status: "unavailable" });
  }
});
