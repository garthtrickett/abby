import test from "node:test";
import { financialClassVoiceJourney } from "../support/financial-class-voice-journey.ts";
for (const passes of [false, true]) test(`signed HTTP/WS class financial readback needs every real played mark and separate clinical yes (pass=${passes})`,
  { timeout: 120_000 }, () => financialClassVoiceJourney(passes));
