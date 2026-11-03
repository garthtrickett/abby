import { once } from "node:events";
import { createTwilioRehearsalGateway } from "../src/testing/twilio-rehearsal-gateway.ts";

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--serve" ||
      process.env.ABBY_VOICE_TEST_MODE !== "1")
    throw new Error("Explicit isolated rehearsal gateway required");
  const port = Number(process.env.ABBY_REHEARSAL_GATEWAY_PORT ?? "3119");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid rehearsal gateway port");
  const gateway = createTwilioRehearsalGateway({
    target: Number(process.env.ABBY_REHEARSAL_TARGET_PORT ?? "3120"),
    caller: Number(process.env.ABBY_REHEARSAL_PORT ?? "3121"),
  });
  gateway.server.listen(port, "127.0.0.1");
  await once(gateway.server, "listening");
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= gateway.stop();
    void stopping.catch(() => { process.exitCode = 1; });
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  setTimeout(stop, 3_600_000).unref();
  console.log("Isolated rehearsal gateway listening on loopback for one finite test window.");
}
main().catch(() => { console.error("Rehearsal gateway unavailable."); process.exitCode = 1; });
