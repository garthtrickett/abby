import { validRecallMarker } from "../recall-note.ts";

/** Lossless canonical private-note packing only; never a new identity or grant. */
export function packUuid(value: string): string {
  if (!validRecallMarker(value)) throw new Error("Invalid opaque identity");
  return Buffer.from(value.replaceAll("-", ""), "hex").toString("base64url");
}
export function unpackUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value)) throw new Error("Invalid opaque identity");
  const bytes = Buffer.from(value, "base64url"), hex = bytes.toString("hex");
  const result = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  if (bytes.length !== 16 || bytes.toString("base64url") !== value || !validRecallMarker(result)) throw new Error("Invalid opaque identity");
  return result;
}
export function packDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid private digest");
  return Buffer.from(value, "hex").toString("base64url");
}
export function unpackDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Invalid private digest");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) throw new Error("Invalid private digest");
  return bytes.toString("hex");
}
export function packRecall(value: string): string {
  const id = /^cliniko:recall:([1-9][0-9]{0,18})$/.exec(value)?.[1];
  if (!id) throw new Error("Invalid native identity"); return id;
}
export function unpackRecall(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) throw new Error("Invalid native identity");
  return `cliniko:recall:${value}`;
}
