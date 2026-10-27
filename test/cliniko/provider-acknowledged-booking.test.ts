import assert from "node:assert/strict";
import test from "node:test";
import { bookingOffersFixture } from "../support/booking-offers.ts";
import { rosterPlan, syntheticRosterProvider } from "../support/roster-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { verificationNow } from "../support/caller-verification.ts";

for (const mode of ["online", "roster"] as const) test(`final ${mode} availability follows quota, proof, policy and ledger preparation and directly precedes POST`, async t => {
  const events: string[] = [];
  const delayed = new Set<string>();
  let delaying = false, sent = false, waitingPostBudget = false;
  const suspendPreparation = async (label: string) => {
    if (delayed.has(label)) return;
    delayed.add(label);
    assert.equal(sent, false, label);
    assert.equal(events.includes("finalAvailabilityComplete"), false, label);
    // Keep actual preparation pending across an event-loop turn. Assertions
    // on both sides catch dispatch while the preparation promise is unsettled.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sent, false, label);
    assert.equal(events.includes("finalAvailabilityComplete"), false, label);
  };
  const calendar = mode === "roster" ? syntheticRosterProvider() : undefined;
  const f = await bookingOffersFixture({ ...(calendar ? { availabilityPlan: rosterPlan } : {}), fetchAround: port => {
    const provider = calendar ? calendar.wrap(port) : port;
    return async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST" && path === "/v1/individual_appointments") sent = true;
      events.push(`dispatch:${init?.method ?? "GET"}:${new URL(String(input)).pathname}`);
      const response = await provider(input, init);
      if (delaying && !sent && path.startsWith("/v1/patients/")) await suspendPreparation("patientContact");
      events.push(`native:${init?.method ?? "GET"}:${new URL(String(input)).pathname}`);
      return response;
    };
  } });
  try {
    const proof = await f.verify(), listed = resultValue(await f.list(proof));
    resultValue(await f.propose(proof, "ordered-proposal", listed.choices[0]!.offerRef));
    resultValue(await f.confirm());
    const trace = <T extends object, K extends keyof T>(object: T, method: K, label: string) => {
      const original = object[method] as (...args: unknown[]) => Promise<unknown>;
      t.mock.method(object, method as never, async (...args: unknown[]) => {
        events.push(`${label}:begin`);
        const value = await original.apply(object, args);
        if (!sent) await suspendPreparation(label);
        events.push(`${label}:end`);
        return value;
      });
    };
    trace(f.ledger, "read", "ledger");
    trace(f.ledger, "readWriteStop", "writeStop");
    trace(f.policies, "read", "settings");
    trace(f.bookingPolicy, "current", "approvalFile");
    trace(f.session.proof, "verifyOperation", "patientProof");
    const budget = f.ownerPorts.rateBudget, claim = budget.claim.bind(budget);
    t.mock.method(budget, "claim", async () => {
      const result = await claim();
      if (waitingPostBudget) { waitingPostBudget = false; await suspendPreparation("postBudget"); }
      return result;
    });
    const write = f.writer.writeOnce.bind(f.writer);
    t.mock.method(f.writer, "writeOnce", (...[request, signal, beforeSend, onAccepted, atDispatch]: Parameters<typeof write>) => {
      waitingPostBudget = true;
      return write(request, signal, async stop => {
        // The writer has already claimed its actual POST budget at this point.
        events.length = 0;
        events.push("postBudgetClaimed");
        return beforeSend!(stop);
      }, receipt => { events.push("acknowledged"); onAccepted?.(receipt); }, atDispatch);
    });
    const finalRead = f.source.resolveForSend.bind(f.source);
    t.mock.method(f.source, "resolveForSend", async (...args: Parameters<typeof finalRead>) => {
      const read = await finalRead(...args);
      events.push("finalAvailabilityComplete");
      return read;
    });
    delaying = true; resultValue(await f.drain());
    assert.equal(f.posts, 1);
    for (const label of ["patientContact", "patientProof", "approvalFile", "postBudget"])
      assert.equal(delayed.has(label), true, `actual ${label} preparation was suspended`);
    assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    const lastRead = events.indexOf("finalAvailabilityComplete"), ack = events.indexOf("acknowledged");
    assert.ok(lastRead > 0 && ack > lastRead, JSON.stringify(events));
    assert.ok(events.indexOf("patientProof:end") > 0);
    assert.ok(events.indexOf("approvalFile:end") > 0);
    const dispatch = events.indexOf("dispatch:POST:/v1/individual_appointments");
    assert.ok(dispatch > lastRead && ack > dispatch);
    assert.deepEqual(events.slice(lastRead + 1, dispatch), [], "no awaited preparation may trail final availability before transport invocation");
    const observation = events.map(event => mode === "online" ? event.startsWith("native:GET:") && event.endsWith("/available_times") :
      /native:GET:\/v1\/(daily_availabilities|availability_blocks|individual_appointments|group_appointments|unavailable_blocks)$/.test(event)).lastIndexOf(true);
    assert.ok(observation > 0);
    assert.deepEqual(events.slice(observation + 1, lastRead), [], "no metadata, policy, proof or ledger read may follow the native observation");
    assert.equal(f.traffic.some(path => path.startsWith("GET /v1/individual_appointments/91")), false);
  } finally { await f.close(); }
});

