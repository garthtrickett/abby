import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { MediaFrame } from "./media-turn-controller.ts";

export type TransportMediaEncoding = "pcmu/8000" | "pcm16le/16000";
export type EncodedMediaFrame = Readonly<{
  sessionId: string;
  sequence: number;
  capturedAt: string;
  payload: Uint8Array;
}>;
export type MediaNormalizationFailure = Readonly<{ kind: "invalidMedia" }>;

function decodePcmu(octet: number): number {
  const code = (~octet) & 0xff;
  const magnitude = (((code & 0x0f) << 3) + 0x84) << ((code >> 4) & 0x07);
  const sample = magnitude - 0x84;
  return (code & 0x80) === 0 ? sample : -sample;
}

/** The trusted transport fixes the encoding once; no codec field reaches the call session. */
export class TransportMediaNormalizer {
  private readonly encoding: TransportMediaEncoding;

  constructor(encoding: TransportMediaEncoding) {
    if (encoding !== "pcmu/8000" && encoding !== "pcm16le/16000") throw new RangeError("unsupported media encoding");
    this.encoding = encoding;
  }

  normalize(frame: EncodedMediaFrame): Result<MediaFrame, MediaNormalizationFailure> {
    if (!frame || typeof frame.sessionId !== "string" || !frame.sessionId.trim() || frame.sessionId.length > 256 ||
        !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 ||
        typeof frame.capturedAt !== "string" || !Number.isFinite(Date.parse(frame.capturedAt)) ||
        !(frame.payload instanceof Uint8Array)) return err({ kind: "invalidMedia" });
    const source = new Uint8Array(frame.payload);
    if (this.encoding === "pcm16le/16000") {
      if (source.length < 320 || source.length > 3_200 || source.length % 32 !== 0) return err({ kind: "invalidMedia" });
      return ok({ sessionId: frame.sessionId, sequence: frame.sequence, capturedAt: frame.capturedAt, bytes: source });
    }
    if (source.length < 80 || source.length > 800 || source.length % 8 !== 0) return err({ kind: "invalidMedia" });
    const bytes = new Uint8Array(source.length * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < source.length; index += 1) {
      const sample = decodePcmu(source[index]!);
      view.setInt16(index * 4, sample, true);
      view.setInt16(index * 4 + 2, sample, true);
    }
    return ok({ sessionId: frame.sessionId, sequence: frame.sequence, capturedAt: frame.capturedAt, bytes });
  }
}
