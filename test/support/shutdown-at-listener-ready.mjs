// Isolated process regression: deliver a real signal at the readiness boundary.
const signal = process.env.ABBY_SCHEMA_RUNNER_SHUTDOWN_SIGNAL;
if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" ||
    process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5" ||
    !new URL(process.env.DATABASE_URL).pathname.startsWith("/abby_schema_shutdown_") ||
    !["SIGINT", "SIGTERM"].includes(signal) || typeof process.send !== "function") {
  throw new Error("isolated readiness shutdown fixture unavailable");
}

const send = process.send;
let signalled = false;
process.send = function (message, ...args) {
  const result = Reflect.apply(send, this, [message, ...args]);
  if (!signalled && message?.kind === "listenerReady") {
    signalled = true;
    process.kill(process.pid, signal);
  }
  return result;
};
