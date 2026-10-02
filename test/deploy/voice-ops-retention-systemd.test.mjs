import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderVoiceOpsRetentionSystemd } from "../../scripts/render-voice-ops-retention-systemd.mjs";

test("retention units schedule global cleanup without exposing the database credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "abby-retention-unit-"));
  try {
    const app = join(root, "app");
    const config = join(root, "retention.env");
    const output = join(root, "rendered");
    const secretCanary = "postgresql://secret-canary@localhost/abby";
    await mkdir(join(app, "scripts"), { recursive: true });
    await writeFile(join(app, "scripts/prune-voice-operations.ts"), "// synthetic prune command\n");
    await writeFile(config, `DATABASE_URL=${secretCanary}\n`, { mode: 0o600 });
    const args = ["--app-root", app, "--node-bin", process.execPath, "--env-file", config,
      "--service-user", userInfo().username, "--name", "abby-ops-retention-test", "--out-dir", output];
    const rendered = await renderVoiceOpsRetentionSystemd(args);
    assert.deepEqual(rendered, { service: "abby-ops-retention-test.service",
      timer: "abby-ops-retention-test.timer" });
    const service = await readFile(join(output, rendered.service), "utf8");
    const timer = await readFile(join(output, rendered.timer), "utf8");
    assert.match(service, /prune-voice-operations\.ts/);
    assert.match(service, /TimeoutStartSec=2min/);
    assert.match(service, /ProtectSystem=strict/);
    assert.ok(service.includes(`--env-file=${config}`));
    assert.equal(service.includes(secretCanary), false);
    assert.match(timer, /OnCalendar=\*-\*-\* 00:00:00 UTC/);
    assert.match(timer, /AccuracySec=1s/);
    assert.match(timer, /Persistent=true/);
    assert.match(timer, /Unit=abby-ops-retention-test\.service/);
    await assert.rejects(renderVoiceOpsRetentionSystemd(args), { code: "EEXIST" });
    await chmod(config, 0o644);
    await assert.rejects(renderVoiceOpsRetentionSystemd([...args.slice(0, -2), "--out-dir", join(root, "other")]),
      /systemd task source unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
