#!/usr/bin/env python3
"""Probe simultaneous synthetic Cliniko bookings; reconcile and remove every fixture."""

import base64
import getpass
import json
import re
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from urllib.error import URLError
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cliniko_availability_probe import ProbeError, request, rows
from cliniko_write_probe import exact_patient


def appointments_for_patient(base: str, headers: dict[str, str], patient_id: str) -> list[dict]:
    found: list[dict] = []
    total = None
    for page in range(1, 11):
        query = urlencode({"page": page, "per_page": 100, "q[]": f"patient_id:={patient_id}"})
        status, data = request(base, headers, "GET", f"/individual_appointments?{query}")
        if status != 200 or not isinstance(data.get("individual_appointments"), list):
            raise ProbeError(f"appointment_reconcile_{status}")
        count = data.get("total_entries")
        if not isinstance(count, int) or count < 0 or count > 1000 or (total is not None and total != count):
            raise ProbeError("appointment_reconcile_count")
        total = count
        found.extend(data["individual_appointments"])
        if len(found) >= total:
            if len(found) != total:
                raise ProbeError("appointment_reconcile_page_size")
            return found
        if not data["individual_appointments"]:
            break
    raise ProbeError("appointment_reconcile_incomplete")


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
    run_marker = "Abby concurrent synthetic " + uuid.uuid4().hex
    reference_id = uuid.uuid4().hex
    patient_id = None
    patient_post_attempted = False
    created_ids: set[str] = set()
    business_path = None
    original_flag = None
    changed_business = False
    failed = False
    cleanup_failed = False
    try:
        businesses = rows(base, headers, "businesses")
        practitioners = rows(base, headers, "practitioners")
        types = rows(base, headers, "appointment_types")
        if len(businesses) != 1 or len(practitioners) != 1 or not types:
            raise ProbeError("expected_one_demo_business_and_practitioner")
        business_id = str(businesses[0]["id"])
        practitioner_id = str(practitioners[0]["id"])
        business_path = f"/businesses/{quote(business_id, safe='')}"
        status, business = request(base, headers, "GET", business_path)
        if status != 200 or str(business.get("id")) != business_id:
            raise ProbeError(f"business_detail_{status}")
        original_flag = business.get("show_in_online_bookings")
        if original_flag not in (True, False) or not isinstance(business.get("time_zone_identifier"), str):
            raise ProbeError("business_settings_invalid")
        zone = ZoneInfo(business["time_zone_identifier"])
        if not original_flag:
            changed_business = True
            status, enabled = request(base, headers, "PATCH", business_path, {"show_in_online_bookings": True})
            if status != 200 or enabled.get("show_in_online_bookings") is not True:
                raise ProbeError(f"enable_online_booking_{status}")
        target_date = (datetime.now(zone).date() + timedelta(days=2)).isoformat()
        selected_type = None
        start = None
        for item in types:
            type_id = str(item["id"])
            path = (f"/businesses/{business_id}/practitioners/{practitioner_id}"
                    f"/appointment_types/{type_id}/available_times?"
                    + urlencode({"from": target_date, "to": target_date, "per_page": 10}))
            status, data = request(base, headers, "GET", path)
            if status == 200 and isinstance(data.get("available_times"), list) and data["available_times"]:
                selected_type = type_id
                start = data["available_times"][0].get("appointment_start")
                break
        if not selected_type or not isinstance(start, str):
            raise ProbeError("no_bookable_offer")
        patient_post_attempted = True
        status, patient = request(base, headers, "POST", "/patients", {
            "first_name": "Abby", "last_name": "SyntheticConcurrency" + reference_id,
            "old_reference_id": reference_id,
        })
        if status != 201 or not patient.get("id"):
            raise ProbeError(f"create_patient_{status}")
        patient_id = str(patient["id"])
        barrier = threading.Barrier(2)

        def create(index: int) -> tuple[int, dict]:
            barrier.wait(timeout=10)
            return request(base, headers, "POST", "/individual_appointments", {
                "business_id": business_id, "practitioner_id": practitioner_id,
                "appointment_type_id": selected_type, "patient_id": patient_id,
                "starts_at": start, "notes": f"{run_marker}:{index}",
            })

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(create, index) for index in (1, 2)]
            outcomes = [future.result() for future in futures]
        for status, body in outcomes:
            if status == 201 and body.get("id"):
                created_ids.add(str(body["id"]))
        matches = [row for row in appointments_for_patient(base, headers, patient_id)
                   if str(row.get("notes", "")).startswith(run_marker + ":")]
        if len(matches) > 2 or {str(row.get("id")) for row in matches} != created_ids:
            raise ProbeError("concurrent_result_reconciliation_mismatch")
        slots = {(row.get("starts_at"),
                  ((row.get("business") or {}).get("links") or {}).get("self"),
                  ((row.get("practitioner") or {}).get("links") or {}).get("self"),
                  ((row.get("appointment_type") or {}).get("links") or {}).get("self")) for row in matches}
        same_slot = len(matches) == 2 and len(slots) == 1 and all(next(iter(slots)))
        print(json.dumps({"probe": "cliniko_concurrent_booking_v1", "shard": shard,
                          "response_statuses": sorted(status for status, _ in outcomes),
                          "exact_marker_matches": len(matches), "same_slot_both_created": same_slot}))
        if any(status not in (201, 422) for status, _ in outcomes):
            failed = True
    except (ProbeError, URLError, TimeoutError, ValueError, KeyError, ZoneInfoNotFoundError,
            threading.BrokenBarrierError) as error:
        failed = True
        label = str(error) if isinstance(error, ProbeError) else type(error).__name__
        print(json.dumps({"error": label}), file=sys.stderr)
    finally:
        if not patient_id:
            try:
                patient_id, count = exact_patient(base, headers, reference_id)
                if count > 1 or (patient_post_attempted and count != 1):
                    cleanup_failed = True
            except (ProbeError, URLError, TimeoutError, ValueError, KeyError):
                cleanup_failed = True
        if patient_id:
            try:
                matches = [row for row in appointments_for_patient(base, headers, patient_id)
                           if str(row.get("notes", "")).startswith(run_marker + ":")]
                created_ids.update(str(row["id"]) for row in matches)
            except (ProbeError, URLError, TimeoutError, ValueError, KeyError):
                cleanup_failed = True
            for appointment_id in created_ids:
                try:
                    status, _ = request(base, headers, "PATCH", f"/individual_appointments/{quote(appointment_id, safe='')}/cancel", {
                        "cancellation_reason": 50, "cancellation_note": "Abby synthetic concurrency cleanup", "apply_to_repeats": False,
                    })
                    if status != 204:
                        status, _ = request(base, headers, "POST", f"/individual_appointments/{quote(appointment_id, safe='')}/archive")
                    cleanup_failed |= status != 204
                except (ProbeError, URLError, TimeoutError, ValueError):
                    cleanup_failed = True
            try:
                remaining = [row for row in appointments_for_patient(base, headers, patient_id)
                             if str(row.get("notes", "")).startswith(run_marker + ":") and
                             not (row.get("cancelled_at") or row.get("archived_at") or row.get("deleted_at"))]
                cleanup_failed |= bool(remaining)
                print(json.dumps({"step": "cleanup_appointments", "located": len(created_ids),
                                  "active_remaining": len(remaining)}))
            except (ProbeError, URLError, TimeoutError, ValueError, KeyError):
                cleanup_failed = True
            try:
                status, _ = request(base, headers, "POST", f"/patients/{quote(patient_id, safe='')}/archive")
                cleanup_failed |= status != 204
                print(json.dumps({"step": "archive_synthetic_patient", "http_status": status}))
            except (ProbeError, URLError, TimeoutError, ValueError):
                cleanup_failed = True
        if changed_business and business_path is not None:
            try:
                status, _ = request(base, headers, "PATCH", business_path, {"show_in_online_bookings": original_flag})
                verify_status, business = request(base, headers, "GET", business_path)
                restored = status == 200 and verify_status == 200 and business.get("show_in_online_bookings") is original_flag
                cleanup_failed |= not restored
                print(json.dumps({"step": "restore_online_booking", "restored": restored}))
            except (ProbeError, URLError, TimeoutError, ValueError):
                cleanup_failed = True
        if cleanup_failed:
            print("Cleanup uncertain: inspect this demo account before another write probe.", file=sys.stderr)
    return 2 if cleanup_failed else 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
