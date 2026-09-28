#!/usr/bin/env python3
"""Test exact synthetic patient filters through the TypeScript adapter, then archive."""

import base64
import getpass
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.error import URLError
from urllib.parse import quote, urlencode

from cliniko_availability_probe import ProbeError, request


def find_marked_patient(base: str, headers: dict[str, str], marker: str) -> tuple[str | None, int]:
    query = urlencode({"per_page": 2, "q[]": f"old_reference_id:={marker}"})
    status, data = request(base, headers, "GET", f"/patients?{query}")
    if status != 200 or not isinstance(data.get("patients"), list):
        raise ProbeError(f"reconcile_patient_{status}")
    matches = [row for row in data["patients"] if row.get("old_reference_id") == marker]
    return (str(matches[0]["id"]) if len(matches) == 1 else None), len(matches)


def main() -> int:
    if not sys.stdin.isatty():
        print("Run in a terminal so the API key is hidden.", file=sys.stderr)
        return 2
    contact = input("Cliniko API contact email: ").strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", contact):
        print("Invalid contact email.", file=sys.stderr)
        return 2
    key = getpass.getpass("Cliniko API key (hidden): ").strip()
    shard = key.rpartition("-")[2]
    if not re.fullmatch(r"[a-z]{2}[0-9]+", shard):
        print("Invalid key shard suffix.", file=sys.stderr)
        return 2
    base = f"https://api.{shard}.cliniko.com/v1"
    headers = {
        "Accept": "application/json",
        "Authorization": "Basic " + base64.b64encode(f"{key}:".encode()).decode(),
        "Content-Type": "application/json",
        "User-Agent": f"Abby Phase 0 ({contact})",
    }
    marker = uuid.uuid4().hex
    markers = [marker + "a", marker + "b"]
    email = f"abby-probe+{marker}@example.test"
    date_of_birth = "1990-05-21"
    attempted = []
    patient_ids = {}
    failed = False
    cleanup_failed = False
    print(json.dumps({"probe": "cliniko_patient_candidate_v1", "shard": shard}))
    try:
        for index, candidate_marker in enumerate(markers):
            attempted.append(candidate_marker)
            status, patient = request(base, headers, "POST", "/patients", {
                "first_name": "Abby", "last_name": "SyntheticProbe" + candidate_marker,
                "old_reference_id": candidate_marker, "email": email, "date_of_birth": date_of_birth,
            })
            if status != 201 or not patient.get("id"):
                raise ProbeError(f"create_patient_{index + 1}_{status}")
            patient_ids[candidate_marker] = str(patient["id"])
            print(json.dumps({"step": "create_synthetic_patient", "index": index + 1, "http_status": status}))

            expected = "one" if index == 0 else "ambiguous"
            result = subprocess.run(
                ["node", str(Path(__file__).with_name("cliniko_patient_adapter_probe.ts"))],
                input=json.dumps({"apiKey": key, "contactEmail": contact, "email": email,
                                  "dateOfBirth": date_of_birth, "wrongDateOfBirth": "1990-05-22",
                                  "patientId": patient_ids[candidate_marker], "expectedKind": expected}),
                text=True, capture_output=True, cwd=Path(__file__).resolve().parents[2], timeout=60, check=False,
            )
            try:
                outcome = json.loads(result.stdout)
            except ValueError:
                raise ProbeError("adapter_output_invalid") from None
            if result.returncode != 0 or outcome.get("ok") is not True:
                raise ProbeError(f"adapter_{expected}_filter_unproven")
            print(json.dumps({"step": "typescript_adapter", "expected": expected,
                              "exact_kind": outcome["exactKind"],
                              "wrong_birth_date_kind": outcome["wrongBirthDateKind"]}))
    except (ProbeError, URLError, TimeoutError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        failed = True
        label = str(error) if isinstance(error, ProbeError) else type(error).__name__
        print(json.dumps({"error": label}), file=sys.stderr)
    finally:
        for candidate_marker in attempted:
            if candidate_marker in patient_ids:
                continue
            try:
                patient_id, count = find_marked_patient(base, headers, candidate_marker)
                if count > 1:
                    cleanup_failed = True
                    print(json.dumps({"step": "locate_for_cleanup", "exact_matches": count}))
                elif patient_id:
                    patient_ids[candidate_marker] = patient_id
                else:
                    cleanup_failed = True
                    print(json.dumps({"step": "locate_for_cleanup", "exact_matches": 0, "verified": False}))
            except (ProbeError, URLError, TimeoutError, ValueError, KeyError):
                cleanup_failed = True
                print(json.dumps({"step": "locate_for_cleanup", "verified": False}))
        for patient_id in patient_ids.values():
            path = f"/patients/{quote(patient_id, safe='')}"
            try:
                status, _ = request(base, headers, "POST", path + "/archive")
                query = urlencode({"q[]": "archived_at:*"})
                read_status, archived = request(base, headers, "GET", path + "?" + query)
                verified = status == 204 and read_status == 200 and bool(archived.get("archived_at"))
                print(json.dumps({"step": "archive_synthetic_patient", "post_status": status,
                                  "read_status": read_status, "verified": verified}))
                cleanup_failed |= not verified
            except (ProbeError, URLError, TimeoutError, ValueError, KeyError):
                cleanup_failed = True
                print(json.dumps({"step": "archive_synthetic_patient", "verified": False}))
        if cleanup_failed:
            print("Cleanup uncertain: inspect this demo account before another write probe.", file=sys.stderr)
    return 2 if cleanup_failed else 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
