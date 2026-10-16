import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SmtpPatientCodeDelivery } from "../../src/standalone/smtp-patient-code-delivery.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import { callerVerificationFixture, verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

describe("fixed verification email over real TLS SMTP", { concurrency: 2 }, () => {
  test("E2E-294 encrypted SMTP accepts one exact verification message and an actual caller verifies its code", async () => {
    await withSmtpVerificationServer(async smtp => {
      const delivery = new SmtpPatientCodeDelivery(smtp.config), f = await callerVerificationFixture({ delivery });
      try {
        f.session.begin(); await smtp.receivedData;
        assert.equal(smtp.messages.length, 1); const message = smtp.messages[0]!;
        assert.match(message, /To: registered-session@example.test\r\n/);
        assert.match(message, /Subject: Your clinic verification code\r\n/);
        assert.equal(message.includes(verificationCanaries[1]!), false);
        const code = /^Verification code: ([0-9]{6})$/m.exec(message)?.[1]; assert.ok(code);
        assert.equal((await f.session.submitCode(code)).verified, true);
        const proof = await f.session.verified(); assert.ok(proof);
        const response = resultValue(await f.read(proof.verificationRef));
        assert.equal(response.kind, "appointmentAnswer");
        assert.ok(f.provider.includes("/v1/individual_appointments"), "actual proof permits the protected provider read");
        for (const secret of [code, ...verificationCanaries.slice(0, 2)]) assert.equal(JSON.stringify([response, await f.state()]).includes(secret), false);
        f.session.begin(); assert.equal(smtp.messages.length, 1, "restarting this verifier cannot send another message");
        assert.equal(JSON.stringify(delivery).includes(smtp.config.password), false);
      } finally { await f.close(); }
    });
  });

  for (const fault of ["authRejected", "recipientRejected", "noPlain", "mixedReply", "overlongReply", "dropAfterData"] as const) {
    test(`E2E-294 SMTP ${fault} cannot become accepted delivery or retry DATA`, async () => {
      await withSmtpVerificationServer(async smtp => {
        smtp.fault(fault); const delivery = new SmtpPatientCodeDelivery(smtp.config);
        assert.equal(await delivery.send("patient@example.test", "123456", new AbortController().signal), false);
        assert.equal(smtp.messages.length, fault === "dropAfterData" ? 1 : 0);
        assert.ok(smtp.commands.filter(c => c === "DATA").length <= 1);
      });
    });
  }
  test("E2E-294 certificate identity and trust failure stop before SMTP credentials", async () => {
    await withSmtpVerificationServer(async smtp => {
      assert.equal(await new SmtpPatientCodeDelivery(smtp.config).send("patient@example.test", "123456", new AbortController().signal), false);
      assert.equal(smtp.commands.length, 0);
    }, "wrong");
    await withSmtpVerificationServer(async smtp => {
      const { ca: _ca, ...config } = smtp.config; void _ca;
      assert.equal(await new SmtpPatientCodeDelivery(config).send("patient@example.test", "123456", new AbortController().signal), false);
      assert.equal(smtp.commands.length, 0);
    });
  });
  test("E2E-294 invalid recipients/codes and prior abort perform no SMTP commands", async () => {
    await withSmtpVerificationServer(async smtp => {
      const delivery = new SmtpPatientCodeDelivery(smtp.config), stopped = new AbortController(); stopped.abort();
      assert.equal(await delivery.send("patient@example.test", "123456", stopped.signal), false);
      for (const [email, code] of [["patient@example.test\r\nRCPT TO:<other@example.test>", "123456"], ["patient@example.test", "123456\r\n."], ["bad", "123456"]]) {
        assert.equal(await delivery.send(email!, code!, new AbortController().signal), false);
      }
      assert.equal(smtp.commands.length, 0);
    });
  });
  test("E2E-294 abort after DATA and a silent server finish within the original transaction deadline", async () => {
    await withSmtpVerificationServer(async smtp => {
      smtp.fault("stallData"); const stop = new AbortController();
      const sent = new SmtpPatientCodeDelivery(smtp.config).send("patient@example.test", "123456", stop.signal);
      await smtp.receivedData; stop.abort(); assert.equal(await sent, false); assert.equal(smtp.messages.length, 1);
    });
    await withSmtpVerificationServer(async smtp => {
      smtp.fault("stallGreeting"); const started = performance.now();
      assert.equal(await new SmtpPatientCodeDelivery({ ...smtp.config, timeoutMs: 100 }).send("patient@example.test", "123456", new AbortController().signal), false);
      assert.ok(performance.now() - started < 1_000);
    });
  });

  test("E2E-294 unknown SMTP submission leaves the actual verifier unverified and does not resend", async () => {
    await withSmtpVerificationServer(async smtp => {
      smtp.fault("dropAfterData"); const f = await callerVerificationFixture({ delivery: new SmtpPatientCodeDelivery(smtp.config) });
      try {
        f.session.begin(); await smtp.receivedData;
        const code = /^Verification code: ([0-9]{6})$/m.exec(smtp.messages[0]!)?.[1]; assert.ok(code);
        assert.equal((await f.session.submitCode(code)).verified, false); assert.equal(await f.session.verified(), undefined);
        f.session.begin(); assert.equal(smtp.messages.length, 1);
        assert.equal(f.provider.some(path => path === "/v1/individual_appointments"), false);
      } finally { await f.close(); }
    });
  });

  test("E2E-294 independent clinic permission is required before real SMTP submission", async () => {
    await withSmtpVerificationServer(async smtp => {
      const f = await callerVerificationFixture({ delivery: new SmtpPatientCodeDelivery(smtp.config) });
      try {
        f.setPermitted(false); f.session.begin();
        assert.equal((await f.session.submitCode("123456")).verified, false);
        assert.equal(smtp.commands.length, 0); assert.equal(smtp.messages.length, 0);
      } finally { await f.close(); }
    });
  });
});
