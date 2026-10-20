import type { FinalCallerTurn } from "../core/model.ts";

/** Trusted outbound host policy over an assembled actual caller turn. This
 * restrictive gate supplies no patient identity, no-stop proof, clinical
 * permission or hold release. Retention owns its independent bounded native
 * purpose; ending a conversation cannot invent a successful durable decision. */
export type OutboundContactStopPolicy = Readonly<{
  retentionDeadlineMs: number;
  inspect(turn: FinalCallerTurn): "continue" | "stop";
  retainStop(turn: FinalCallerTurn, signal: AbortSignal): Promise<void>;
}>;
