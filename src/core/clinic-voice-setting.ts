import type { Result } from "./model.ts";
import type { PolicyFailure } from "./host.ts";
import { validVoiceRef, validVoiceScope, validVoiceSettingKind, validVoiceSettingValue, validVoiceVersion } from "./voice-profile.ts";
import type { VoiceClinicScope, VoicePreferences, VoiceSettingKind } from "./voice-profile.ts";

export type VoiceSettingAuditEntry = Readonly<{
  version: string;
  kind: VoiceSettingKind;
  value: string | null;
  previousValue: string | null;
  actorRef: string;
  changedAt: string;
}>;
export type VoiceSettingAuditPage = Readonly<{ entries: readonly VoiceSettingAuditEntry[]; nextAfterVersion?: number }>;
export interface ClinicVoiceSettingStore {
  read(scope: VoiceClinicScope): Promise<Result<VoicePreferences, PolicyFailure>>;
  change(scope: VoiceClinicScope, expectedVersion: string, kind: VoiceSettingKind, value: string | null,
    actorRef: string): Promise<Result<VoicePreferences, PolicyFailure>>;
  listChanges(scope: VoiceClinicScope, afterVersion?: number): Promise<Result<VoiceSettingAuditPage, PolicyFailure>>;
}
export function validVoiceChange(scope: VoiceClinicScope, version: string, kind: VoiceSettingKind, value: string | null,
  actorRef: string): boolean {
  return validVoiceScope(scope) && validVoiceVersion(version) && Number(version) < 2_147_483_647 &&
    validVoiceSettingKind(kind) && validVoiceSettingValue(kind, value) && validVoiceRef(actorRef);
}
