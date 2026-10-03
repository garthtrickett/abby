import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { captureVoicePolicy } from "../../src/core/voice-policy.ts";
import { defaultVoicePreferences, voiceClinicScope } from "../../src/core/voice-profile.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { GatewayCommand, HostActor } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { matchesSchema } from "../../src/reference/schema-shapes.ts";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { listenLoopbackServer } from "../support/listen-loopback-server.ts";
import { value, voicePolicyMutationContract, voiceDeclaration, voiceRegistry, voiceScope } from "../support/voice-settings-contract.ts";
import type { VoiceProfileRegistry } from "../../src/core/voice-profile-registry.ts";
import { ok } from "../../src/core/model.ts";

const ids = ["settings.voice.locale.change.v1", "settings.voice.voiceId.change.v1", "settings.voice.options.v1", "settings.voice.audit.v1"] as const;
function fixture() {
  const scope = { ...voiceScope(), locationId: "first" };
  const policy = new MemoryPolicyStore(undefined, undefined, undefined, undefined, undefined, undefined, voiceRegistry());
  const ledger = new MemoryLedger(), reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const gateway = (role: HostActor["role"], bound = scope) => new CommandGateway({ role, scope: bound, actorRef: `${role}-owner` }, policy, reception);
  return { scope, policy, ledger, reception, gateway, admin: gateway("clinicAdmin") };
}
test("E2E-258 E2E-259 typed voice commands bind clinic authority and never expand clinical capability", async () => {
  const app = fixture();
  const commands: readonly GatewayCommand[] = [{ kind: ids[0], expectedVersion: "0", locale: "en-AU" },
    { kind: ids[1], expectedVersion: "0", voiceId: "coral" }, { kind: ids[2] }, { kind: ids[3] }];
  for (const id of ids) assert.ok(app.admin.listPermitted().some(row => row.id === id));
  for (const role of ["staff", "agent"] as const) {
    const gateway = app.gateway(role);
    assert.equal(gateway.listPermitted().some(row => ids.some(id => id === row.id)), false);
    for (const command of commands) assert.deepEqual(await gateway.submit(command), { ok: false, error: { kind: "forbidden" } });
  }
  for (const command of [{ ...commands[0], tenantId: "foreign" }, { ...commands[1], actorRef: "forged" },
    { ...commands[0], voiceProfile: { ready: true } }, { ...commands[1], configurationHash: "1".repeat(64) }]) {
    assert.deepEqual(await app.admin.submit(command as GatewayCommand), { ok: false, error: { kind: "invalid" } });
  }
  const locale = await app.admin.submit(commands[0]!);
  assert.ok(locale.ok && locale.value.kind === "settings");
  assert.equal(locale.value.policy.voiceProfile, undefined);
  const descriptor = app.admin.listPermitted().find(row => row.id === ids[1])!;
  assert.deepEqual(descriptor.preconditions, ["expectedClinicVoiceVersion", "hostVoiceProfileForSet"]);
  const selected = await app.admin.submit({ kind: ids[1], expectedVersion: "1", voiceId: "coral" });
  assert.ok(selected.ok && selected.value.kind === "settings");
  assert.ok(matchesSchema(descriptor.resultSchema, selected));
  assert.equal(selected.value.policy.voiceProfile?.voiceId, "coral");
  assert.equal(selected.value.policy.capabilities.book, "unavailable");
  assert.equal(selected.value.policy.automationEnabled, false);
  const otherLocation = app.gateway("clinicAdmin", { ...app.scope, locationId: "second" });
  const shared = value(await otherLocation.submit({ kind: "settings.read.v1" }));
  assert.ok(shared.kind === "settings"); assert.equal(shared.policy.voiceSettings?.version, "2");
  assert.deepEqual(await otherLocation.submit({ kind: ids[0], expectedVersion: "1", locale: "en-US" }), { ok: false, error: { kind: "versionConflict" } });
  const audit = value(await app.admin.submit({ kind: ids[3] }));
  assert.ok(audit.kind === "voiceSettingAudit"); assert.equal(audit.page.entries.length, 2);
  assert.ok(audit.page.entries.every(row => row.actorRef === "clinicAdmin-owner"));
  const foreign = value(await app.gateway("clinicAdmin", { ...app.scope, tenantId: "foreign" }).submit({ kind: ids[3] }));
  assert.ok(foreign.kind === "voiceSettingAudit"); assert.equal(foreign.page.entries.length, 0);
});
test("E2E-258 E2E-259 core call snapshots retain the old voice while future policy uses the new profile", async () => {
  const app = fixture();
  assert.ok((await app.policy.changeVoiceSetting(app.scope, "0", "locale", "en-AU", "owner")).ok);
  assert.ok((await app.policy.changeVoiceSetting(app.scope, "1", "voiceId", "coral", "owner")).ok);
  const old = value(await app.reception.startCall(`voice-old-${randomUUID()}`, app.scope));
  assert.ok((await app.policy.changeVoiceSetting(app.scope, "2", "voiceId", "cedar", "owner")).ok);
  const next = value(await app.reception.startCall(`voice-new-${randomUUID()}`, app.scope));
  assert.equal(old.policy.voiceProfile?.voiceId, "coral"); assert.equal(next.policy.voiceProfile?.voiceId, "cedar");
  assert.notEqual(old.policy.voiceProfile?.configurationHash, next.policy.voiceProfile?.configurationHash);
  assert.equal(value(await app.ledger.read(old.callId, app.scope)).policy.voiceProfile?.voiceId, "coral");
  assert.ok((await app.policy.changeVoiceSetting(app.scope, "3", "locale", null, "owner")).ok);
  assert.equal(value(await app.policy.read(app.scope)).voiceProfile, undefined);
  assert.equal(value(await app.ledger.read(old.callId, app.scope)).policy.voiceProfile?.voiceId, "coral");
});
test("E2E-258 E2E-259 voice policy capture strips injected authority and snapshots location data before host awaits", async () => {
  const scope = { ...voiceScope(), locationId: "first" }, raw = referenceDefaultPolicy(scope);
  const injected = { ...raw, voiceSettings: { version: "999", locale: "en-AU", voiceId: "coral" }, voiceProfile: {} as never };
  const stripped = value(await captureVoicePolicy(injected, defaultVoicePreferences(), voiceRegistry()));
  assert.deepEqual(stripped.voiceSettings, defaultVoicePreferences()); assert.equal(stripped.voiceProfile, undefined);
  let release: (() => void) | undefined;
  const declaration = voiceDeclaration(voiceClinicScope(scope));
  const registry: VoiceProfileRegistry = { resolve: async () => { await new Promise<void>(resolve => { release = resolve; }); return ok(declaration); } };
  const pending = captureVoicePolicy(raw, { version: "2", locale: "en-AU", voiceId: "coral" }, registry);
  await Promise.resolve(); (raw.scope as { clinicId: string }).clinicId = "mutated"; (raw.capabilities as { book: string }).book = "execute"; release!();
  const captured = value(await pending);
  assert.equal(captured.scope.clinicId, "clinic"); assert.equal(captured.capabilities.book, "unavailable");
  assert.equal(captured.voiceProfile?.scope.clinicId, "clinic");
});
for (const surface of ["full", "availabilitySetup"] as const) {
  test(`E2E-258 E2E-259 authenticated ${surface} HTTP voice setup enforces role Origin exact payload and public audit`, async () => {
    const app = fixture();
    const server = await createHostAuthenticatedDashboardServer({ publicOrigin: "http://127.0.0.1:0", surface,
      resolveActor: incoming => incoming.headers.cookie === "session=owner" ? { actorRef: "http-owner", role: "clinicAdmin", scope: app.scope }
        : incoming.headers.cookie === "session=staff" ? { actorRef: "staff", role: "staff", scope: app.scope } : null,
      gatewayFor: actor => new CommandGateway(actor, app.policy, app.reception),
    }, new URL("../../src/standalone/dashboard/main.ts", import.meta.url).pathname);
    const origin = await listenLoopbackServer(server);
    const send = (path: string, payload?: object, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, {
      method: payload ? "POST" : "GET", headers: { Cookie: "session=owner", ...(payload ? { "Content-Type": "application/json", Origin: origin } : {}), ...headers },
      ...(payload ? { body: JSON.stringify(payload) } : {}) });
    try {
      const catalogue = await send("/api/settings/voice-options"); assert.equal(catalogue.status, 200);
      const options = await catalogue.json(); assert.deepEqual(options.value.catalogue.scope, voiceClinicScope(app.scope));
      assert.equal(JSON.stringify(options).includes("configurationHash"), false);
      const menu = await (await send("/api/capabilities")).json();
      for (const id of ids) assert.ok(menu.value.some((row: { id: string }) => row.id === id));
      assert.equal((await send("/api/settings/voice-locale", { expectedVersion: "0", locale: "en-AU" }, { Origin: "https://foreign.example" })).status, 403);
      assert.equal((await send("/api/settings/voice-locale", { expectedVersion: "0", locale: "en-AU" }, { Cookie: "session=staff" })).status, 403);
      assert.equal((await send("/api/settings/voice-audit", undefined, { Cookie: "session=forged", "X-Abby-Role": "clinicAdmin" })).status, 403);
      for (const payload of [{ expectedVersion: "0", locale: "en-AU", actorRef: "forged" },
        { expectedVersion: "0", locale: "en-AU", scope: { tenantId: "foreign" } }, { expectedVersion: "0", locale: "en-au" }]) {
        assert.equal((await send("/api/settings/voice-locale", payload)).status, 400);
      }
      assert.equal((await send("/api/settings/voice-locale", { expectedVersion: "0", locale: "en-AU" })).status, 200);
      assert.equal((await send("/api/settings/voice-id", { expectedVersion: "1", voiceId: "coral" })).status, 200);
      assert.equal((await send("/api/settings/voice-id", { expectedVersion: "1", voiceId: "cedar" })).status, 409);
      assert.equal((await send("/api/settings/voice-id", { expectedVersion: "2", voiceId: "cedar", model: "PRIVATE_MODEL" })).status, 400);
      for (const path of ["/api/settings/voice-options?scope=foreign", "/api/settings/voice-audit?after=0&after=1",
        "/api/settings/voice-audit?after=-1", "/api/settings/voice-id?kind=locale"]) {
        assert.equal((await send(path, path.includes("voice-id") ? { expectedVersion: "2", voiceId: "cedar" } : undefined)).status, 400);
      }
      const audit = await (await send("/api/settings/voice-audit")).json();
      assert.equal(audit.value.page.entries.length, 2);
      assert.ok(audit.value.page.entries.every((row: { actorRef: string }) => row.actorRef === "http-owner"));
      for (const field of ["PRIVATE_", "configurationHash", "transcriptionVersion", "patientRef", "apiKey"]) assert.equal(JSON.stringify(audit).includes(field), false);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
}

voicePolicyMutationContract("memory", registry => new MemoryPolicyStore(undefined, undefined, undefined, undefined, undefined, undefined, registry));
