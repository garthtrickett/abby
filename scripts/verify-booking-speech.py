"""Verify fixed synthetic booking artifacts and ASR evidence without a provider call.

This checks stored bytes, source bindings and scoring arithmetic. It cannot
establish acoustic word fidelity, human comprehension or carrier readiness.
"""
import argparse
import collections
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import wave

ROOT = Path(__file__).resolve().parents[1]
GENERATION_SOURCES = {"scripts/build-booking-transcription-fixtures.ts", "scripts/lib/booking-speech-fixtures.ts", "src/voice/openai-realtime-speech-synthesis.ts", "src/voice/transport-media-normalizer.ts"}
EVALUATION_SOURCES = {"scripts/evaluate-booking-transcription.ts", "scripts/lib/booking-speech-fixtures.ts", "src/voice/openai-realtime-transcription.ts", "src/voice/transcription-evaluation.ts", "src/voice/transcription-evaluation-gate.ts"}
THRESHOLDS = {"version": "transcription-synthetic-gate-v1", "minRepeatsPerCase": 3, "maxCritical": 0, "maxProviderFailures": 0, "maxEmpty": 0, "maxTruncated": 0, "maxWordErrorRate": 0.1, "maxFinalP95Ms": 2500, "maxIndividualFinalMs": 5000}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def private(path):
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077
    return path.read_bytes()

def source_checks(rows, expected):
    assert len(rows) == len(expected) and {row["path"] for row in rows} == expected
    for row in rows:
        assert digest((ROOT / row["path"]).read_bytes()) == row["sha256"]

def ffmpeg(args, data):
    return subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", *args], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout

def words(text):
    return re.findall(r"[^\W_]+", text.lower(), flags=re.UNICODE)

def distance(left, right):
    row = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        nxt = [i]
        for j, b in enumerate(right, 1):
            nxt.append(min(nxt[-1] + 1, row[j] + 1, row[j - 1] + (a != b)))
        row = nxt
    return row[-1]

def assessment(cases, rows):
    cases = {c["id"]: c for c in cases}
    seen = {key: set() for key in cases}
    edits = reference = critical = empty = truncated = delayed = 0
    times = []
    for row in rows:
        c = cases[row["caseId"]]
        assert row["repeat"] not in seen[c["id"]] and row["quality"] == "needsClarification"
        seen[c["id"]].add(row["repeat"])
        actual, expected = words(row["actualText"]), words(c["expectedText"])
        verdict = "match" if actual == expected else "critical" if any(t.lower() not in actual for t in c["criticalTerms"]) else "mismatch"
        assert row["verdict"] == verdict
        critical += verdict == "critical"
        empty += not actual
        truncated += len(actual) + 1 < len(expected) and actual == expected[:len(actual)]
        reference += len(expected)
        edits += distance(expected, actual)
        assert isinstance(row["finalMs"], (int, float)) and row["finalMs"] >= 0
        times.append(row["finalMs"])
        delayed += row["finalMs"] > 5000
    missing = [key for key, repeats in seen.items() if len(repeats) < 3]
    wer = edits / reference
    p95 = sorted(times)[math.ceil(len(times) * .95) - 1]
    failures = (["insufficientRepeats"] if missing else []) + (["critical"] if critical else []) + (["empty"] if empty else []) + (["truncated"] if truncated else []) + (["wordErrorRate"] if wer > .1 else []) + (["finalP95"] if p95 > 2500 else []) + (["delayed"] if delayed else [])
    return {"status": "fail" if failures else "pass", "failures": failures, "metrics": {"cases": len(cases), "runs": len(rows), "critical": critical, "providerFailures": 0, "empty": empty, "truncated": truncated, "delayed": delayed, "wordErrorRate": wer, "finalP95Ms": p95, "missingRepeats": missing}, "thresholds": THRESHOLDS}

