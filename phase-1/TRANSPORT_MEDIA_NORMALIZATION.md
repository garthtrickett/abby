# Transport media normalization

`TransportMediaNormalizer` sits after an authenticated transport has fixed the call's input encoding. It accepts bounded 10–100 ms frames of either G.711 μ-law at 8 kHz (`pcmu/8000`) or mono little-endian PCM16 at 16 kHz (`pcm16le/16000`). It copies each input and emits Abby's canonical mono PCM16LE at 16 kHz with the original session ID, sequence, and capture time. G.711 samples are decoded and duplicated to 16 kHz. The voice session, call runtime, and ledger never see a codec choice or raw provider payload.

The adapter rejects malformed identity, timestamps, sample alignment, and frame duration before media enters endpointing. The existing `MediaTurnController` still owns sequence and timing checks. The two encodings pass the same synthetic frame and call-outcome journey; this proves the adapter boundary and control flow, not live telephony, speech-recognition accuracy, or authenticated provider callbacks. A production transport must verify its own provider events, negotiate the declared encoding, and test playback, transfer, disconnect, and fallback on a real connection.

G.711 μ-law's 8 kHz definition follows [RFC 3551](https://www.rfc-editor.org/rfc/rfc3551); the companding format is defined by [ITU-T G.711](https://www.itu.int/rec/T-REC-G.711).
