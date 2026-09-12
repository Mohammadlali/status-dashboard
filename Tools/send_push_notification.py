#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# send_push_notification -- deliver encrypted Web Push notifications to subscribed PWA devices
"""Web Push Notification dispatcher for Claud-Cloud-Project operations.

Delivers RFC 8291 / RFC 8292 encrypted push notifications to subscribed
devices (Android PWA home screen) when red/stuck operational items appear.

Subscriptions are read from the fleet's status Gist (file:
subscription.json) -- moved off Cloudflare R2 2026-09-12: R2 is
permanently unavailable on the owner's Cloudflare account (not fully
provisioned, so Cloudflare blocks all TLS to the R2 endpoint
account-wide). See Tools/collect_status_feed.py's
publish_to_gist_if_configured() for the write side and the same
STATUS_GIST_ID.
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

STATUS_GIST_ID = "8a1dbd864c788597da9c7750c70bd419"
STATUS_GIST_OWNER = "Mohammadlali"

MARKER = "##TBS##"
# Public half of the current VAPID pair -- not secret, safe to source-control.
# Rotated 2026-09-10: the previous pair's PRIVATE half was found hardcoded
# below as a fallback default and treated as compromised (see
# Team/CHANGELOG.md the same day). There is deliberately no
# DEFAULT_VAPID_PRIVATE constant any more -- see get_vapid_instance().
DEFAULT_VAPID_PUBLIC = "BG_JbNQKSkg6lQHIYAuJdrfXVMr4lttYSmouPlhSJ2tMQkKnFtJdDKaIFrd02oAn16BbE7sHOyzFkNijd-gELvA"


def emit_digest(probe, status, data):
    payload = {"v": 1, "probe": probe, "status": status, "data": data}
    print(MARKER + json.dumps(payload, sort_keys=True))


def get_vapid_instance(private_key_str=None):
    """Derive a py_vapid.Vapid instance from base64url scalar, PEM, or file.

    No hardcoded fallback private key exists, on purpose -- one did, was
    found committed to this repo 2026-09-10, and had to be treated as
    compromised and rotated. A missing key is a configuration error, not
    a value to guess at.
    """
    raw_key = private_key_str or os.environ.get("VAPID_PRIVATE_KEY")
    if not raw_key:
        return None, "VAPID_PRIVATE_KEY not set -- no default private key exists, and none should"
    raw_key = raw_key.strip()

    try:
        from py_vapid import Vapid
    except ImportError:
        return None, "py-vapid / pywebpush not installed. Run: pip install pywebpush"

    try:
        # Check if it is a file path
        if os.path.isfile(raw_key):
            return Vapid.from_file(raw_key), None

        # Check if it is PEM
        if "BEGIN" in raw_key:
            return Vapid.from_string(raw_key), None

        # Base64url raw 32-byte scalar. Vapid.from_raw() base64url-decodes
        # its argument ITSELF -- decoding here first and handing it the
        # already-decoded bytes double-decodes and silently derives the
        # WRONG key (found 2026-09-10 while rotating the compromised key
        # above: the derived public key did not match the one actually
        # generated). Decode once here only to validate length; pass the
        # padded base64 STRING through, not the decoded bytes.
        pad = "=" * ((4 - len(raw_key) % 4) % 4)
        padded = raw_key + pad
        priv_bytes = base64.urlsafe_b64decode(padded)
        if len(priv_bytes) == 32:
            return Vapid.from_raw(padded.encode("ascii")), None

        return None, f"Unrecognized private key format (len {len(priv_bytes)})"
    except Exception as exc:
        return None, f"Failed to initialize VAPID key: {str(exc)}"


def load_subscription_from_gist(env=None):
    """Fetch stored push subscription JSON from the fleet's status Gist.

    No token needed: a Gist's raw file URL is fetchable by anyone who has
    it, secret or not (only the listing is hidden, not the content).
    """
    del env  # kept for call-site compatibility; unused now
    url = f"https://gist.githubusercontent.com/{STATUS_GIST_OWNER}/{STATUS_GIST_ID}/raw/subscription.json"
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not data or data.get("placeholder"):
            return None, "No subscription saved yet in the status gist"
        return data, None
    except urllib.error.HTTPError as exc:
        return None, f"Gist fetch HTTP {exc.code}: {exc.reason}"
    except urllib.error.URLError as exc:
        return None, f"Gist fetch network error: {exc.reason}"
    except Exception as exc:
        return None, f"Gist fetch error: {str(exc)}"


def send_push(subscription_info, title, body, target_url=None, tag=None, private_key=None, subject="mailto:admin@airboxvip.top", dry_run=False):
    """Send an encrypted Web Push notification via pywebpush."""
    if not subscription_info or not isinstance(subscription_info, dict):
        return False, "Invalid subscription information"

    endpoint = subscription_info.get("endpoint")
    if not endpoint:
        return False, "Subscription missing endpoint URL"

    keys = subscription_info.get("keys", {})
    if not (keys.get("p256dh") and keys.get("auth")):
        return False, "Subscription missing p256dh or auth keys"

    vapid_obj, err = get_vapid_instance(private_key)
    if err:
        return False, f"VAPID error: {err}"

    payload = {
        "title": title,
        "body": body,
        "icon": "icons/icon-192.png",
        "badge": "icons/icon-192.png",
        "tag": tag or "claud-cloud-alert",
        "data": {
            "url": target_url or "/#stuck-section"
        }
    }
    payload_str = json.dumps(payload)

    claims = {"sub": subject}

    if dry_run:
        try:
            import pywebpush
            curl_cmd = pywebpush.webpush(
                subscription_info=subscription_info,
                data=payload_str,
                vapid_private_key=vapid_obj,
                vapid_claims=claims,
                curl=True
            )
            return True, f"Dry-run success. Curl length: {len(curl_cmd)}"
        except Exception as exc:
            return False, f"Dry-run encryption error: {str(exc)}"

    try:
        import pywebpush
        response = pywebpush.webpush(
            subscription_info=subscription_info,
            data=payload_str,
            vapid_private_key=vapid_obj,
            vapid_claims=claims,
            ttl=86400
        )
        status_code = getattr(response, "status_code", 200)
        if status_code in (200, 201, 202):
            return True, f"Push delivered successfully (HTTP {status_code})"
        elif status_code == 410:
            return False, "Subscription expired (HTTP 410 Gone)"
        else:
            return False, f"Push gateway returned HTTP {status_code}: {response.text[:120]}"
    except pywebpush.WebPushException as exc:
        resp = getattr(exc, "response", None)
        status = getattr(resp, "status_code", None)
        if status == 410:
            return False, "Subscription expired (HTTP 410 Gone)"
        return False, f"WebPushException (HTTP {status}): {str(exc)}"
    except Exception as exc:
        return False, f"Delivery network error: {str(exc)}"


def main():
    parser = argparse.ArgumentParser(description="Send Web Push notification to subscribed PWA")
    parser.add_argument("--title", default="[ALERT] Claud-Cloud Operations", help="Notification title")
    parser.add_argument("--body", default="A red or stuck item requires intervention.", help="Notification body")
    parser.add_argument("--url", default="https://status.airboxvip.top#stuck-section", help="Click target URL")
    parser.add_argument("--subscription-file", default=None, help="Path to local subscription JSON")
    parser.add_argument("--dry-run", action="store_true", help="Generate curl without sending")
    args = parser.parse_args()

    sub = None
    if args.subscription_file and os.path.isfile(args.subscription_file):
        with open(args.subscription_file, "r", encoding="utf-8") as fh:
            sub = json.load(fh)
    else:
        sub, err = load_subscription_from_gist()
        if err:
            print(f"Notice: Could not load subscription from the status gist: {err}")
            emit_digest("web_push_dispatch", "skipped", {"reason": err})
            return 0

    ok, msg = send_push(sub, args.title, args.body, target_url=args.url, dry_run=args.dry_run)
    print(f"Push result: {msg}")

    emit_digest("web_push_dispatch", "pass" if ok else "fail", {
        "message": msg,
        "endpoint": sub.get("endpoint", "")[:40] + "..." if sub else "none"
    })

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
