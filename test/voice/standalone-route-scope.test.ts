import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { ok } from "../../src/core/model.ts";
import { createStandaloneClinikoVoiceServer } from "../../src/standalone/cliniko-voice-server.ts";
import type { ClinikoVoiceRoute } from "../../src/standalone/cliniko-voice-server.ts";
import { connectPostgres } from "../../src/storage/connect.ts";

test("E2E-154 standalone voice refuses a Cliniko reader bound to another clinic before opening a listener",
  async () => {
    // An unreachable endpoint proves route validation runs before any database preflight.
    const db = connectPostgres("postgresql://postgres@127.0.0.1:1/unused");
    const readerScope = { tenantId: "tenant-a", clinicId: "clinic-a", locationId: "main" };
    const routeScopes = [{ ...readerScope, tenantId: "tenant-b" },
      { ...readerScope, clinicId: "clinic-b" }, { ...readerScope, locationId: "other" }];
    let providerReads = 0;
    const reader = ClinikoAvailabilityReader.create({ scope: readerScope, apiKey: "synthetic-key-au5",
      contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
    async () => { providerReads += 1; throw new Error("provider must not be read"); });
    assert.ok(reader.ok);
    assert.equal(reader.value.matchesScope(readerScope), true);
    try {
      for (const routeScope of routeScopes) {
        assert.equal(reader.value.matchesScope(routeScope), false);
        await assert.rejects(createStandaloneClinikoVoiceServer({ db,
          twilio: { accountSid: `AC${"1".repeat(32)}`, authToken: "synthetic-route-token",
            publicWebhookUrl: "https://calls.example.test/twilio/inbound",
            publicStreamUrl: "wss://calls.example.test/twilio/media/",
            fallbackNumbers: { "+6125550199": "+6125550188" }, bindingKey: Buffer.alloc(32, 0x46) },
          routes: [{ dialedNumber: "+6125550199", scope: routeScope, routeVersion: "v1",
            availability: reader.value, clinicDate: () => "2026-09-29",
            keypadAvailabilityGreeting: { scope: routeScope, version: "route-keypad-v1",
              ownerRef: "synthetic-clinic-approval", approved: true,
              approvedText: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow." } }],
          openai: { apiKey: "synthetic-openai-key", intentModel: "configured-model" },
          readiness: async () => ok(true),
        }), /invalid clinic voice route/);
      }
      assert.equal(providerReads, 0);
    } finally { await db.destroy(); }
  });

test("E2E-155 standalone voice refuses a missing or unapproved usable keypad route before startup",
  async () => {
    const db = connectPostgres("postgresql://postgres@127.0.0.1:1/unused");
    const scope = { tenantId: "tenant-a", clinicId: "clinic-a", locationId: "main" };
    let providerReads = 0;
    const reader = ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5",
      contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
    async () => { providerReads += 1; throw new Error("provider must not be read"); });
    assert.ok(reader.ok);
    const approved = { scope, version: "keypad-v1", ownerRef: "clinic-owner", approved: true,
      approvedText: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow." };
    const invalidGreetings = [undefined, { ...approved, approved: false },
      { ...approved, approvedText: "This is Abby, an AI receptionist." },
      { ...approved, scope: { ...scope, clinicId: "other-clinic" } }];
    try {
      for (const greeting of invalidGreetings) {
        const route = { dialedNumber: "+6125550199", scope, routeVersion: "v1",
          availability: reader.value, clinicDate: () => "2026-09-29",
          keypadAvailabilityGreeting: greeting } as unknown as ClinikoVoiceRoute;
        await assert.rejects(createStandaloneClinikoVoiceServer({ db,
          twilio: { accountSid: `AC${"1".repeat(32)}`, authToken: "synthetic-route-token",
            publicWebhookUrl: "https://calls.example.test/twilio/inbound",
            publicStreamUrl: "wss://calls.example.test/twilio/media/",
            fallbackNumbers: { "+6125550199": "+6125550188" }, bindingKey: Buffer.alloc(32, 0x46) },
          routes: [route], openai: { apiKey: "synthetic-openai-key", intentModel: "configured-model" },
          readiness: async () => ok(true),
        }), /invalid keypad availability greeting/);
      }
      assert.equal(providerReads, 0);
    } finally { await db.destroy(); }
  });
