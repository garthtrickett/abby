import { TwilioConnectedCall } from "../../src/voice/twilio-connected-call.ts";

/** Isolated runner observation only. Never retain digits, media, text, patient
 * references or a whole ledger result, and never change receive's result. */
export function observeSyntheticWire(): void {
  if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1")
    throw new Error("isolated synthetic wire observer required");
  const receive = TwilioConnectedCall.prototype.receive;
  TwilioConnectedCall.prototype.receive = function(this: TwilioConnectedCall, raw: string | Uint8Array) {
    let event: "mark" | "dtmf" | undefined, sequence: number | undefined;
    try {
      const value = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
      if ((value.event === "mark" || value.event === "dtmf") && /^\d{1,8}$/.test(value.sequenceNumber)) {
        event = value.event; sequence = Number(value.sequenceNumber);
      }
    } catch { /* The real receiver validates every frame. */ }
    const received = receive.call(this, raw);
    if (!event) return received;
    return received.then(result => {
      try {
        const state = result.ok && result.value.kind === "played" ? result.value.value : undefined;
        process.send?.({ kind: "wireProcessed", event, sequence, accepted: result.ok,
          progress: result.ok ? result.value.kind : result.error.kind,
          ...(state && "presentations" in state ? { lifecycle: state.lifecycle,
            pendingPresentation: state.pendingPresentationId !== undefined,
            presentations: Object.values(state.presentations).map(item => ({ kind: item.kind, status: item.status })) } : {}) });
      } catch { /* Diagnostics cannot veto or replace an accepted frame. */ }
      return result;
    });
  };
}
