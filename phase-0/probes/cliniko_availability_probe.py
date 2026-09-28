#!/usr/bin/env python3
"""Temporarily enable demo online booking, probe offers, and restore the flag."""

import base64
import getpass
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


class ProbeError(Exception):
    pass


def request(base: str, headers: dict[str, str], method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = Request(base + path, headers=headers, data=data, method=method)
    try:
        with urlopen(req, timeout=15) as response:
            raw = response.read(1_000_001)
            if len(raw) > 1_000_000:
                raise ProbeError("oversized_response")
            return response.status, json.loads(raw) if raw else {}
    except HTTPError as error:
        return error.code, {}


def rows(base: str, headers: dict[str, str], name: str) -> list[dict]:
    status, data = request(base, headers, "GET", f"/{name}?per_page=100")
    if status != 200 or not isinstance(data.get(name), list):
        raise ProbeError(f"{name}_read_{status}")
    return data[name]


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
    try:
        businesses = rows(base, headers, "businesses")
        practitioners = rows(base, headers, "practitioners")
        appointment_types = rows(base, headers, "appointment_types")
        if len(businesses) != 1 or len(practitioners) != 1 or not appointment_types:
            raise ProbeError("expected_one_demo_business_and_practitioner")
        business = businesses[0]
        original = business.get("show_in_online_bookings")
        if original not in (True, False):
            raise ProbeError("business_flag_not_boolean")
        business_id = quote(str(business["id"]), safe="")
        practitioner_id = quote(str(practitioners[0]["id"]), safe="")
        business_path = f"/businesses/{business_id}"
        print(json.dumps({"probe": "cliniko_availability_v1", "shard": shard, "business_flag_before": original}))
        attempted_change = False
        failed = False
        try:
            if not original:
                attempted_change = True
                status, updated = request(base, headers, "PATCH", business_path, {"show_in_online_bookings": True})
                if status != 200 or updated.get("show_in_online_bookings") is not True:
                    raise ProbeError(f"enable_online_booking_{status}")
                print(json.dumps({"step": "enable_online_booking", "http_status": status}))
            target_date = (datetime.now(timezone.utc).date() + timedelta(days=2)).isoformat()
            for index, appointment_type in enumerate(appointment_types, start=1):
                type_id = quote(str(appointment_type["id"]), safe="")
                path = (
                    f"/businesses/{business_id}/practitioners/{practitioner_id}"
                    f"/appointment_types/{type_id}/available_times?"
                    + urlencode({"from": target_date, "to": target_date, "per_page": 10})
                )
                status, data = request(base, headers, "GET", path)
                offers = data.get("available_times") if status == 200 else None
                print(json.dumps({
                    "step": "available_times", "type_index": index, "http_status": status,
                    "offer_count_in_page": len(offers) if isinstance(offers, list) else None,
                }))
                failed |= status != 200
        finally:
            if attempted_change:
                try:
                    status, restored = request(base, headers, "PATCH", business_path, {"show_in_online_bookings": original})
                    verify_status, verified = request(base, headers, "GET", business_path)
                    restored_ok = status == 200 and verify_status == 200 and restored.get("show_in_online_bookings") is original and verified.get("show_in_online_bookings") is original
                    print(json.dumps({"step": "restore_online_booking", "patch_status": status, "verify_status": verify_status, "restored": restored_ok}))
                    if not restored_ok:
                        raise ProbeError("restore_failed_check_demo_business_immediately")
                except (URLError, TimeoutError, ValueError):
                    raise ProbeError("restore_failed_check_demo_business_immediately") from None
        return 1 if failed else 0
    except (ProbeError, URLError, TimeoutError, ValueError, KeyError) as error:
        label = str(error) if isinstance(error, ProbeError) else type(error).__name__
        print(json.dumps({"error": label}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
