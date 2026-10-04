import assert from "node:assert/strict";
import type { ClinicIntakeSettingStore } from "../../src/core/clinic-intake-setting.ts";
import { OwnerFileIntakePolicy } from "../../src/standalone/owner-file-intake-policy.ts";
import { intakePolicyFixture } from "./intake-policy.ts";

/** Normal settings are captured per call; public approval replacement remains revocable. */
export async function exerciseIntakePolicySetting(store: ClinicIntakeSettingStore) {
  const f = await intakePolicyFixture();
  try {
    const capture = async () => {
      const setting = await store.read(f.scope); assert.ok(setting.ok);
      return OwnerFileIntakePolicy.capture({ ...f.config, intakeEnabled: setting.value.enabled, intakeVersion: setting.value.version });
    };
    assert.equal((await capture()).ok, false, "default disabled version cannot supply a policy");
    assert.ok((await store.changeEnabled(f.scope, "0", true, "intake-admin")).ok);
    const first = await capture(); assert.ok(first.ok); assert.ok((await first.value.checkDraft(f.query)).ok);
    const secondLocation = await store.read({ ...f.scope, locationId: "second" } as typeof f.scope); assert.ok(secondLocation.ok);
    assert.deepEqual(secondLocation.value, { version: "1", enabled: true });
    assert.equal((await OwnerFileIntakePolicy.capture({ ...f.config, scope: { ...f.scope, locationId: "second" } })).ok, false);
    for (const foreign of [{ ...f.scope, clinicId: "foreign" }, { ...f.scope, tenantId: "foreign" }]) {
      assert.deepEqual(await store.read(foreign), { ok: true, value: { version: "0", enabled: false } });
    }
    assert.ok((await store.changeEnabled(f.scope, "1", false, "intake-admin")).ok);
    assert.equal((await capture()).ok, false, "disable denies subsequent admissions");
    assert.ok((await first.value.checkDraft(f.query)).ok, "a normal edit preserves captured active policy");
    assert.ok((await store.changeEnabled(f.scope, "2", true, "intake-admin")).ok);
    assert.equal((await capture()).ok, false, "new version needs its own exact current public approval");
    await f.replaceApproval({ revision: "intake-clinic-3", intakeVersion: "3" });
    const next = await capture(); assert.ok(next.ok); assert.ok((await next.value.checkDraft(f.query)).ok);
    assert.equal((await first.value.checkDraft(f.query)).ok, false, "replaced approval revokes the earlier captured policy");
    const audit = await store.listChanges(f.scope); assert.ok(audit.ok);
    assert.deepEqual(audit.value.entries.map(row => [row.version, row.enabled, row.previousEnabled, row.actorRef]),
      [["1", true, false, "intake-admin"], ["2", false, true, "intake-admin"], ["3", true, false, "intake-admin"]]);
    return { scope: f.scope, canaries: Object.values(f.query.draft) };
  } finally { await f.close(); }
}
