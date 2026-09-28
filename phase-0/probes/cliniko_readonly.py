#!/usr/bin/env python3
"""Read-only Cliniko account probe; prints metadata, never response records."""

import base64
import getpass
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


ENDPOINTS = (
    ("businesses", "/businesses?per_page=1"),
    ("appointment_types", "/appointment_types?per_page=10"),
    ("practitioners", "/practitioners?per_page=1"),
    ("individual_appointments", "/individual_appointments?per_page=1"),
)


def main() -> int:
    if not sys.stdin.isatty():
        print("Run in a terminal so the API key can be entered without echo.", file=sys.stderr)
        return 2

    contact = input("Cliniko API contact email: ").strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", contact):
        print("A valid contact email is required for the User-Agent.", file=sys.stderr)
        return 2

    key = getpass.getpass("Cliniko API key (hidden): ").strip()
    shard = key.rpartition("-")[2]
    if not re.fullmatch(r"[a-z]{2}[0-9]+", shard):
        print("API key must have a valid Cliniko shard suffix.", file=sys.stderr)
        return 2

    auth = base64.b64encode(f"{key}:".encode()).decode()
    base_url = f"https://api.{shard}.cliniko.com/v1"
    headers = {
        "Accept": "application/json",
        "Authorization": f"Basic {auth}",
        "User-Agent": f"Abby Phase 0 ({contact})",
    }
    print(json.dumps({"probe": "cliniko_readonly_v1", "shard": shard}))

    failed = False
    identifiers = {}
    for name, path in ENDPOINTS:
        request = Request(base_url + path, headers=headers, method="GET")
        try:
            with urlopen(request, timeout=15) as response:
                data = json.load(response)
                count = data.get("total_entries")
                if not isinstance(count, int):
                    count = None
                rows = data.get(name)
                result = {"endpoint": name, "http_status": response.status, "total_entries": count}
                if isinstance(rows, list):
                    identifiers[name] = [str(row["id"]) for row in rows if isinstance(row, dict) and "id" in row]
                    if name in ("businesses", "appointment_types", "practitioners"):
                        flags = [row.get("show_in_online_bookings") for row in rows if isinstance(row, dict)]
                        result["online_enabled_true"] = sum(flag is True for flag in flags)
                        result["online_enabled_false"] = sum(flag is False for flag in flags)
                        result["online_enabled_unknown"] = sum(flag is None for flag in flags)
                print(json.dumps(result))
        except HTTPError as error:
            failed = True
            result = {"endpoint": name, "http_status": error.code}
            if error.code == 429:
                result["rate_limit_reset"] = error.headers.get("X-RateLimit-Reset")
            print(json.dumps(result))
        except (URLError, TimeoutError, ValueError) as error:
            failed = True
            print(json.dumps({"endpoint": name, "error_type": type(error).__name__}))

    if all(identifiers.get(name) for name in ("businesses", "practitioners", "appointment_types")):
        target_date = (datetime.now(timezone.utc).date() + timedelta(days=2)).isoformat()
        business_id = quote(identifiers["businesses"][0], safe="")
        practitioner_id = quote(identifiers["practitioners"][0], safe="")
        for index, appointment_type_id in enumerate(identifiers["appointment_types"], start=1):
            type_id = quote(appointment_type_id, safe="")
            path = (
                f"/businesses/{business_id}/practitioners/{practitioner_id}"
                f"/appointment_types/{type_id}/available_times?"
                + urlencode({"from": target_date, "to": target_date, "per_page": 1})
            )
            request = Request(base_url + path, headers=headers, method="GET")
            try:
                with urlopen(request, timeout=15) as response:
                    data = json.load(response)
                    count = data.get("total_entries")
                    if not isinstance(count, int):
                        count = None
                    print(json.dumps({"endpoint": "available_times", "type_index": index, "http_status": response.status, "total_entries": count}))
            except HTTPError as error:
                failed = True
                print(json.dumps({"endpoint": "available_times", "type_index": index, "http_status": error.code}))
            except (URLError, TimeoutError, ValueError) as error:
                failed = True
                print(json.dumps({"endpoint": "available_times", "type_index": index, "error_type": type(error).__name__}))

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
