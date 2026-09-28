export type InFlightWrite = Readonly<{
  effectId: string;
  callId: string;
  actionKey: string;
  status: "possiblySent" | "uncertain";
}>;

export type WriteStopStatus = Readonly<{
  stopped: boolean;
  version: "0" | "1";
  actorRef?: string;
  reason?: string;
  stoppedAt?: string;
  inFlight: readonly InFlightWrite[];
  nextAfterEffectId?: string;
}>;
