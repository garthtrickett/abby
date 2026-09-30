#!/usr/bin/env python3
"""Exercise one synthetic appointment in the demo account, then archive all fixtures."""

import base64
import getpass
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from urllib.error import URLError
from urllib.parse import quote, urlencode
from pathlib import Path

from cliniko_availability_probe import ProbeError, request, rows


def exact_appointment(base: str, headers: dict[str, str], patient_id: str, marker: str) -> tuple[str | None, int]:
    query = urlencode({"per_page": 100, "q[]": f"patient_id:={patient_id}"})
    status, data = request(base, headers, "GET", f"/individual_appointments?{query}")
    if status != 200 or not isinstance(data.get("individual_appointments"), list):
        raise ProbeError(f"reconcile_read_{status}")
    matches = [row for row in data["individual_appointments"] if row.get("notes") == marker]
    return (str(matches[0]["id"]) if len(matches) == 1 else None), len(matches)


def exact_patient(base: str, headers: dict[str, str], reference_id: str) -> tuple[str | None, int]:
    query = urlencode({"per_page": 100, "q[]": f"old_reference_id:={reference_id}"})
    status, data = request(base, headers, "GET", f"/patients?{query}")
    if status != 200 or not isinstance(data.get("patients"), list):
        raise ProbeError(f"patient_reconcile_read_{status}")
    matches = [row for row in data["patients"] if row.get("old_reference_id") == reference_id]
    return (str(matches[0]["id"]) if len(matches) == 1 else None), len(matches)


