import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { err } from "../../src/core/model.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { voiceRegistry } from "./voice-settings-contract.ts";

export async function voiceDashboard(surface: "full" | "availabilitySetup" = "full", ready = true) {
  const scope = { tenantId: `voice-browser-${randomUUID()}`, clinicId: "clinic", locationId: "first" };
  let hostReady = ready;
  const supported = voiceRegistry();
  const policy = new MemoryPolicyStore(undefined, undefined, undefined, undefined, undefined, undefined, {
    resolve: (...args) => hostReady ? supported.resolve(...args)
      : Promise.resolve(err({ kind: "readinessFailed", missing: ["voiceProfile"] })),
  });
  const ledger = new MemoryLedger();
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const server = await createHostAuthenticatedDashboardServer({ surface, publicOrigin: "http://127.0.0.1:0",
    resolveActor: request => request.headers.cookie === "session=voice-owner" ? { actorRef: "voice-owner", role: "clinicAdmin", scope }
      : request.headers.cookie === "session=voice-staff" ? { actorRef: "voice-staff", role: "staff", scope } : null,
    gatewayFor: actor => new CommandGateway(actor, policy, reception),
  }, resolve(surface === "full" ? "dist/dashboard/app.js" : "dist/dashboard/cliniko-admin.js"));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return { scope, policy, ledger, reception, url, headers: { Cookie: "session=voice-owner", Origin: url },
    setReady: (value: boolean) => { hostReady = value; },
    close: () => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }) };
}
