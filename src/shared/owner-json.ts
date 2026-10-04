import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Bounded reads of operator-owned configuration. Never follows the file's symlink or caches content. */
export async function readOwnerJson(path: string, maxBytes: number): Promise<unknown> {
  if (typeof path !== "string" || !isAbsolute(path) || typeof process.getuid !== "function" ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) throw new Error("owner configuration unavailable");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
      throw new Error("owner configuration unavailable");
    }
    const buffer = Buffer.alloc(maxBytes + 1); let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > maxBytes || (await file.stat()).size > maxBytes) throw new Error("owner configuration unavailable");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}
