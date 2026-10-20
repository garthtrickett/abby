import type { LedgerStore } from "../core/ledger.ts";
import type { VoiceProfile } from "../core/voice-profile.ts";
import type { ReadinessFailure } from "../core/readiness.ts";
import type { Result } from "../core/model.ts";
import { callIdFor } from "./admission.ts";
import type { AuthenticatedInboundCall } from "./admission.ts";
import { closeUnattachedCall } from "./unattached-call-close.ts";
import { PrelocationVoiceSession } from "./prelocation-voice-session.ts";
import type { SharedNumberIntakeService } from "./shared-number-intake.ts";
import type { PlaybackPort } from "./voice-session.ts";
import { ReceptionVoiceCall } from "./reception-voice-call.ts";
import type { FullVoiceSessionFactory } from "./reception-voice-call.ts";
import type { VoiceCallEntry } from "./voice-call-entry.ts";
export type { SharedVoiceFailure, SharedVoiceStart, SharedVoiceTurn, FullVoiceSessionFactory } from "./reception-voice-call.ts";

export function incomingVoiceEntry(event: AuthenticatedInboundCall, ledger: LedgerStore, intake: SharedNumberIntakeService): VoiceCallEntry {
  const captured = structuredClone(event);
  return {
    callId: callIdFor(captured.key), key: captured.key,
    begin: () => intake.begin(captured),
    prelocation: (sessionId, playback, monotonicNow) => new PrelocationVoiceSession(captured, sessionId, ledger, intake, playback, monotonicNow),
    closeUnattached: (receipt, sessionId, now, reason) => closeUnattachedCall({ ledger, intake, event: captured,
      ...(receipt ? { receipt } : {}), sessionId, now, reason }),
  };
}
/** Incoming compatibility adapter; session/media ownership lives in the shared controller. */
export class SharedNumberVoiceCall extends ReceptionVoiceCall {
  constructor(event: AuthenticatedInboundCall, sessionId: string, ledger: LedgerStore, intake: SharedNumberIntakeService,
    playback: PlaybackPort, fullFactory: FullVoiceSessionFactory,
    bindSpeech: (profile: VoiceProfile) => Result<void, ReadinessFailure>, monotonicNow: () => number = () => performance.now()) {
    super(incomingVoiceEntry(event, ledger, intake), sessionId, ledger, playback, fullFactory, bindSpeech, monotonicNow);
  }
}