for (const fault of ["slotGone", "expired", "proofRevoked", "disconnected", "quota"] as const) test(`final online dispatch refuses ${fault} without a create or replay`, async t => {
  const budget = new ClinikoReadBudget(200, () => Date.parse(verificationNow));
  const f = await bookingOffersFixture({ budget });
  try {
    const proof = await f.verify(), listed = resultValue(await f.list(proof));
    resultValue(await f.propose(proof, "final-refusal", listed.choices[0]!.offerRef));
    resultValue(await f.confirm());
    const write = f.writer.writeOnce.bind(f.writer);
    t.mock.method(f.writer, "writeOnce", (...[request, signal, beforeSend, onAccepted, atDispatch]: Parameters<typeof write>) => {
      // Arm after review/preflight, precisely at the final send path.
      if (fault === "quota") for (let i = 0; i < 200; i++) budget.claim();
      if (fault === "slotGone") f.setStarts([]);
      if (fault === "expired") f.setTime("2026-10-04T06:05:00.000Z");
      if (fault === "proofRevoked") f.session.proof.revoke();
      if (fault === "disconnected") f.host.dispose();
      return write(request, signal, beforeSend, onAccepted, atDispatch);
    });
    resultValue(await f.drain());
    assert.equal(f.posts, 0);
    assert.equal(f.recalls.length, 1);
    assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
    resultValue(await f.drain());
    assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test("local expiry and proof invalidation after final availability still prevent transport invocation", async t => {
  for (const fault of ["expiry", "proof"] as const) {
    const f = await bookingOffersFixture();
    try {
      const proof = await f.verify(), listed = resultValue(await f.list(proof));
      resultValue(await f.propose(proof, "late-local-change", listed.choices[0]!.offerRef)); resultValue(await f.confirm());
      const write = f.writer.writeOnce.bind(f.writer);
      t.mock.method(f.writer, "writeOnce", (...[request, signal, beforeSend, onAccepted, atDispatch]: Parameters<typeof write>) =>
        write(request, signal, async stop => {
          const permitted = await beforeSend!(stop);
          assert.equal(permitted, true);
          if (fault === "expiry") f.setTime("2026-10-04T06:05:00.000Z");
          else f.session.proof.revoke();
          return permitted;
        }, onAccepted, atDispatch));
      resultValue(await f.drain());
      assert.equal(f.recalls.length, 1); assert.equal(f.posts, 0);
      assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
    } finally { await f.close(); }
  }
});
