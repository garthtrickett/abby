import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { TransportMediaNormalizer } from "../src/voice/transport-media-normalizer.ts";

const names = ["availability-thursday", "book-friday", "urgent-monday"] as const;
const frameBytes = 160; // 20 ms of G.711 mu-law at 8 kHz.

async function main(): Promise<void> {
  const normalizer = new TransportMediaNormalizer("pcmu/8000");
  for (const name of names) {
    const input = resolve(`eval/audio/${name}.pcm`);
    const source = await readFile(input);
    const encoded = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "s16le",
      "-ar", "16000", "-ac", "1", "-i", "pipe:0", "-ar", "8000", "-ac", "1",
      "-acodec", "pcm_mulaw", "-f", "mulaw", "pipe:1"], { input: source, maxBuffer: 1_000_000 });
    if (encoded.length < frameBytes) throw new Error("telephony fixture unavailable");
    const frames: Uint8Array[] = [];
    for (let offset = 0, sequence = 0; offset < encoded.length; offset += frameBytes, sequence += 1) {
      const payload = new Uint8Array(frameBytes).fill(0xff); // G.711 silence pads only the final frame.
      payload.set(encoded.subarray(offset, offset + frameBytes));
      const frame = normalizer.normalize({ sessionId: "synthetic-telephony-evaluation", sequence,
        capturedAt: new Date(Date.UTC(2026, 8, 29, 10, 0, 0) + sequence * 20).toISOString(), payload });
      if (!frame.ok) throw new Error("telephony fixture normalization failed");
      frames.push(frame.value.bytes);
    }
    const pcm = Buffer.concat(frames);
    const output = resolve(`eval/audio/${name}-pcmu-8k.pcm`);
    await writeFile(output, pcm);
    process.stdout.write(`${name}: ${pcm.length} bytes, sha256=${createHash("sha256").update(pcm).digest("hex")}\n`);
  }
}

main().catch(() => {
  process.stderr.write("Telephony fixture generation failed; check FFmpeg and the source fixtures.\n");
  process.exitCode = 1;
});
