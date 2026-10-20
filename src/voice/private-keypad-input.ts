import type { MediaFrame } from "./media-turn-controller.ts";
/** Trusted call-owned private input, never an intent resolver or public agent command.
 * It starts blocked; a workflow may open routing speech before entering private collection. */
export interface PrivateKeypadInput {
  claim(callId: string, sessionId: string): boolean;
  start(): boolean;
  blocked(): boolean;
  /** Optional current private-workflow edit key while ordinary speech is open. */
  handlesDigit?(digit: string): boolean;
  /** Transport captures this opaque admission in wire arrival order. It never
   * comes from a caller JSON field or from later queue/playback state. */
  captureDigit?(digit: string, playbackPending: boolean): object | undefined;
  accept(digit: string, arrival?: object): Promise<"pending" | "verified" | "failed">;
  /** Optional private registration transcription. OTP collection always discards media. */
  acceptMedia?(frame: MediaFrame): Promise<"pending" | "failed">;
  stop(): void;
}
