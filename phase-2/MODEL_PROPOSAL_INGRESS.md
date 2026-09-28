# Model proposal ingress

The model boundary accepts `unknown` output through `RawModelPort` and decodes it to the versioned `ModelProposal` union. A proposal is a suggestion, never a host mutation, patient proof, booking confirmation, or approved answer. The decoder rejects unknown schema versions, extra fields, missing answer evidence, duplicate source references, invalid dates, and handoff reasons that require system or host evidence. Transport exceptions and elapsed deadlines become typed failures without copying provider diagnostics into caller state.

`ModelInput` contains caller text and remains transient at this boundary. A composition must not persist it as a model effect payload until consent and retention rules authorize that storage. The [model-assisted text turn](MODEL_TEXT_TURN.md) now schedules an opaque model effect and accepts its typed result through the SAM loop. The fake-port tests require no model credentials and make no live model call.

Action proposals must obtain host-issued patient and offer evidence and caller confirmation before a write can be planned. The current text and [synthetic voice paths](MODEL_VOICE_TURN.md) send them to staff. The next work is a live model adapter and evaluation corpus, verified patient/offer lookup, and full consent-aware retention. Add a full journey for each newly exposed model behavior before enabling it for a caller.
