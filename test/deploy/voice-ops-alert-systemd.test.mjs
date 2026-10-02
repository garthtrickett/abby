import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderVoiceOpsAlertSystemd } from "../../scripts/render-voice-ops-alert-systemd.mjs";

test("aggregate alert units keep secrets out of systemd and refuse unsafe config or replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "abby-ops-unit-"));
  try {
    const app = join(root, "app");
    const config = join(root, "ops-alert.env");
    const output = join(root, "rendered");
    const secretCanary = "a".repeat(64);
    await mkdir(join(app, "scripts"), { recursive: true });
    await writeFile(join(app, "scripts/send-voice-operational-alerts.ts"), "// synthetic sender\n");
    await writeFile(config, `ABBY_VOICE_ALERT_TOKEN_HEX=${secretCanary}\n`, { mode: 0o600 });
    const args = ["--app-root", app, "--node-bin", process.execPath, "--env-file", config,
      "--service-user", userInfo().username, "--name", "abby-ops-alert-test", "--out-dir", output];
    const rendered = await renderVoiceOpsAlertSystemd(args);
    assert.deepEqual(rendered, { service: "abby-ops-alert-test.service", timer: "abby-ops-alert-test.timer" });
    const service = await readFile(join(output, rendered.service), "utf8");
    const timer = await readFile(join(output, rendered.timer), "utf8");
    assert.match(service, /Type=oneshot/);
    assert.match(service, /send-voice-operational-alerts\.ts/);
    assert.match(service, /ProtectSystem=strict/);
    assert.match(service, /UMask=0077/);
    assert.ok(service.includes(`--env-file=${config}`));
    assert.equal(service.includes(secretCanary), false);
    assert.match(timer, /OnCalendar=\*:0\/15/);
    assert.match(timer, /Persistent=true/);
    assert.match(timer, /Unit=abby-ops-alert-test\.service/);
    await assert.rejects(renderVoiceOpsAlertSystemd(args), { code: "EEXIST" });
    await chmod(config, 0o644);
    await assert.rejects(renderVoiceOpsAlertSystemd([...args.slice(0, -2), "--out-dir", join(root, "other")]),
      /systemd alert source unavailable/);
    await assert.rejects(renderVoiceOpsAlertSystemd([...args.slice(0, 8), "--name", "bad/name", ...args.slice(10)]),
      /invalid systemd render arguments/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
