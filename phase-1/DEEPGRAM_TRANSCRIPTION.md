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

A predeclared [phone-call model comparison](../eval/baselines/deepgram-phonecall-noise-20261023-v1.json)
changed only the model to `nova-2-phonecall` through a private diagnostic socket
factory. Deepgram documents that model for [low-bandwidth phone calls](https://developers.deepgram.com/docs/model).
The original six clips, three repeats, concurrency two, streaming protocol and
quality thresholds stayed fixed. All 18 recognitions completed with zero provider
failures, but 12 were critical, WER was 43.18% and final p95 was 313 ms. That profile
also fails and receives no clean/safety follow-on or production selection. The
public evaluator continues to request Nova-3; the private caller and exact source
snapshot are identified in the aggregate for audit.


A second representation hypothesis used Nova-3 with [native 8 kHz PCM](../eval/baselines/deepgram-native8-noise-20261023-v1.json).
The telephone fixtures repeat each decoded sample to make canonical 16 kHz input.
An offline audit of all 17 noisy, telephone and safety clips proves that removing
one identical sample from each pair and repeating it again restores the original
bytes exactly. The private diagnostic validates every pair, sends the recovered
8 kHz samples and declares their actual rate, which the
[provider accepts](https://developers.deepgram.com/docs/sample-rate). It adds no
noise filtering, interpolation, prompt or expected-answer terms. Only the original
six noisy clips were submitted, three times each. All 18 completed with zero
provider failures, but six remain critical; WER is 15.91% and final p95 is 203 ms.
The original gates still fail, so no clean/safety follow-on or runtime selection
follows. This is a distinct private wire profile; the public adapter and evaluator
still request unchanged 16 kHz PCM.

Each comparison below has 18 runs on the same six original noisy clips. These are
failed recognition profiles, not release candidates selected by latency.

| Requested profile | Wire sample rate | Critical runs | WER | Final p95 | Provider failures |
| --- | --- | --- | --- | --- | --- |
| Nova-3 initial | 16 kHz | 6 | 20.45% | 396 ms | 0 |
| Nova-2 phonecall diagnostic | 16 kHz | 12 | 43.18% | 313 ms | 0 |
| Nova-3 exact-duplicate removal diagnostic | 8 kHz | 6 | 15.91% | 203 ms | 0 |

## Local engineering qualification

The original adapter graph passed 57 source tests: 22 adapter cases and 35
preserved transcription, controller and evaluation controls. Whole-project strict
TypeScript and the serving build passed on that graph. All 741 emitted default
serving artifacts matched the qualified parent exactly because this optional
adapter is not selected by the default runner.

The subsequent 63-case source cohort adds two actual host-boundary cases and four
preserved voice-profile controls. The existing `OpenAIVoiceProfileHost` accepts an
explicitly versioned `customTranscription` factory under its qualified profile
contract. The tests exercise that factory with real Deepgram adapter instances:
mismatched provider/runtime profiles cannot construct them, absent or withdrawn
quality evidence refuses binding, and closing one call cannot contaminate another
call's socket or transcript. Completed text remains `needsClarification`.

The tests use synthetic quality evidence only. They do not approve the failed
acoustic profiles or provide production provisioning. The current combined graph on actual normal parent `327d0c3` passes all 63
source controls without skips (1792733073928), whole-project strict TypeScript
and the serving build (1792733012707). All 741 emitted default serving artifacts
match that corrected shutdown parent exactly; the optional adapter remains
unselected. These checks include the extended test dependency graph. All three actual recognition comparisons
continue to fail their original acoustic quality gates.

## Complete-utterance diagnostics, 23 October 2026

The [Nova-3 aggregate](../eval/baselines/deepgram-complete-turn-nova3-noise-20261023-v1.json) and [Whisper aggregate](../eval/baselines/deepgram-complete-turn-whisper-noise-20261023-v1.json) bind these results to their private source snapshots and exact reports.

Two later private comparisons used the same six original noisy clips, three
repeats, concurrency two and unchanged recognition gates. They sent the entire
unchanged mono PCM16/16 kHz utterance in a lossless WAV container after Abby's own
flush. No extra silence, resampling, expected-answer terms or filtering was added.
The existing two-second finality budget was preserved. These callers and their
prototype are private experiments; the shipped optional adapter remains streaming
Nova-3 and the default voice runtime remains unchanged.

| Private complete-utterance profile | Attempts | Completed recognitions | Critical results | WER of completed recognitions | Final p95 of completed recognitions | Unavailable results | Outcome |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Nova-3 HTTP | 18 | 18 | 6 | 18.18% | 1,045 ms | 0 | Fails critical-word and WER gates |
| Requested `whisper-large` HTTP | 18 | 6 | 0 among the six returned transcripts | 0% among those six only | 850 ms among those six only | 12 | Fails availability; no full-corpus accuracy pass |

Nova-3 still loses the booking verb and chest-pain terms in the same two cases
across all three repeats. Completing a whole-utterance response does not resolve
that critical accuracy problem. This comparison does not establish the exact
cause of the earlier streaming errors.

Whisper returns three matches each for NS-001 and NS-002; all attempts for
NS-003 through NS-006 are unavailable. Successful-only accuracy and latency must
not hide those twelve failures. The original failed attempts did not retain
HTTP response status, so their exact causes are unknown. Two separate single-case
diagnostics, NS-006 and NS-004, independently abort after 2,002 and 2,024 ms before
response headers. These observations show those two requests miss the existing
budget; they do not prove rate limiting or explain every earlier unavailable
result. The two probes are not recognition qualification and do not change the
budget.

The private complete-turn protocol passes 23 local controls and scoped strict
TypeScript, including its live evaluator import graph. These results do not
qualify the actual host, serving ingress or call admission for that prototype.
No clean/safety follow-on, runtime selection or promotion follows either failure.
Representative clinic, acoustic, carrier and activation gates remain open.

Across the three earlier streaming comparisons and these two private cohorts,
there are 90 cohort attempts and 78 completed recognitions. Four complete profiles
account for 72 of those recognitions and all four fail their quality gates. The
Whisper cohort supplies six additional recognitions and twelve failures. Including
the two nonqualifying single-request probes gives 92 total requests, not 92
successful recognitions. No further unchanged model sweep or failure probe is
planned.
