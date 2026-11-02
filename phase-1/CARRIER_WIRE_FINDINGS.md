# Carrier wire rehearsal findings

## DTMF track correction — 2 November 2026

The restricted real-phone rehearsal exposed a mismatch between the Twilio decoder
and the provider contract: the decoder expected `dtmf.track = "inbound_track"`.
Twilio documents `"inbound"`. The decoder now accepts that documented track;
synthetic call fixtures use the same format. Wrong tracks, malformed digits,
stream identity mismatches and sequence gaps still close the stream.

Provider reference: [Media Streams DTMF message](https://www.twilio.com/docs/voice/media-streams/websocket-messages#dtmf-message).

A focused regression exercises the documented message followed by ordinary
media, and rejects the former fixture spelling plus malformed or misbound events.
Existing signed-call and private-keypad fixtures retain their original assertions.

## Rehearsal limits

One real automated greeting/hello/blue/green/hangup dialogue passed. Earlier
intermittent failures remain recorded. An intentional interruption acknowledged
the playback clear but then failed with `mediaOverloaded`; its cause remains
under investigation. The original keypad probe fell back after `invalidMedia`,
so a connected fallback leg from that probe does not prove correct keypad handling.

These are fixed public test phrases on an allowlisted diagnostic server. They
supply no clinic workflow acceptance, speech-quality qualification or production
activation. Operational receipts retain call IDs privately; audio and recognized
speech are not persisted by this rehearsal.
