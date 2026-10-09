import { close, constants, fstat, open, read } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const openFile = promisify(open), statFile = promisify(fstat);
const readChunk = promisify(read), closeFile = promisify(close);

/** Bounded reads of operator-owned configuration. Never follows the file's symlink or caches content. */
export async function readOwnerJson(path: string, maxBytes: number): Promise<unknown> {
  if (typeof path !== "string" || !isAbsolute(path) || typeof process.getuid !== "function" ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) throw new Error("owner configuration unavailable");
  // Keep filesystem work asynchronous without the extra FileHandle promise
  // machinery on each fresh approval read.
  const file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await statFile(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
      throw new Error("owner configuration unavailable");
    }
    const buffer = Buffer.alloc(maxBytes + 1); let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await readChunk(file, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > maxBytes || (await statFile(file)).size > maxBytes) throw new Error("owner configuration unavailable");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await closeFile(file); }
}
