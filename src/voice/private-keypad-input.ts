/** Trusted call-owned secret input, never an intent resolver or public agent command.
 * It starts blocked and may open ordinary media only after its owner verifies the code. */
export interface PrivateKeypadInput {
  claim(callId: string, sessionId: string): boolean;
  start(): boolean;
  blocked(): boolean;
  accept(digit: string): Promise<"pending" | "verified" | "failed">;
  stop(): void;
}