def wire(pcm):
    samples = struct.unpack("<" + "h" * (len(pcm) // 2), pcm)
    output = []
    for j in range(len(samples) * 3 // 2):
        left, rem = divmod(j * 2, 3)
        a, b = samples[left], samples[min(left + 1, len(samples) - 1)]
        output.append(math.floor((a * (3 - rem) + b * rem) / 3 + .5))
    return struct.pack("<" + "h" * len(output), *output)

def main():
    if not __debug__:
        raise RuntimeError("Optimized Python cannot verify evidence because it disables assertions")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    corpus_bytes = (ROOT / "eval/transcription-booking-v1.json").read_bytes()
    assert private(args.bundle / "transcription-booking-v1.json") == corpus_bytes
    corpus = json.loads(corpus_bytes)
    assert corpus["version"] == "transcription-booking-v1" and len(corpus["cases"]) == 16
    generation_bytes = private(args.bundle / "generation.json")
    generation = json.loads(generation_bytes)
    assert generation["state"] == "completed" and generation["patientFree"] and generation["corpusSha256"] == digest(corpus_bytes)
    assert generation["humanReview"] == generation["carrier"] == "notRun" and len(generation["pairs"]) == 8
    source_checks(generation["sourceFiles"], GENERATION_SOURCES)
    cases = {row["file"]: row for row in corpus["cases"]}
    pcm_by_id = {}
    for index, pair in enumerate(generation["pairs"]):
        assert re.fullmatch(r"source-(date-time|correction|withdrawal|duration)-(coral|cedar)\.pcm", pair["source"])
        source = private(args.bundle / pair["source"])
        assert digest(source) == pair["sourceSha256"] and len(source) == pair["sourceBytes"]
        samples = struct.unpack("<" + "h" * (len(source) // 2), source)
        power = sum(x * x for x in samples)
        peak = math.sqrt(power / len(samples)) * math.sqrt(3) / math.sqrt(10)
        state = 0x4140 + index
        noise, noise_power, clipped = [], 0, 0
        for sample in samples:
            state = (state ^ (state << 13)) & 0xffffffff
            state = (state ^ (state >> 17)) & 0xffffffff
            state = (state ^ (state << 5)) & 0xffffffff
            value = math.floor(sample + (state / 0xffffffff * 2 - 1) * peak + .5)
            bounded = max(-32768, min(32767, value))
            clipped += value != bounded
            noise_power += (bounded - sample) ** 2
            noise.append(bounded)
        assert clipped == pair["clippedSamples"] == 0
        assert abs(10 * math.log10(power / noise_power) - pair["measuredPreCodecSnrDb"]) < 1e-10
        mixed = struct.pack("<" + "h" * len(noise), *noise)
        for file, original in zip(pair["files"], [source, mixed]):
            case = cases[file]
            assert case["expectedText"] == pair["text"]
            audio = private(args.bundle / file)
            assert digest(audio) == case["sha256"] and (ROOT / "eval/audio" / file).read_bytes() == audio
            mu = ffmpeg(["-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0", "-ar", "8000", "-ac", "1", "-acodec", "pcm_mulaw", "-f", "mulaw", "pipe:1"], original)
            mu += b"\xff" * (-len(mu) % 160)
            decoded = ffmpeg(["-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0", "-f", "s16le", "-ar", "8000", "-ac", "1", "pipe:1"], mu)
            assert b"".join(decoded[i:i+2] * 2 for i in range(0, len(decoded), 2)) == audio
            wave_path = args.bundle / file.replace(".pcm", ".wav")
            private(wave_path)
            with wave.open(str(wave_path), "rb") as wav:
                assert wav.getnchannels() == 1 and wav.getsampwidth() == 2 and wav.getframerate() == 16000
                assert wav.readframes(wav.getnframes()) == audio
            pcm_by_id[case["id"]] = audio
    assert len(pcm_by_id) == 16
    report_bytes = private(args.report)
    report = json.loads(report_bytes)
    assert report["schema"] == "abby.synthetic-booking-transcription.v1" and report["state"] == "completed" and report["patientFree"]
    assert report["configuration"]["model"] == "gpt-live-transcribe" and report["configuration"]["corpusSha256"] == digest(corpus_bytes)
    source_checks(report["configuration"]["sourceFiles"], EVALUATION_SOURCES)
    repeats = report["configuration"]["repeats"]
    assert isinstance(repeats, int) and 1 <= repeats <= 10
    expected_pairs = {(c["id"], r) for c in cases.values() for r in range(1, repeats + 1)}
    assert len(report["results"]) == len(report["probes"]) == len(expected_pairs)
    assert {(r["caseId"], r["repeat"]) for r in report["results"]} == expected_pairs
    assert {(r["caseId"], r["repeat"]) for r in report["probes"]} == expected_pairs
    expected_request = {"type": "session.update", "session": {"type": "transcription", "audio": {"input": {"format": {"type": "audio/pcm", "rate": 24000}, "transcription": {"model": "gpt-live-transcribe"}, "turn_detection": None}}}}
    wires = {key: wire(pcm) for key, pcm in pcm_by_id.items()}
    for probe in report["probes"]:
        assert probe["request"] == expected_request and probe["commits"] == 1
        ack = probe["acknowledgment"]
        assert ack["type"] == "transcription"
        a = ack["audioInput"]
        assert a["format"] == {"type": "audio/pcm", "rate": 24000} and a["turn_detection"] is None and a["noise_reduction"] is None
        assert a["transcription"]["model"] == "gpt-live-transcribe"
        assert all(a["transcription"].get(k) in (None, "", []) for k in ["prompt", "language", "languages", "keywords"])
        data = wires[probe["caseId"]]
        assert probe["audioBytes"] == len(data) and probe["audioSha256"] == digest(data)
    assert collections.Counter(r["verdict"] for r in report["results"]) == {k: v for k, v in report["counts"].items() if v}
    assert assessment(list(cases.values()), report["results"]) == report["assessment"]
    for group in report["groups"]:
        selected = [c for c in cases.values() if c["category"].endswith("-" + group["condition"])]
        ids = {c["id"] for c in selected}
        assert assessment(selected, [r for r in report["results"] if r["caseId"] in ids]) == group["assessment"]
    assert report["releaseGate"] == "unverified" and report["humanReview"] == report["carrier"] == "notRun" and report["originalSpeechGate"] == "unchangedAndSeparate"
    result = {"schema": "abby.synthetic-booking-evidence-verification.v1", "generationReportSha256": digest(generation_bytes), "corpusSha256": digest(corpus_bytes), "transcriptionReportSha256": digest(report_bytes), "verifierSha256": digest(Path(__file__).read_bytes()), "patientFree": True, "sources": 8, "telephoneClips": 16, "wavExports": 16, "verifiedCaseRepeats": len(expected_pairs), "wireHashesVerified": len(expected_pairs), "counts": report["counts"], "assessment": report["assessment"], "groups": report["groups"], "limits": ["Provider-reported synthesis word matching is not independent acoustic fidelity", "Same provider generated and recognized the new voices", "Timing verification recomputes stored arithmetic, not network or audible playback", "Original noisy/safety gates remain separate and failing", "Human and carrier acceptance remain unrun"], "releaseGate": "unverified"}
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    print(json.dumps({key: result[key] for key in ["sources", "telephoneClips", "wavExports", "verifiedCaseRepeats", "wireHashesVerified", "counts", "releaseGate"]}))

if __name__ == "__main__":
    main()
