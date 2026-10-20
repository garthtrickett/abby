import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import { createOperatorAlertHttp } from "../../src/standalone/operator-alert-http.ts";
import { withOperatorAlerts } from "../support/operator-alert-fixture.ts";
import { listenLoopbackServer } from "../support/listen-loopback-server.ts";

test("E2E-220 operator HTTP bounds invalid bodies and terminates incomplete requests without acknowledgment", { timeout: 10_000 }, async () => {
  await withOperatorAlerts(async f => {
    await f.accept(); await f.workflow.observe();
    const origin = "https://operator.example.test", host = new URL(origin).host;
    const app = createOperatorAlertHttp({ publicOrigin: origin, resolveActor: () => f.owner.actor }, f.workflow);
    const server = createServer(app.handle), local = await listenLoopbackServer(server), endpoint = `${local}/api/operator-alerts/acknowledge`;
    const post = (value: unknown) => new Promise<number>((resolve, reject) => {
      const outgoing = request(endpoint, { method: "POST", headers: { Host: host, Origin: origin, "content-type": "application/json" } }, response => {
        response.resume(); resolve(response.statusCode ?? 0);
      });
      outgoing.on("error", error => { if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve(0); else reject(error); });
      outgoing.end(JSON.stringify(value));
    });
    try {
      for (const value of [{ alert: f.alert, expectedVersion: 0, actorRef: f.owner.actor.actorRef }, { alert: f.alert, expectedVersion: -1 },
        { alert: { ...f.alert, patient: "synthetic-private-canary" }, expectedVersion: 0 }]) {
        assert.equal(await post(value), 400);
      }
      assert.ok([0, 400].includes(await post({ text: "x".repeat(2048) })), "oversized bodies are rejected or disconnected, never acknowledged");
      const started = performance.now();
      const status = await new Promise<number>((resolve, reject) => {
        const pending = request(endpoint, { method: "POST", headers: { Host: host, Origin: origin, "content-type": "application/json" } }, response => {
          response.resume(); clearTimeout(timer); resolve(response.statusCode ?? 0); pending.destroy();
        });
        const timer = setTimeout(() => { pending.destroy(); reject(new Error("operator request did not terminate")); }, 7500);
        pending.on("error", () => { clearTimeout(timer); resolve(0); }); pending.write("{");
      });
      assert.notEqual(status, 200); assert.ok(performance.now() - started < 7000);
      assert.equal((await f.workflow.view(f.owner.actor))[0]?.state, "awaitingOwner");
      assert.equal(await post({ alert: f.alert, expectedVersion: 0 }), 200, "the same authenticated proxy path permits a valid explicit action");
    } finally { await app.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
