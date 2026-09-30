#!/usr/bin/env python3
"""Read only: locate Abby synthetic fixtures, including cancelled and archived rows."""

import base64
import getpass
import json
import os
import re
import sys
from urllib.parse import urlencode

from cliniko_availability_probe import request


def main() -> int:
    env_mode = os.environ.get("ABBY_LIVE_CLINIKO_EVAL") == "1"
    if not env_mode and not sys.stdin.isatty():
        print("Run in a terminal so the API key is hidden, or use the opt-in owner-only environment.", file=sys.stderr)
        return 2
    contact = (os.environ.get("ABBY_CLINIKO_CONTACT_EMAIL", "") if env_mode
               else input("Cliniko API contact email: ")).strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", contact):
        return 2
    key = (os.environ.get("ABBY_CLINIKO_API_KEY", "") if env_mode
           else getpass.getpass("Cliniko API key (hidden): ")).strip()
    shard = key.rpartition("-")[2]
    if not re.fullmatch(r"[a-z]{2}[0-9]+", shard):
        return 2
    base = f"https://api.{shard}.cliniko.com/v1"
    headers = {
        "Accept": "application/json",
        "Authorization": "Basic " + base64.b64encode(f"{key}:".encode()).decode(),
        "User-Agent": f"Abby Phase 0 ({contact})",
    }
    query = urlencode({"per_page": 100, "sort": "created_at:desc", "q[]": "archived_at:*"})
    status, data = request(base, headers, "GET", f"/patients?{query}")
    if status != 200 or not isinstance(data.get("patients"), list):
        print(json.dumps({"step": "patient_list", "http_status": status}))
        return 1
    patients = [row for row in data["patients"] if str(row.get("last_name", "")).startswith(("SyntheticProbe", "SyntheticConcurrency"))
                and row.get("first_name") == "Abby"]
    print(json.dumps({"step": "synthetic_patients", "count": len(patients), "archived_count": sum(bool(row.get("archived_at")) for row in patients)}))
    failed = not patients or any(not row.get("archived_at") for row in patients)
    matched_appointments = 0

    def slot_key(row: dict) -> tuple:
        return (row.get("starts_at"),
                ((row.get("business") or {}).get("links") or {}).get("self"),
                ((row.get("practitioner") or {}).get("links") or {}).get("self"),
                ((row.get("appointment_type") or {}).get("links") or {}).get("self"))

    for patient in patients:
        patient_id = str(patient["id"])
        for label, filters in (
            ("default", [f"patient_id:={patient_id}"]),
            ("all_archival_states", [f"patient_id:={patient_id}", "archived_at:*"]),
            ("all_cancellation_states", [f"patient_id:={patient_id}", "cancelled_at:*"]),
            ("all_states", [f"patient_id:={patient_id}", "archived_at:*", "cancelled_at:*"]),
        ):
            query = urlencode([("per_page", 100), *(("q[]", item) for item in filters)])
            appointment_status, appointments = request(base, headers, "GET", f"/individual_appointments?{query}")
            rows = appointments.get("individual_appointments")
            matches = [row for row in rows if str(row.get("notes", "")).startswith((
                "Abby synthetic probe ", "Abby concurrent synthetic ", "Abby booking "))] if isinstance(rows, list) else []
            print(json.dumps({
                "step": "synthetic_appointments", "view": label, "http_status": appointment_status,
                "count": len(matches), "cancelled_count": sum(bool(row.get("cancelled_at")) for row in matches),
                "archived_count": sum(bool(row.get("archived_at")) for row in matches),
                **({"same_slot": len({slot_key(row) for row in matches}) == 1 and all(slot_key(matches[0]))}
                   if label == "all_cancellation_states" and str(patient.get("last_name", "")).startswith("SyntheticConcurrency") and matches else {}),
            }))
            failed |= appointment_status != 200
            if label == "default":
                failed |= bool(matches)
            if label == "all_cancellation_states":
                matched_appointments += len(matches)
                failed |= any(not row.get("cancelled_at") for row in matches)
                if str(patient.get("last_name", "")).startswith("SyntheticConcurrency"):
                    failed |= len(matches) != 2 or len({slot_key(row) for row in matches}) != 1 or not all(slot_key(matches[0]))
    print(json.dumps({"step": "synthetic_cleanup_summary", "archived_patients": len(patients),
                      "cancelled_appointments": matched_appointments}))
    failed |= matched_appointments == 0
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
