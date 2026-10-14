import { connect } from "node:tls";
import type { TLSSocket } from "node:tls";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { normalizeEmailAddress } from "../shared/email-address.ts";

export type SmtpMailConfig = Readonly<{
  host: string; port?: number; username: string; password: string; from: string;
  helloName?: string; timeoutMs?: number;
  /** Optional owner-provisioned trust roots; certificate/name validation remains required. */
  ca?: string | Uint8Array;
}>;
type Reply = Readonly<{ code: number; lines: readonly string[] }>;
const unavailable = () => new Error("mail transport unavailable");
const dnsName = (value: string) => value.length <= 253 && value.includes(".") &&
  value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));

/** One expected reply at a time; no pipelining or unsolicited reply may advance a command. */
class Replies {
  #buffer = "";
  #lines: string[] = [];
  #code: number | undefined;
  #failed = false;
  #pending: { resolve(reply: Reply): void; reject(error: Error): void } | undefined;
  readonly #socket: TLSSocket;
  constructor(socket: TLSSocket) {
    this.#socket = socket; socket.on("data", this.#data); socket.on("error", this.#fail); socket.on("close", this.#fail); socket.on("end", this.#fail);
  }
  next(): Promise<Reply> {
    if (this.#failed || this.#pending) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => { this.#pending = { resolve, reject }; });
  }
  readonly #fail = () => {
    this.#failed = true; this.#buffer = ""; this.#lines = []; this.#code = undefined;
    const pending = this.#pending; this.#pending = undefined; pending?.reject(unavailable());
  };
  readonly #data = (data: Buffer) => {
    if (this.#failed) return;
    this.#buffer += data.toString("utf8");
    if (Buffer.byteLength(this.#buffer) > 16_384) { this.#fail(); this.#socket.destroy(); return; }
    while (this.#buffer.includes("\r\n")) {
      const at = this.#buffer.indexOf("\r\n"), line = this.#buffer.slice(0, at); this.#buffer = this.#buffer.slice(at + 2);
      const parsed = /^([2-5][0-9]{2})(?:([ -])(.*))?$/.exec(line);
      if (!this.#pending || !parsed || Buffer.byteLength(line) + 2 > 512 || this.#lines.length >= 32 ||
          (this.#code !== undefined && this.#code !== Number(parsed[1]))) { this.#fail(); this.#socket.destroy(); return; }
      this.#code = Number(parsed[1]); this.#lines.push(parsed[3] ?? "");
      if (parsed[2] !== "-") {
        const pending = this.#pending, reply = { code: this.#code, lines: this.#lines };
        this.#pending = undefined; this.#code = undefined; this.#lines = []; pending.resolve(reply);
      }
    }
    if (Buffer.byteLength(this.#buffer) > 510) { this.#fail(); this.#socket.destroy(); }
  };
  dispose(): void {
    this.#fail(); this.#socket.off("data", this.#data); this.#socket.off("error", this.#fail);
    this.#socket.off("close", this.#fail); this.#socket.off("end", this.#fail);
  }
}

export type SmtpMailSubmission = Readonly<{ kind: "accepted"; messageRef: string }> |
  Readonly<{ kind: "definitiveUnsent" | "unknown" }>;

/** Private host transport over implicit TLS. This grants no patient/action authority.
 * Each invocation submits at most once. Its owner must fence repeated invocations durably.
 * Acceptance means server acceptance, never inbox delivery. */
export class SmtpTextMailTransport {
  readonly #config: SmtpMailConfig & Readonly<{ port: number; timeoutMs: number; helloName: string }>;
  constructor(config: SmtpMailConfig) {
    const port = config.port ?? 465, timeoutMs = config.timeoutMs ?? 5_000, helloName = config.helloName ?? "abby.invalid";
    if (typeof config.host !== "string" || (!isIP(config.host) && !dnsName(config.host)) || !Number.isSafeInteger(port) || port < 1 || port > 65_535 ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5_000 || typeof helloName !== "string" || !dnsName(helloName) ||
        typeof config.from !== "string" || normalizeEmailAddress(config.from) !== config.from ||
        [config.username, config.password].some(value => typeof value !== "string" || value.length < 1 || value.length > 128 || /[^\x20-\x7e]/.test(value)) ||
        (config.ca !== undefined && ((typeof config.ca !== "string" && !(config.ca instanceof Uint8Array)) ||
          (typeof config.ca === "string" ? Buffer.byteLength(config.ca) : config.ca.byteLength) < 1 ||
          (typeof config.ca === "string" ? Buffer.byteLength(config.ca) : config.ca.byteLength) > 131_072))) {
      throw new RangeError("invalid mail configuration");
    }
    this.#config = Object.freeze({ ...config, port, timeoutMs, helloName,
      ...(config.ca instanceof Uint8Array ? { ca: new Uint8Array(config.ca) } : {}) });
  }
  async submit(email: string, subject: string, text: string, signal: AbortSignal): Promise<SmtpMailSubmission> {
    if (!(signal instanceof AbortSignal) || signal.aborted || typeof email !== "string" || normalizeEmailAddress(email) !== email ||
        typeof subject !== "string" || !/^[\x20-\x7e]{1,120}$/.test(subject) ||
        typeof text !== "string" || !text.length || Buffer.byteLength(text) > 16_384 || /\u0000/.test(text)) {
      return { kind: "definitiveUnsent" };
    }
    let bodyMayHaveBeenSent = false;
    let socket: TLSSocket | undefined, replies: Replies | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => socket?.destroy();
    try {
      const c = this.#config;
      socket = connect({ host: c.host, port: c.port, rejectUnauthorized: true, minVersion: "TLSv1.2",
        ...(isIP(c.host) ? {} : { servername: c.host }),
        ...(c.ca === undefined ? {} : { ca: typeof c.ca === "string" ? c.ca : Buffer.from(c.ca) }) });
      socket.on("error", () => {}); // Socket failure must never become a process-level unhandled error.
      replies = new Replies(socket);
      timer = setTimeout(stop, c.timeoutMs); signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) { stop(); return { kind: "definitiveUnsent" }; }
      const secure = new Promise<void>((resolve, reject) => {
        socket!.once("secureConnect", () => socket!.authorized ? resolve() : reject(unavailable()));
        socket!.once("error", () => reject(unavailable())); socket!.once("close", () => reject(unavailable()));
      });
      const [, greeting] = await Promise.all([secure, replies.next()]);
      if (greeting.code !== 220 || signal.aborted) return { kind: "definitiveUnsent" };
      const command = async (text: string, expected: number) => {
        if (signal.aborted || !socket?.authorized || socket.destroyed || Buffer.byteLength(text) + 2 > 512) throw unavailable();
        const pending = replies!.next();
        try { socket.write(`${text}\r\n`); } catch { replies!.dispose(); }
        const reply = await pending; if (reply.code !== expected || signal.aborted) throw unavailable(); return reply;
      };
      const hello = await command(`EHLO ${c.helloName}`, 250);
      if (!hello.lines.some(line => /^AUTH(?:\s|=)/i.test(line) && line.replace(/^AUTH(?:\s|=)/i, "").trim().toUpperCase().split(/\s+/).includes("PLAIN"))) return { kind: "definitiveUnsent" };
      const challenge = await command("AUTH PLAIN", 334);
      if (challenge.lines.length !== 1 || !["", "="].includes(challenge.lines[0]!)) return { kind: "definitiveUnsent" };
      await command(Buffer.from(`\0${c.username}\0${c.password}`, "utf8").toString("base64"), 235);
      await command(`MAIL FROM:<${c.from}>`, 250); await command(`RCPT TO:<${email}>`, 250); await command("DATA", 354);
      const messageRef = randomUUID();
      const normalized = text.replace(/\r\n|\r|\n/g, "\r\n");
      const plain = /^[\x09\x0a\x0d\x20-\x7e]*$/.test(normalized) && normalized.split("\r\n").every(line => Buffer.byteLength(line) <= 998);
      const body = plain ? normalized : Buffer.from(normalized, "utf8").toString("base64").match(/.{1,76}/g)!.join("\r\n");
      const message = [`From: ${c.from}`, `To: ${email}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${messageRef}@${c.from.split("@")[1]}>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8",
        `Content-Transfer-Encoding: ${plain ? "7bit" : "base64"}`, "", body].join("\r\n").replace(/^\./gm, "..");
      if (signal.aborted) return { kind: "definitiveUnsent" };
      const accepted = replies.next();
      bodyMayHaveBeenSent = true; // Any lost reply after this barrier is uncertain, never an invitation to retry.
      try { socket.write(`${message}\r\n.\r\n`); } catch { replies.dispose(); }
      const result = await accepted;
      if (result.code !== 250) return { kind: result.code >= 400 ? "definitiveUnsent" : "unknown" };
      try { socket.end("QUIT\r\n"); } catch { /* A failed QUIT does not erase known message acceptance. */ }
      return { kind: "accepted", messageRef };
    } catch { return { kind: bodyMayHaveBeenSent ? "unknown" : "definitiveUnsent" }; }
    finally { if (timer) clearTimeout(timer); signal.removeEventListener("abort", stop); replies?.dispose(); socket?.destroy(); }
  }
}
