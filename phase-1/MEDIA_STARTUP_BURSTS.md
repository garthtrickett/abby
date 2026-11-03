# Idle media startup bursts

A real restricted carrier call delivered enough initial quiet media in one burst
to exceed the asynchronous media queue before any speech or transcription began.
An isolated reproduction against the preserved parent submits 96 valid silent
frames synchronously and observes `mediaOverloaded` with zero speech/transcription
calls. This is independent of the separate clear/transcription latency hypothesis.

When no media work or speech candidate is pending, validated silent frames now
advance sequence and capture-time tracking synchronously. They are not retained
or sent to transcription. Voiced frames, frames behind queued work, partial
speech candidates and active utterances keep ordinary ordered processing and
the same queue cap. Session, format, sequence, timestamp and closed-state checks
precede the fast path.

Regression checks submit the same 96-frame burst, then real voiced frames and
silence endpointing. They also reject invalid silent frames and verify that
silence behind queued speech still respects the original queue limit. Existing
correction, transcription deadline, private-mode and frame-copy tests remain.

This corrects an isolated startup defect. It does not establish speech-quality,
whole-call reliability, clinic acceptance or production activation. Earlier
carrier failures and separate cold-transcription/clear timing risks remain
recorded. A later successful carrier call cannot erase those failures.
