#!/usr/bin/env python3
"""Probe a synthetic Cliniko recall lifecycle; archive every created fixture."""

import base64
import getpass
import json
import re
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.parse import quote, urlencode

from cliniko_availability_probe import ProbeError, request
from cliniko_write_probe import exact_patient


def matching_recalls(base: str, headers: dict[str, str], patient_id: str, marker: str,
                     archived: bool = False) -> list[dict]:
    filters = [f"patient_id:={patient_id}"]
    if archived:
        filters.append("archived_at:*")
    query = urlencode([("per_page", 100), *(("q[]", item) for item in filters)])
    status, body = request(base, headers, "GET", f"/recalls?{query}")
    rows = body.get("recalls")
    total = body.get("total_entries")
    if (status != 200 or not isinstance(rows, list) or not isinstance(total, int)
            or total < 0 or total > 100 or len(rows) != total):
        raise ProbeError(f"recall_reconcile_read_{status}")
    return [row for row in rows if isinstance(row, dict) and row.get("notes") == marker]


def adapter_probe(key: str, contact: str, patient_id: str, recall_id: str, marker: str,
                  archived: bool, recalled: bool) -> dict:
    result = subprocess.run(
        ["node", str(Path(__file__).with_name("cliniko_recall_adapter_probe.ts"))],
        input=json.dumps({"apiKey": key, "contactEmail": contact, "patientId": patient_id,
                          "recallId": recall_id, "marker": marker, "archived": archived, "recalled": recalled}),
        text=True, capture_output=True, cwd=Path(__file__).resolve().parents[2], timeout=60, check=False,
    )
    try:
        outcome = json.loads(result.stdout)
    except ValueError:
        raise ProbeError("adapter_output_invalid") from None
    if result.returncode != 0 or outcome.get("ok") is not True:
        raise ProbeError("typescript_recall_adapter_unproven")
    return outcome


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
    reference_id = uuid.uuid4().hex
    marker = str(uuid.uuid4())
    patient_id = None
    recall_id = None
    archived_recall = False
    archived_patient = False
    failed = False
    cleanup_failed = False
    patient_create_uncertain = False
    recall_create_uncertain = False
    print(json.dumps({"probe": "cliniko_recall_work_v1", "shard": shard}))
    try:
        status, body = request(base, headers, "GET", "/recall_types?per_page=100")
        types = body.get("recall_types")
        total = body.get("total_entries")
        if status != 200 or not isinstance(types, list) or not isinstance(total, int) or len(types) != total or total > 100:
            raise ProbeError(f"recall_types_preflight_{status}")
        active = [item for item in types if isinstance(item, dict) and item.get("id") and not item.get("archived_at")]
        if not active:
            raise ProbeError("no_active_recall_type")
        type_id = str(active[0]["id"])
        print(json.dumps({"step": "recall_type_preflight", "http_status": status, "active_types": len(active)}))

        patient_create_uncertain = True
        status, patient = request(base, headers, "POST", "/patients", {
            "first_name": "Abby", "last_name": "SyntheticRecall" + reference_id,
            "old_reference_id": reference_id,
        })
        if status != 201:
            patient_create_uncertain = False
        if status != 201 or not patient.get("id"):
            raise ProbeError(f"create_patient_{status}")
        patient_id = str(patient["id"])
        patient_create_uncertain = False
        print(json.dumps({"step": "create_synthetic_patient", "http_status": status}))

        recall_at = (datetime.now(timezone.utc).date() + timedelta(days=2)).isoformat()
        recall_create_uncertain = True
        status, recall = request(base, headers, "POST", "/recalls", {
            "patient_id": patient_id, "recall_type_id": type_id,
            "recall_at": recall_at, "notes": marker, "recalled": False,
        })
        if status != 201:
            recall_create_uncertain = False
        if status != 201 or not recall.get("id"):
            raise ProbeError(f"create_recall_{status}")
        recall_id = str(recall["id"])
        recall_create_uncertain = False
        print(json.dumps({"step": "create_recall", "http_status": status}))

        matches = matching_recalls(base, headers, patient_id, marker)
        exact = len(matches) == 1 and str(matches[0].get("id")) == recall_id
        print(json.dumps({"step": "reconcile_without_post_response", "exact_matches": len(matches), "same_recall": exact}))
        if not exact:
            raise ProbeError("exact_recall_read_unproven")

        adapter = adapter_probe(key, contact, patient_id, recall_id, marker, False, False)
        print(json.dumps({"step": "typescript_active_recall", "kind": adapter["kind"],
                          "recalled": adapter["recalled"]}))

        path = f"/recalls/{quote(recall_id, safe='')}"
        status, _ = request(base, headers, "PATCH", path, {"recalled": True})
        read_status, current = request(base, headers, "GET", path)
        marked = status == 200 and read_status == 200 and current.get("recalled") is True
        print(json.dumps({"step": "mark_recalled", "patch_status": status, "read_status": read_status, "verified": marked}))
        if not marked:
            failed = True
    except (ProbeError, URLError, TimeoutError, ValueError, KeyError, subprocess.TimeoutExpired, OSError) as error:
        failed = True
        label = str(error) if isinstance(error, ProbeError) else type(error).__name__
        print(json.dumps({"error": label}), file=sys.stderr)
    finally:
        if not patient_id:
            try:
                patient_id, count = exact_patient(base, headers, reference_id)
                if count > 1:
                    cleanup_failed = True
                if count == 0 and patient_create_uncertain:
                    cleanup_failed = True
                print(json.dumps({"step": "locate_patient_for_cleanup", "exact_matches": count}))
            except (ProbeError, URLError, TimeoutError, ValueError, KeyError):
                cleanup_failed = True
                print(json.dumps({"step": "locate_patient_for_cleanup", "verified": False}))
        if patient_id and not recall_id:
            try:
                matches = matching_recalls(base, headers, patient_id, marker)
                if len(matches) == 1:
                    recall_id = str(matches[0]["id"])
                elif len(matches) > 1:
                    cleanup_failed = True
                elif recall_create_uncertain:
                    cleanup_failed = True
                print(json.dumps({"step": "locate_recall_for_cleanup", "exact_matches": len(matches)}))
            except (ProbeError, URLError, TimeoutError, ValueError, KeyError):
                cleanup_failed = True
                print(json.dumps({"step": "locate_recall_for_cleanup", "verified": False}))
        if recall_id:
            try:
                path = f"/recalls/{quote(recall_id, safe='')}"
                status, _ = request(base, headers, "POST", path + "/archive")
                matches = matching_recalls(base, headers, patient_id, marker, archived=True)
                archived_recall = (status == 204 and len(matches) == 1
                                   and str(matches[0].get("id")) == recall_id
                                   and bool(matches[0].get("archived_at")))
                print(json.dumps({"step": "archive_recall", "http_status": status, "verified": archived_recall}))
                cleanup_failed |= not archived_recall
            except (ProbeError, URLError, TimeoutError, ValueError, KeyError):
                cleanup_failed = True
                print(json.dumps({"step": "archive_recall", "verified": False}))
            if archived_recall:
                try:
                    adapter = adapter_probe(key, contact, patient_id, recall_id, marker, True, True)
                    print(json.dumps({"step": "typescript_archived_recall", "kind": adapter["kind"],
                                      "archived": adapter["archived"], "recalled": adapter["recalled"]}))
                except (ProbeError, subprocess.TimeoutExpired, OSError):
                    failed = True
                    print(json.dumps({"step": "typescript_archived_recall", "verified": False}))
        if patient_id and (not recall_create_uncertain or archived_recall) and not cleanup_failed:
            try:
                path = f"/patients/{quote(patient_id, safe='')}"
                status, _ = request(base, headers, "POST", path + "/archive")
                read_status, patient = request(base, headers, "GET", path + "?" + urlencode({"q[]": "archived_at:*"}))
                archived_patient = status == 204 and read_status == 200 and bool(patient.get("archived_at"))
                print(json.dumps({"step": "archive_patient", "http_status": status, "verified": archived_patient}))
                cleanup_failed |= not archived_patient
            except (ProbeError, URLError, TimeoutError, ValueError, KeyError):
                cleanup_failed = True
                print(json.dumps({"step": "archive_patient", "verified": False}))
        if cleanup_failed:
            print("Cleanup uncertain: inspect this demo account before another write probe.", file=sys.stderr)
    return 2 if cleanup_failed else 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
