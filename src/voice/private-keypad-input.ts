import type { MediaFrame } from "./media-turn-controller.ts";
/** Trusted call-owned private input, never an intent resolver or public agent command.
 * It starts blocked; a workflow may open routing speech before entering private collection. */
export interface PrivateKeypadInput {
  claim(callId: string, sessionId: string): boolean;
  start(): boolean;
  blocked(): boolean;
  accept(digit: string): Promise<"pending" | "verified" | "failed">;
  /** Optional private registration transcription. OTP collection always discards media. */
  acceptMedia?(frame: MediaFrame): Promise<"pending" | "failed">;
  stop(): void;
}
