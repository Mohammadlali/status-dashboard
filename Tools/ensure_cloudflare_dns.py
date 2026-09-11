#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Ensure Cloudflare DNS record exists for the status feed subdomain.

READS existing DNS records first. If the record already exists, it is left untouched.
If missing, creates only the specified subdomain record.
NEVER modifies or deletes any existing DNS record.

Requires:
    CF_API_TOKEN: Cloudflare API token with Zone.DNS permissions.
    CF_ACCOUNT_ID: Optional Cloudflare Account ID.

Usage:
    python3 Tools/ensure_cloudflare_dns.py [--zone airboxvip.top] [--subdomain status.airboxvip.top] [--target cname.vercel-dns.com]
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

MARKER = "##TBS##"


def cf_request(endpoint, method="GET", data=None, token=None):
    """Execute Cloudflare API request."""
    url = f"https://api.cloudflare.com/client/v4{endpoint}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": "Claud-Cloud-StatusFeed/1.0"
    }

    req_data = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=req_data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body), None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return None, f"HTTP {exc.code}: {exc.reason} ({body})"
    except Exception as exc:
        return None, str(exc)


def get_zone_id(zone_name, token):
    """Retrieve Zone ID for given domain name."""
    res, err = cf_request(f"/zones?name={zone_name}", token=token)
    if err:
        return None, f"Failed to query zones: {err}"
    if not res or not res.get("success"):
        return None, f"Cloudflare API returned error: {res}"
    results = res.get("result", [])
    if not results:
        return None, f"Zone '{zone_name}' not found on account."
    return results[0]["id"], None


def ensure_dns_record(zone_name, subdomain, target, token):
    """Read existing records, add subdomain CNAME only if missing."""
    zone_id, err = get_zone_id(zone_name, token)
    if err:
        return False, err

    # Normalize subdomain name
    fqdn = subdomain.strip().lower()
    if not fqdn.endswith(f".{zone_name}") and fqdn != zone_name:
        fqdn = f"{fqdn}.{zone_name}"

    # READ-FIRST: check existing records
    rec_res, err = cf_request(f"/zones/{zone_id}/dns_records?name={fqdn}", token=token)
    if err:
        return False, f"Failed to read existing DNS records: {err}"

    existing_records = rec_res.get("result", [])
    if existing_records:
        rec = existing_records[0]
        rec_type = rec.get("type")
        rec_content = rec.get("content")
        print(f"READ-FIRST: Record for '{fqdn}' already exists.")
        print(f"  Type: {rec_type}, Content: {rec_content}, ID: {rec.get('id')}")
        print("  Leaving existing record untouched per strict non-destructive rule.")
        return True, "Record already exists (untouched)."

    # Record does not exist: create it
    print(f"Record for '{fqdn}' not found. Adding CNAME record -> {target}...")
    record_prefix = fqdn.replace(f".{zone_name}", "")

    payload = {
        "type": "CNAME",
        "name": record_prefix,
        "content": target,
        "ttl": 1,  # Auto TTL
        "proxied": False  # DNS-only for Vercel SSL validation
    }

    create_res, err = cf_request(f"/zones/{zone_id}/dns_records", method="POST", data=payload, token=token)
    if err:
        return False, f"Failed to create DNS record: {err}"

    if not create_res.get("success"):
        return False, f"Cloudflare rejected DNS creation: {create_res.get('errors')}"

    new_id = create_res.get("result", {}).get("id")
    print(f"SUCCESS: Created DNS record '{fqdn}' -> '{target}' (ID: {new_id}, proxied: false).")
    return True, f"Created CNAME record (ID: {new_id})"


def main():
    parser = argparse.ArgumentParser(description="Ensure Cloudflare DNS for status feed")
    parser.add_argument("--zone", default="airboxvip.top", help="Root zone name")
    parser.add_argument("--subdomain", default="status.airboxvip.top", help="Subdomain to ensure")
    parser.add_argument("--target", default="cname.vercel-dns.com", help="Target CNAME content")
    parser.add_argument("--dry-run", action="store_true", help="Dry run without token")
    args = parser.parse_args()

    token = os.environ.get("CF_API_TOKEN", "").strip()
    if not token:
        print("RESULT: CF_API_TOKEN is not present in environment.")
        if args.dry_run:
            print("DRY-RUN: Skipping live DNS verification.")
            return 0
        print("This is expected in agent sandboxed runs. In Actions workflow, CF_API_TOKEN will be supplied.")
        return 0

    ok, msg = ensure_dns_record(args.zone, args.subdomain, args.target, token)
    status = "pass" if ok else "fail"
    print(MARKER + json.dumps({
        "v": 1,
        "probe": "cloudflare_dns_ensure",
        "status": status,
        "data": {
            "zone": args.zone,
            "subdomain": args.subdomain,
            "target": args.target,
            "message": msg
        }
    }, sort_keys=True))

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
