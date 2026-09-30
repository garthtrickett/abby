import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import twilio from "twilio";

type Response = { toString(): string };
type Handler = (context: Record<string, unknown>, event: unknown,
  callback: (error: Error | null, response?: Response) => void) => void;

function loadHandler(): Handler {
  const exports: { handler?: Handler } = {};
  const source = readFileSync(new URL("../../deploy/voice/twilio-number-fallback.js", import.meta.url), "utf8");
  runInNewContext(source, { exports, Twilio: { twiml: twilio.twiml } });
  assert.equal(typeof exports.handler, "function");
  return exports.handler!;
}

test("E2E-183 independent fallback Function dials only the configured destination", () => {
  let calls = 0;
  loadHandler()({ ABBY_FALLBACK_NUMBER: "+6125550188" }, {}, (error, response) => {
    calls += 1;
    assert.equal(error, null);
    assert.equal(response?.toString(),
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial>+6125550188</Dial></Response>');
  });
  assert.equal(calls, 1);
});

test("E2E-183 independent fallback Function fails closed on missing or malformed destination", () => {
  for (const destination of [undefined, "", "6125550188", "+6125550188, +6125550199", "+0123"]) {
    let calls = 0;
    loadHandler()({ ABBY_FALLBACK_NUMBER: destination }, {}, (error, response) => {
      calls += 1;
      assert.equal(error?.message, "fallback destination unavailable");
      assert.equal(response, undefined);
    });
    assert.equal(calls, 1);
  }
});
