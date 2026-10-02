import type { Server } from "node:http";

/** One server reserves and owns its assigned port until the test closes it. */
export async function listenLoopbackServer(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1" || address.port < 1) {
    throw new Error("loopback listener address unavailable");
  }
  return `http://127.0.0.1:${address.port}`;
}
