#!/usr/bin/env python3
"""Inspect demo-account Cliniko work resources without printing patient records."""

import base64
import getpass
import json
import re
import sys

from cliniko_availability_probe import ProbeError, request


RESOURCES = ("recall_types", "recalls", "communications")


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
        "User-Agent": f"Abby Phase 0 ({contact})",
    }
    print(json.dumps({"probe": "cliniko_staff_work_readonly_v1", "shard": shard}))
    failed = False
    for resource in RESOURCES:
        try:
            status, body = request(base, headers, "GET", f"/{resource}?per_page=1")
            rows = body.get(resource)
            count = body.get("total_entries")
            valid = status == 200 and isinstance(count, int) and count >= 0 and isinstance(rows, list)
            print(json.dumps({"resource": resource, "http_status": status,
                              "total_entries": count if valid else None, "shape_valid": valid}))
            failed |= not valid
        except (ProbeError, OSError, TimeoutError, ValueError) as error:
            print(json.dumps({"resource": resource, "error_type": type(error).__name__}))
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
