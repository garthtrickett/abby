import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderClinikoQueueMonitorSystemd } from "../../scripts/render-cliniko-queue-monitor-systemd.mjs";

test("E2E-220 compiled queue monitor timer binds public cadence, excludes secrets and validates without installing", async () => {
  const root = await mkdtemp(join(tmpdir(), "abby-queue-unit-"));
  try {
    const app = join(root, "app"), config = join(root, "monitor.env"), output = join(root, "units"), token = "d".repeat(64);
    await mkdir(join(app, "dist/runtime/scripts"), { recursive: true });
    await writeFile(join(app, "dist/runtime/scripts/monitor-cliniko-queue.js"), "// synthetic compiled monitor\n");
    await writeFile(config, `ABBY_VOICE_ALERT_TOKEN_HEX=${token}\nABBY_CLINIKO_QUEUE_POLL_MINUTES=60\n`, { mode: 0o600 });
    const args = ["--app-root", app, "--node-bin", process.execPath, "--env-file", config, "--service-user", userInfo().username,
      "--name", "abby-queue-test", "--out-dir", output, "--poll-minutes", "15"];
    const result = await renderClinikoQueueMonitorSystemd(args);
    const service = await readFile(join(output, result.service), "utf8"), timer = await readFile(join(output, result.timer), "utf8");
    assert.match(service, /dist\/runtime\/scripts\/monitor-cliniko-queue\.js/); assert.match(service, /Type=oneshot/);
    assert.match(service, /Environment=ABBY_CLINIKO_QUEUE_POLL_MINUTES=15/); assert.match(service, /TimeoutStartSec=210s/);
    assert.equal(service.includes(token), false); assert.match(timer, /OnCalendar=\*:0\/15 UTC/); assert.match(timer, /Persistent=true/);
    await promisify(execFile)("systemd-analyze", ["verify", join(output, result.service), join(output, result.timer)], { timeout: 10_000 });
    await assert.rejects(renderClinikoQueueMonitorSystemd(args), { code: "EEXIST" });
    for (const cadence of ["0", "61", "15;bad", "01"]) await assert.rejects(renderClinikoQueueMonitorSystemd([...args.slice(0, -1), cadence]), /invalid systemd render arguments/);
    await chmod(config, 0o644); await assert.rejects(renderClinikoQueueMonitorSystemd([...args.slice(0, 10), "--out-dir", join(root, "other"), ...args.slice(12)]), /systemd task source unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
