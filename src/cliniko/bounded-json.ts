import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";

export type BoundedClinikoJsonFailure = Readonly<{ kind: "malformed" | "tooManyResults" }>;
const maxBodyBytes = 1_000_000;

export async function boundedClinikoJson(response: Response): Promise<Result<unknown, BoundedClinikoJsonFailure>> {
  if (!response.body) return err({ kind: "malformed" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        return err({ kind: "tooManyResults" });
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return ok(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
  } catch { return err({ kind: "malformed" }); }
  finally { reader.releaseLock(); }
}