def main() -> int:
    env_mode = os.environ.get("ABBY_LIVE_CLINIKO_EVAL") == "1"
    if not env_mode and not sys.stdin.isatty():
        print("Run in a terminal so the API key is hidden, or use the opt-in owner-only environment.", file=sys.stderr)
        return 2
    contact = (os.environ.get("ABBY_CLINIKO_CONTACT_EMAIL", "") if env_mode
               else input("Cliniko API contact email: ")).strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", contact):
        print("Invalid contact email.", file=sys.stderr)
        return 2
    key = (os.environ.get("ABBY_CLINIKO_API_KEY", "") if env_mode
           else getpass.getpass("Cliniko API key (hidden): ")).strip()
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
    marker_token = str(uuid.uuid4())
    marker = "Abby booking " + marker_token
    business_path = None
    original_flag = None
    changed_business = False
    patient_id = None
    appointment_id = None
    cancelled_ok = False
    failed = False
    cleanup_failed = False
    try:
        businesses = rows(base, headers, "businesses")
        practitioners = rows(base, headers, "practitioners")
        types = rows(base, headers, "appointment_types")
        if len(businesses) != 1 or len(practitioners) != 1 or not types:
            raise ProbeError("expected_one_demo_business_and_practitioner")
        business = businesses[0]
        detail_status, business_detail = request(base, headers, "GET", f"/businesses/{quote(str(business['id']), safe='')}")
        if detail_status != 200 or str(business_detail.get("id")) != str(business["id"]):
            raise ProbeError(f"business_detail_{detail_status}")
        time_zone_identifier = business_detail.get("time_zone_identifier")
        if not isinstance(time_zone_identifier, str) or not time_zone_identifier:
            raise ProbeError("business_timezone_missing")
        original_flag = business.get("show_in_online_bookings")
        if original_flag not in (True, False):
            raise ProbeError("business_flag_not_boolean")
        business_id = str(business["id"])
        practitioner_id = str(practitioners[0]["id"])
        business_path = f"/businesses/{quote(business_id, safe='')}"
        print(json.dumps({"probe": "cliniko_write_v1", "shard": shard, "business_flag_before": original_flag}))
        if not original_flag:
            changed_business = True
            status, data = request(base, headers, "PATCH", business_path, {"show_in_online_bookings": True})
            if status != 200 or data.get("show_in_online_bookings") is not True:
                raise ProbeError(f"enable_online_booking_{status}")
            print(json.dumps({"step": "enable_online_booking", "http_status": status}))

        target_date = (datetime.now(timezone.utc).date() + timedelta(days=2)).isoformat()
        offer_type = None
        offers = []
        for item in types:
            type_id = str(item["id"])
            path = (f"/businesses/{quote(business_id, safe='')}/practitioners/{quote(practitioner_id, safe='')}"
                    f"/appointment_types/{quote(type_id, safe='')}/available_times?"
                    + urlencode({"from": target_date, "to": target_date, "per_page": 10}))
            status, data = request(base, headers, "GET", path)
            if status == 200 and isinstance(data.get("available_times"), list) and data["available_times"]:
                offer_type = type_id
                offers = data["available_times"]
                break
        if offer_type is None:
            raise ProbeError("no_bookable_offer")
        starts_at = offers[0].get("appointment_start")
        if not isinstance(starts_at, str):
            raise ProbeError("invalid_offer_shape")
        print(json.dumps({"step": "offer", "http_status": 200, "offer_count_in_page": len(offers)}))

        patient_body = {"first_name": "Abby", "last_name": "SyntheticProbe" + reference_id, "old_reference_id": reference_id}
        status, patient = request(base, headers, "POST", "/patients", patient_body)
        if status != 201 or not patient.get("id"):
            raise ProbeError(f"create_patient_{status}")
        patient_id = str(patient["id"])
        print(json.dumps({"step": "create_synthetic_patient", "http_status": status}))

        writer_input = {
            "apiKey": key, "contactEmail": contact, "businessId": business_id,
            "practitionerId": practitioner_id, "appointmentTypeId": offer_type,
            "patientId": patient_id, "startsAt": starts_at, "markerToken": marker_token,
        }
        repo_root = Path(__file__).resolve().parents[2]
        try:
            writer = subprocess.run(
                ["node", str(Path(__file__).with_name("cliniko_booking_writer_probe.ts"))],
                input=json.dumps(writer_input), text=True, capture_output=True,
                cwd=repo_root, timeout=60, check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            raise ProbeError("booking_writer_unavailable") from None
        try:
            writer_result = json.loads(writer.stdout)
        except ValueError:
            raise ProbeError("booking_writer_output_invalid") from None
        injected_loss = env_mode and os.environ.get("ABBY_PROBE_LOSE_POST_RESPONSE") == "1"
        print(json.dumps({"step": "typescript_booking_writer", "write_kind": writer_result.get("writeKind"),
                          "observation_kind": writer_result.get("observationKind"),
                          "exact_synthetic_appointment": writer_result.get("exact") is True,
                          "injected_post_response_loss": writer_result.get("injectedPostResponseLoss") is True}))
        if (writer.returncode != 0 or writer_result.get("ok") is not True or
                writer_result.get("injectedPostResponseLoss") is not injected_loss):
            raise ProbeError("booking_writer_read_mismatch")

        reconciled_id, count = exact_appointment(base, headers, patient_id, marker)
        appointment_id = reconciled_id
        print(json.dumps({"step": "reconcile_without_post_response", "exact_matches": count,
                          "same_appointment": reconciled_id is not None}))
        if reconciled_id is None or count != 1:
            raise ProbeError("exact_reconciliation_unproven")

        adapter_input = {
            "apiKey": key, "contactEmail": contact, "businessId": business_id,
            "patientId": patient_id, "appointmentId": appointment_id,
        }
        try:
            adapter = subprocess.run(
                ["node", str(Path(__file__).with_name("cliniko_appointment_adapter_probe.ts"))],
                input=json.dumps(adapter_input), text=True, capture_output=True,
                cwd=repo_root, timeout=60, check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            raise ProbeError("appointment_adapter_unavailable") from None
        try:
            adapter_result = json.loads(adapter.stdout)
        except ValueError:
            raise ProbeError("appointment_adapter_output_invalid") from None
        if (adapter.returncode != 0 or adapter_result.get("ok") is not True or
                adapter_result.get("exact") is not True or adapter_result.get("count") != 1 or
                adapter_result.get("timeZone") != time_zone_identifier or
                adapter_result.get("unverifiedNoRead") is not True or
                adapter_result.get("disposedNoRead") is not True or
                adapter_result.get("protectedReads") != 1):
            raise ProbeError("appointment_adapter_read_mismatch")
        print(json.dumps({"step": "typescript_appointment_adapter", "count": 1,
                          "exact_synthetic_appointment": True, "timezone_match": True,
                          "unverified_no_protected_read": True, "disposed_no_protected_read": True,
                          "protected_reads": 1}))

        if len(offers) > 1 and isinstance(offers[1].get("appointment_start"), str):
            second_start = offers[1]["appointment_start"]
            status, moved = request(base, headers, "PATCH", f"/individual_appointments/{quote(appointment_id, safe='')}", {"starts_at": second_start, "ends_at": None})
            read_status, current = request(base, headers, "GET", f"/individual_appointments/{quote(appointment_id, safe='')}")
            moved_ok = status == 200 and read_status == 200 and moved.get("starts_at") == second_start and current.get("starts_at") == second_start
            print(json.dumps({"step": "reschedule", "patch_status": status, "read_status": read_status, "verified": moved_ok}))
            if not moved_ok:
                failed = True

        appointment_path = f"/individual_appointments/{quote(appointment_id, safe='')}"
        target_status, target = request(base, headers, "GET", appointment_path)
        if target_status != 200 or str(target.get("id")) != appointment_id or\
                not isinstance(target.get("starts_at"), str) or not isinstance(target.get("ends_at"), str):
            raise ProbeError("cancellation_target_unavailable")
        cancel_input = {
            "apiKey": key, "contactEmail": contact, "businessId": business_id,
            "practitionerId": practitioner_id, "appointmentTypeId": offer_type,
            "patientId": patient_id, "appointmentId": appointment_id,
            "startsAt": target["starts_at"], "endsAt": target["ends_at"],
        }
        try:
            cancellation = subprocess.run(
                ["node", str(Path(__file__).with_name("cliniko_cancellation_writer_probe.ts"))],
                input=json.dumps(cancel_input), text=True, capture_output=True,
                cwd=repo_root, timeout=60, check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            raise ProbeError("cancellation_writer_unavailable") from None
        try:
            cancellation_result = json.loads(cancellation.stdout)
        except ValueError:
            raise ProbeError("cancellation_writer_output_invalid") from None
        cancelled_path = f"/individual_appointments/{quote(appointment_id, safe='')}?" + urlencode({"q[]": "cancelled_at:*"})
        read_status, cancelled = request(base, headers, "GET", cancelled_path)
        cancelled_ok = read_status == 200 and bool(cancelled.get("cancelled_at"))
        print(json.dumps({"step": "typescript_cancellation_writer",
                          "write_kind": cancellation_result.get("writeKind"),
                          "observation_kind": cancellation_result.get("observationKind"),
                          "repeated_attempt_rejected": cancellation_result.get("repeatedAttemptRejected") is True,
                          "independent_cancelled_read": cancelled_ok}))
        if cancellation.returncode != 0 or cancellation_result.get("ok") is not True or not cancelled_ok:
            failed = True
    except (ProbeError, URLError, TimeoutError, ValueError, KeyError) as error:
        failed = True
        label = str(error) if isinstance(error, ProbeError) else type(error).__name__
        print(json.dumps({"error": label}), file=sys.stderr)
    finally:
        if not patient_id:
            try:
                patient_id, count = exact_patient(base, headers, reference_id)
                if count > 1:
                    cleanup_failed = True
                    print(json.dumps({"step": "locate_patient_for_cleanup", "exact_matches": count}))
            except (ProbeError, URLError, TimeoutError, ValueError, KeyError):
                cleanup_failed = True
                print(json.dumps({"step": "locate_patient_for_cleanup", "verified": False}))
        if patient_id and not appointment_id:
            try:
                appointment_id, count = exact_appointment(base, headers, patient_id, marker)
                if count > 1:
                    cleanup_failed = True
                    print(json.dumps({"step": "locate_appointment_for_cleanup", "exact_matches": count}))
            except (ProbeError, URLError, TimeoutError, ValueError, KeyError):
                cleanup_failed = True
                print(json.dumps({"step": "locate_appointment_for_cleanup", "verified": False}))
        if appointment_id and not cancelled_ok:
            try:
                status, _ = request(base, headers, "POST", f"/individual_appointments/{quote(appointment_id, safe='')}/archive")
                print(json.dumps({"step": "archive_appointment", "http_status": status}))
                cleanup_failed |= status != 204
            except (URLError, TimeoutError, ValueError):
                cleanup_failed = True
                print(json.dumps({"step": "archive_appointment", "verified": False}))
        if patient_id:
            try:
                status, _ = request(base, headers, "POST", f"/patients/{quote(patient_id, safe='')}/archive")
                print(json.dumps({"step": "archive_patient", "http_status": status}))
                cleanup_failed |= status != 204
            except (URLError, TimeoutError, ValueError):
                cleanup_failed = True
                print(json.dumps({"step": "archive_patient", "verified": False}))
        if changed_business and business_path is not None:
            try:
                status, _ = request(base, headers, "PATCH", business_path, {"show_in_online_bookings": original_flag})
                verify_status, business = request(base, headers, "GET", business_path)
                restored = status == 200 and verify_status == 200 and business.get("show_in_online_bookings") is original_flag
                print(json.dumps({"step": "restore_online_booking", "patch_status": status, "verify_status": verify_status, "restored": restored}))
                cleanup_failed |= not restored
            except (URLError, TimeoutError, ValueError):
                cleanup_failed = True
                print(json.dumps({"step": "restore_online_booking", "restored": False}))
        if cleanup_failed:
            print("Cleanup uncertain: inspect this demo account before another write probe.", file=sys.stderr)
    return 2 if cleanup_failed else 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
