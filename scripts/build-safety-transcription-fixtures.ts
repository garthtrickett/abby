import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TransportMediaNormalizer } from "../src/voice/transport-media-normalizer.ts";

const phrases = [
  { name: "physiotherapy-november", text: "I need physiotherapy on the fourteenth of November.",
    category: "domain-date", criticalTerms: ["physiotherapy", "fourteenth", "November"] },
  { name: "tuesday-seven-thirty", text: "Please call me on Tuesday at seven thirty.",
    category: "weekday-number", criticalTerms: ["Tuesday", "seven", "thirty"] },
  { name: "demo-email", text: "My email is demo at example dot test.",
    category: "email-address", criticalTerms: ["demo", "example"] },
  { name: "forty-two-dollars", text: "The fee is forty two dollars.",
    category: "currency-number", criticalTerms: ["forty", "two", "dollars"] },
] as const;
const frameBytes = 160;

function whiteNoise(source: Buffer, seed: number): Buffer {
  if (source.length < 640 || source.length % 2) throw new Error("invalid generated speech");
  let power = 0;
  for (let offset = 0; offset < source.length; offset += 2) power += source.readInt16LE(offset) ** 2;
  const signalRms = Math.sqrt(power / (source.length / 2));
  const noisePeak = signalRms * Math.sqrt(3) / 10; // 20 dB nominal SNR.
  const output = Buffer.allocUnsafe(source.length);
  let state = seed;
  for (let offset = 0; offset < source.length; offset += 2) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const noise = (((state >>> 0) / 0xffffffff) * 2 - 1) * noisePeak;
    output.writeInt16LE(Math.max(-32_768, Math.min(32_767,
      Math.round(source.readInt16LE(offset) + noise))), offset);
  }
  return output;
}

function telephonePcm(source: Buffer): Buffer {
  const encoded = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "s16le",
    "-ar", "16000", "-ac", "1", "-i", "pipe:0", "-ar", "8000", "-ac", "1",
    "-acodec", "pcm_mulaw", "-f", "mulaw", "pipe:1"], { input: source, maxBuffer: 1_000_000 });
  const normalizer = new TransportMediaNormalizer("pcmu/8000");
  const frames: Uint8Array[] = [];
  for (let offset = 0, sequence = 0; offset < encoded.length; offset += frameBytes, sequence += 1) {
    const payload = new Uint8Array(frameBytes).fill(0xff);
    payload.set(encoded.subarray(offset, offset + frameBytes));
    const frame = normalizer.normalize({ sessionId: "synthetic-safety-eval", sequence,
      capturedAt: new Date(Date.UTC(2026, 8, 29, 10, 0, 0) + sequence * 20).toISOString(), payload });
    if (!frame.ok) throw new Error("telephone fixture normalization failed");
    frames.push(frame.value.bytes);
  }
  return Buffer.concat(frames);
}

async function main(): Promise<void> {
  const cases = [];
  for (const [voiceIndex, voice] of (["kal", "slt"] as const).entries()) {
    for (const [phraseIndex, phrase] of phrases.entries()) {
      const clean = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
        "-i", `flite=voice=${voice}:text=${phrase.text}`, "-ar", "16000", "-ac", "1", "-f", "s16le",
        "pipe:1"], { maxBuffer: 1_000_000 });
      const pcm = telephonePcm(whiteNoise(clean, 0x5a17 + voiceIndex * phrases.length + phraseIndex));
      const file = `${phrase.name}-${voice}-white-20db-pcmu-8k.pcm`;
      await writeFile(resolve("eval/audio", file), pcm);
      cases.push({ id: `SG-${String(cases.length + 1).padStart(3, "0")}`,
        category: `${phrase.category}-${voice}-noise`, file,
        sha256: createHash("sha256").update(pcm).digest("hex"),
        expectedText: phrase.text, criticalTerms: phrase.criticalTerms });
    }
  }
  await writeFile(resolve("eval/transcription-safety-v1.json"), `${JSON.stringify({ schemaVersion: 1,
    version: "transcription-safety-v1", audioFormat: "mono-pcm16le-16000", cases }, null, 2)}\n`);
  process.stdout.write(`generated ${cases.length} pinned patient-free telephone audio cases\n`);
}
main().catch(() => {
  process.stderr.write("Safety transcription fixture generation failed; check FFmpeg.\n");
  process.exitCode = 1;
});
