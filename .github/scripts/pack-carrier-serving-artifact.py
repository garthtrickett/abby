#!/usr/bin/env python3
"""Pack exact, source-pinned JS outputs for an offline restricted carrier test."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

REQUIRED = {
    "scripts/serve-twilio-rehearsal-gateway.js",
    "scripts/serve-twilio-rehearsal.js",
    "scripts/rehearse-twilio-probe.js",
}


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def git(source: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(source), *args], check=True,
                          capture_output=True, text=True, timeout=20).stdout.strip()


def pack(source: Path, expected: str, destination: Path) -> dict[str, object]:
    if not re.fullmatch(r"[0-9a-f]{40}", expected) or git(source, "rev-parse", "HEAD") != expected:
        raise ValueError("Exact checked-out source head required")
    if git(source, "diff", "--name-only") or git(source, "diff", "--cached", "--name-only"):
        raise ValueError("Tracked source changed during build")
    if destination.exists() or destination.is_symlink():
        raise ValueError("Use a new artifact directory")
    root = source / "dist/runtime"
    if not root.is_dir() or root.is_symlink():
        raise ValueError("Compiled runtime directory missing")
    entries = list(root.rglob("*"))
    if any(path.is_symlink() or not (path.is_file() or path.is_dir()) for path in entries):
        raise ValueError("Compiled runtime contains a symlink or special file")
    if any(part.startswith(".") for path in entries for part in path.relative_to(root).parts):
        raise ValueError("Compiled runtime contains a hidden path")
    files = {str(path.relative_to(root)): path for path in entries if path.is_file()}
    missing = sorted(REQUIRED - files.keys())
    if missing:
        raise ValueError("Compiled carrier entrypoint missing: " + ", ".join(missing))
    if len(files) > 5000 or sum(path.stat().st_size for path in files.values()) > 200_000_000:
        raise ValueError("Compiled runtime output set exceeds bounds")
    destination.mkdir(mode=0o700)
    copied = destination / "runtime"
    copied.mkdir(mode=0o700)
    for name, path in sorted(files.items()):
        target = copied / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    manifest: dict[str, object] = {
        "at": datetime.now(timezone.utc).isoformat(),
        "sourceHead": expected,
        "lockSha256": digest(source / "package-lock.json"),
        "outputCount": len(files),
        "outputs": {name: digest(copied / name) for name in sorted(files)},
        "providerMutationMade": False,
        "callsPlaced": 0,
    }
    target = destination / "manifest.json"
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(manifest, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    return {"sourceHead": expected, "outputCount": len(files),
            "manifestSha256": digest(target)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--expected", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(pack(args.source.resolve(), args.expected, args.output.resolve())))


if __name__ == "__main__":
    main()
