import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { PolicyFailure } from "../core/host.ts";
import { validVoiceChange } from "../core/clinic-voice-setting.ts";
import type { ClinicVoiceSettingStore, VoiceSettingAuditEntry, VoiceSettingAuditPage } from "../core/clinic-voice-setting.ts";
import { defaultVoicePreferences, validVoiceCursor, validVoiceScope } from "../core/voice-profile.ts";
import type { VoiceClinicScope, VoicePreferences, VoiceSettingKind } from "../core/voice-profile.ts";
import { approveVoiceChange, unprovenVoiceProfileRegistry } from "../core/voice-profile-registry.ts";
import type { VoiceProfileRegistry } from "../core/voice-profile-registry.ts";

const clinicKey = (scope: VoiceClinicScope): string => JSON.stringify([scope.tenantId, scope.clinicId]);
export class MemoryClinicVoiceSettingStore implements ClinicVoiceSettingStore {
  private readonly states = new Map<string, VoicePreferences>();
  private readonly histories = new Map<string, VoiceSettingAuditEntry[]>();
  private readonly registry: VoiceProfileRegistry;
  private readonly clock: () => string;
  constructor(registry: VoiceProfileRegistry = unprovenVoiceProfileRegistry, clock: () => string = () => new Date().toISOString()) {
    this.registry = registry;
    this.clock = clock;
  }
  async read(scope: VoiceClinicScope): Promise<Result<VoicePreferences, PolicyFailure>> {
    return validVoiceScope(scope) ? ok(structuredClone(this.states.get(clinicKey(scope)) ?? defaultVoicePreferences())) : err({ kind: "invalidValue" });
  }
  async change(scope: VoiceClinicScope, expectedVersion: string, kind: VoiceSettingKind, value: string | null,
    actorRef: string): Promise<Result<VoicePreferences, PolicyFailure>> {
    if (!validVoiceChange(scope, expectedVersion, kind, value, actorRef)) return err({ kind: "invalidValue" });
    const bound = structuredClone(scope);
    const observed = await this.read(bound);
    if (!observed.ok) return observed;
    if (observed.value.version !== expectedVersion) return err({ kind: "versionConflict" });
    const candidate = { ...observed.value, [kind]: value, version: String(Number(expectedVersion) + 1) };
    const approved = await approveVoiceChange(this.registry, bound, candidate, kind);
    if (!approved.ok) return approved;
    const key = clinicKey(bound);
    if ((this.states.get(key)?.version ?? "0") !== expectedVersion) return err({ kind: "versionConflict" });
    let changedAt: string;
    try {
      const time = this.clock();
      if (typeof time !== "string") return err({ kind: "storageFailure" });
      changedAt = new Date(time).toISOString();
    } catch { return err({ kind: "storageFailure" }); }
    this.states.set(key, candidate);
    const history = this.histories.get(key) ?? [];
    history.push({ version: candidate.version, kind, value, previousValue: observed.value[kind], actorRef, changedAt });
    this.histories.set(key, history);
    return ok(structuredClone(candidate));
  }
  async listChanges(scope: VoiceClinicScope, afterVersion?: number): Promise<Result<VoiceSettingAuditPage, PolicyFailure>> {
    if (!validVoiceScope(scope) || !validVoiceCursor(afterVersion)) return err({ kind: "invalidValue" });
    const entries = (this.histories.get(clinicKey(scope)) ?? []).filter(row => Number(row.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries), ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }
}
