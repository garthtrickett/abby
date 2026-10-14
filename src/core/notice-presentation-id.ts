import { createHash } from "node:crypto";

export function noticePresentationId(callId: string, turnId: string): string {
  return createHash("sha256").update(JSON.stringify([callId, turnId, "notice"])).digest("hex");
}
