import type { AdmissionReceipt, CallState, PendingLocationCall, ProviderCallKey, Result, TransitionFailure } from "../core/model.ts";
import type { RouteFailure } from "./admission.ts";
import type { PrelocationVoiceSession } from "./prelocation-voice-session.ts";
import type { SharedNumberIntakeResult } from "./shared-number-intake.ts";
import type { PlaybackPort } from "./voice-session.ts";

/** Direction-specific admission owns its routing and private context. The shared
 * controller receives only the entry and existing session lifecycle. */
export type VoiceCallEntry = Readonly<{
  callId: string;
  key: ProviderCallKey;
  current?: () => boolean;
  begin(): Promise<Result<SharedNumberIntakeResult, TransitionFailure | RouteFailure>>;
  prelocation?: (sessionId: string, playback: PlaybackPort, monotonicNow: () => number) => PrelocationVoiceSession;
  closeUnattached(receipt: AdmissionReceipt | undefined, sessionId: string, now: string,
    reason: "callerDisconnected" | "sessionClosed"): Promise<Result<CallState | PendingLocationCall, TransitionFailure>>;
}>;
