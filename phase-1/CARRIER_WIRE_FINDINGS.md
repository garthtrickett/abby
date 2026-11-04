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

A later restricted main `0aa4457c` call passed dialogue and normal hangup without
an unexpected child leg. Its interruption call had only one completed playback
and remains unverified. A separate fresh fallback call passed signed ringing
and independent exact-child readback. After the scripted caller gained a
20-second settling interval, a fresh main `6b0ce9fe` interruption call passed
with two turns, two completed playbacks, one interruption and one acknowledged
clear. The original overload and keypad failures remain historical failures;
these later selected passes do not diagnose the original queue-overflow cause
or establish broader interruption reliability. See the [current carrier
rehearsal evidence](AUTOMATED_CARRIER_REHEARSAL.md).

These are fixed public test phrases on an allowlisted diagnostic server. They
supply no clinic workflow acceptance, speech-quality qualification or production
activation. Operational receipts retain call IDs privately; audio and recognized
speech are not persisted by this rehearsal.
