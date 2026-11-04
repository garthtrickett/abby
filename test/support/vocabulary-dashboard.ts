import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { ClinicVocabularyReview } from "../../src/standalone/clinic-vocabulary-review.ts";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { clinicVocabularyFixture, vocabularyScope } from "./clinic-vocabulary.ts";

export async function vocabularyDashboard(browser = false, surface: "full" | "availabilitySetup" = "availabilitySetup") {
  const f = await clinicVocabularyFixture(), scope = vocabularyScope;
  const policy = new MemoryPolicyStore(), ledger = new MemoryLedger();
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const review = new ClinicVocabularyReview(f.config);
  const dummyBundle = join(f.path, "..", "dashboard-test.js");
  await writeFile(dummyBundle, "// synthetic HTTP-only bundle\n", { mode: 0o600 });
  let revokeAt = Infinity, reads = 0;
  const server = await createHostAuthenticatedDashboardServer({ publicOrigin: "http://127.0.0.1:0", surface,
    resolveActor(request) {
      if (++reads >= revokeAt) return null;
      if (request.headers.cookie === "session=owner") return { actorRef: "admin", role: "clinicAdmin", scope };
      if (request.headers.cookie === "session=staff") return { actorRef: "staff", role: "staff", scope };
      if (request.headers.cookie === "session=other") return { actorRef: "admin", role: "clinicAdmin", scope: { ...scope, clinicId: "other" } };
      return null;
    }, gatewayFor: actor => new CommandGateway(actor, policy, reception), vocabularyReviewFor: () => review,
  }, browser ? resolve(surface === "full" ? "dist/dashboard/app.js" : "dist/dashboard/cliniko-admin.js") : dummyBundle);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return { ...f, url, headers: { Cookie: "session=owner", Origin: url },
    revokeOnRead(read: number) { reads = 0; revokeAt = read; },
    async close() {
      try { await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }); }
      finally { await f.close(); }
    } };
}
