import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import type { TLSSocket } from "node:tls";
import { once } from "node:events";
import type { SmtpPatientCodeConfig } from "../../src/standalone/smtp-patient-code-delivery.ts";

export type SmtpFault = "authRejected" | "recipientRejected" | "dropAfterData" | "stallGreeting" | "stallData" |
  "noPlain" | "mixedReply" | "overlongReply" | "wrongIdentity" | "dataRejected" | "unexpectedDataReply";

/** Real loopback TLS/SMTP. Certificate, credentials, mailbox and messages are synthetic. */
export async function withSmtpVerificationServer(run: (server: Readonly<{
  config: SmtpPatientCodeConfig; commands: string[]; messages: string[]; receivedData: Promise<void>;
  fault(value: SmtpFault | undefined): void;
}>) => Promise<void>, identity: "correct" | "wrong" = "correct") {
  const folder = await mkdtemp(join(tmpdir(), "abby-verification-smtp-"));
  const sockets = new Set<TLSSocket>(), commands: string[] = [], messages: string[] = [];
  let fault: SmtpFault | undefined, received!: () => void;
  const receivedData = new Promise<void>(resolve => { received = resolve; });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const key = join(folder, "key.pem"), certificate = join(folder, "cert.pem");
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", identity === "correct" ? "subjectAltName=IP:127.0.0.1" : "subjectAltName=DNS:wrong.example.test",
      "-keyout", key, "-out", certificate], { timeout: 10_000 });
    await chmod(key, 0o600); const [keyBytes, certBytes] = await Promise.all([readFile(key), readFile(certificate)]);
    server = createServer({ key: keyBytes, cert: certBytes }, socket => {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
      let input = "", authenticate = false, collecting = false, text: string[] = [];
      if (fault !== "stallGreeting") socket.write("220 synthetic.example.test\r\n");
      socket.on("data", data => {
        input += data.toString("utf8");
        while (input.includes("\r\n")) {
          const at = input.indexOf("\r\n"), line = input.slice(0, at); input = input.slice(at + 2);
          if (collecting) {
            if (line !== ".") { text.push(line); continue; }
            messages.push(text.join("\r\n")); text = []; collecting = false; received();
            if (fault === "dropAfterData") socket.destroy();
            else if (fault === "dataRejected") socket.write("550 message rejected\r\n");
            else if (fault === "unexpectedDataReply") socket.write("354 unexpected\r\n");
            else if (fault !== "stallData") socket.write("250 accepted\r\n");
            continue;
          }
          commands.push(line);
          if (authenticate) {
            authenticate = false;
            socket.write(Buffer.from(line, "base64").toString() === "\0synthetic-smtp-user\0synthetic-smtp-password" ? "235 authenticated\r\n" : "535 denied\r\n"); continue;
          }
          if (line.startsWith("EHLO ")) {
            if (fault === "mixedReply") socket.write("250-synthetic\r\n550 AUTH PLAIN\r\n");
            else if (fault === "overlongReply") socket.write(`250 ${"X".repeat(600)}\r\n`);
            else if (fault === "noPlain") socket.write("250-synthetic\r\n250 AUTH LOGIN\r\n");
            else { socket.write("250-synthetic\r\n250-AUTH PLA"); setImmediate(() => { if (!socket.destroyed) socket.write("IN\r\n250 OK\r\n"); }); }
          } else if (line === "AUTH PLAIN") {
            if (fault === "authRejected") socket.write("535 rejected\r\n"); else { authenticate = true; socket.write("334\r\n"); }
          } else if (line.startsWith("MAIL FROM:")) socket.write("250 sender\r\n");
          else if (line.startsWith("RCPT TO:")) socket.write(fault === "recipientRejected" ? "550 unknown mailbox\r\n" : "250 recipient\r\n");
          else if (line === "DATA") { collecting = true; socket.write("354 send message\r\n"); }
          else if (line === "QUIT") socket.end("221 bye\r\n"); else socket.write("500 unexpected\r\n");
        }
      });
    });
    server.on("tlsClientError", () => {}); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("synthetic SMTP did not bind");
    await run({ config: { host: "127.0.0.1", port: address.port, username: "synthetic-smtp-user", password: "synthetic-smtp-password",
      from: "clinic@example.test", ca: certBytes, timeoutMs: 2_000 }, commands, messages, receivedData, fault(value) { fault = value; } });
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) { server.close(); await once(server, "close"); }
    await rm(folder, { recursive: true, force: true });
  }
}
