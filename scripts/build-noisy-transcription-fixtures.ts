import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TransportMediaNormalizer } from "../src/voice/transport-media-normalizer.ts";

const cases = [
  { name: "availability-thursday", text: "Are there appointments available on Thursday?" },
  { name: "book-friday", text: "Please book the first appointment on Friday." },
  { name: "urgent-monday", text: "I have chest pain. Should I wait until Monday?" },
] as const;
const snrDb = 10;
const frameBytes = 160; // 20 ms of G.711 mu-law at 8 kHz.

function addWhiteNoise(source: Buffer, seed: number): Buffer {
  if (source.length < 640 || source.length % 2 !== 0) throw new Error("invalid synthetic speech source");
  let sum = 0;
  for (let offset = 0; offset < source.length; offset += 2) {
    const value = source.readInt16LE(offset);
    sum += value * value;
  }
  const signalRms = Math.sqrt(sum / (source.length / 2));
  const noisePeak = signalRms * Math.sqrt(3) / 10 ** (snrDb / 20);
  const mixed = Buffer.allocUnsafe(source.length);
  let state = seed;
  for (let offset = 0; offset < source.length; offset += 2) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const noise = (((state >>> 0) / 0xffffffff) * 2 - 1) * noisePeak;
    const sample = Math.round(source.readInt16LE(offset) + noise);
    mixed.writeInt16LE(Math.max(-32_768, Math.min(32_767, sample)), offset);
  }
  return mixed;
}

function telephonePcm(source: Buffer): Buffer {
  const encoded = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "s16le",
    "-ar", "16000", "-ac", "1", "-i", "pipe:0", "-ar", "8000", "-ac", "1",
    "-acodec", "pcm_mulaw", "-f", "mulaw", "pipe:1"], { input: source, maxBuffer: 1_000_000 });
  if (encoded.length < frameBytes) throw new Error("noisy telephone fixture unavailable");
  const normalizer = new TransportMediaNormalizer("pcmu/8000");
  const frames: Uint8Array[] = [];
  for (let offset = 0, sequence = 0; offset < encoded.length; offset += frameBytes, sequence += 1) {
    const payload = new Uint8Array(frameBytes).fill(0xff);
    payload.set(encoded.subarray(offset, offset + frameBytes));
    const frame = normalizer.normalize({ sessionId: "synthetic-noise-evaluation", sequence,
      capturedAt: new Date(Date.UTC(2026, 8, 29, 10, 0, 0) + sequence * 20).toISOString(), payload });
    if (!frame.ok) throw new Error("noisy telephone normalization failed");
    frames.push(frame.value.bytes);
  }
  return Buffer.concat(frames);
}

async function main(): Promise<void> {
  let index = 0;
  for (const voice of ["kal", "slt"] as const) {
    for (const item of cases) {
      const clean = voice === "slt" ? await readFile(resolve(`eval/audio/${item.name}.pcm`))
        : execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
          "-i", `flite=voice=kal:text=${item.text}`, "-ar", "16000", "-ac", "1", "-f", "s16le",
          "pipe:1"], { maxBuffer: 1_000_000 });
      const pcm = telephonePcm(addWhiteNoise(clean, 0x5a17 + index));
      const file = `eval/audio/${item.name}-${voice}-white-10db-pcmu-8k.pcm`;
      await writeFile(resolve(file), pcm);
      process.stdout.write(`${file}: ${pcm.length} bytes, sha256=${createHash("sha256").update(pcm).digest("hex")}\n`);
      index += 1;
    }
  }
}

main().catch(() => {
  process.stderr.write("Synthetic noisy transcription fixture generation failed; check FFmpeg and source fixtures.\n");
  process.exitCode = 1;
});
