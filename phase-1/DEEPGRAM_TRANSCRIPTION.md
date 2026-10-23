# Optional Deepgram transcription experiment

The owner selected an optional Deepgram experiment on 23 October 2026. The
`DeepgramStreamingTranscription` adapter implements the existing
[`TranscriptionPort`](../src/voice/media-turn-controller.ts). Abby retains
turn detection, clarification and clinic workflow ownership; Twilio retains
carrier transport. This experiment adds no Vapi runtime or production selector.

## Protocol and ownership

The initial profile requests Nova-3, English, mono PCM16 at 16 kHz, with provider
endpointing and interim results disabled. Audio is streamed unchanged. No clinic
prompt, answer vocabulary, key terms, transcript replacement or numeral formatting
is added. Requests opt out of the model-improvement program; this does not itself
establish the project's retention policy or clinical acceptance.

Each Abby generation owns a separate WebSocket. Abby's `flush` sends `CloseStream`.
The adapter waits for final segments, a mono summary matching the submitted audio
duration within 1 ms, and a normal provider close. Partial results, confidence,
`speech_final` and `from_finalize` cannot finish an Abby turn. This follows the
[CloseStream contract](https://developers.deepgram.com/docs/close-stream);
[Finalize acknowledgements are not guaranteed](https://developers.deepgram.com/docs/finalize).

Connect and flush each have a two-second adapter deadline, in addition to the
caller's abort signal. Audio/backpressure is bounded at one million bytes,
messages at 64,000 bytes, text at 4,096 characters and final segments at 128.
Failure/cancellation retires the stream without replay or partial success.
Retired socket callbacks cannot affect a later generation. Successful transcripts
remain `needsClarification`; they do not grant patient or action authority.

## Fixed synthetic evaluation

Supply `ABBY_DEEPGRAM_API_KEY` privately in the process environment, then run:

```sh
node scripts/evaluate-deepgram-transcription.ts \
  --corpus transcription-noise-v1 --out /private/evidence/deepgram-noise.json
```

The evaluator accepts only the committed noisy, telephone or safety corpora and
verifies every original audio hash. It always uses three repeats and concurrency
two. Reports are newly created with mode `0600`; their transcripts are synthetic.
Do not use this command to send patient audio. The existing OpenAI evaluator,
default voice runner and its fixture-only custom-factory restriction are unchanged.

The [first 18-run result](../eval/baselines/deepgram-nova3-noise-20261023-v1.json)
is a completed quality failure: six critical runs, 20.45% WER and 396 ms final
p95, with zero provider failures, empty, truncated or delayed results. All three
telephony-noise booking requests lose the booking verb, and all three corresponding
urgent-language cases lose the chest-pain terms. Fast completion does not pass
the original zero-critical and at-most-10% WER gates.

No clean/safety follow-on was run after the noise failure. This candidate is not
promoted. The four-input release assessor still supports its existing declared
profiles; a Deepgram report is not an OpenAI profile or a replacement default set.
Representative-call, real clinic/provider/carrier and activation acceptance remain
separate. The remaining speech requirement stays open.
