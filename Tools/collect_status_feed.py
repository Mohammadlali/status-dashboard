#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cross-account status feed collector for Claud-Cloud-Project operations.

Pulls status across all 9 accounts using ACC0_PAT..ACC8_PAT:
- Recent commits across primary and agw-worker repositories.
- Open, blocked, and stale issues.
- Latest @agy task outcomes (success/failure, conclusion from workflow runs).
- Gate health from Reports/gates/*.txt (and Control-Room if reachable).
- Anything red or stuck (failed runs, blocked tasks, stale issues, push losses).
- Enforces the project doctrine: quiet green when nominal, prominent red alerts when stuck.
- Optionally archives snapshots to Cloudflare R2 if R2_* credentials are provided.

Usage:
    python3 Tools/collect_status_feed.py [--out StatusFeed/status.json] [--subdomain status.airboxvip.top]
"""

import argparse
import datetime
import glob
import json
import os
import re
import sys
import urllib.error
import urllib.request

MARKER = "##TBS##"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
TOOLS_DIR = os.path.join(ROOT, "Tools")
if TOOLS_DIR not in sys.path:
    sys.path.insert(0, TOOLS_DIR)

try:
    from send_push_notification import (
        generate_r2_presigned_upload_url,
        load_subscription_from_r2,
        send_push,
        DEFAULT_VAPID_PUBLIC
    )
except ImportError:
    try:
        from Tools.send_push_notification import (
            generate_r2_presigned_upload_url,
            load_subscription_from_r2,
            send_push,
            DEFAULT_VAPID_PUBLIC
        )
    except ImportError:
        generate_r2_presigned_upload_url = None
        load_subscription_from_r2 = None
        send_push = None
        DEFAULT_VAPID_PUBLIC = "BG_JbNQKSkg6lQHIYAuJdrfXVMr4lttYSmouPlhSJ2tMQkKnFtJdDKaIFrd02oAn16BbE7sHOyzFkNijd-gELvA"

# 9 accounts and their repositories (matching Team/ACCOUNTS.md and Tools/dispatch_backlog.py)
ACCOUNTS = [
    {
        "index": 0,
        "owner": "Mohammadlali",
        "pat_env": "ACC0_PAT",
        "primary_repo": "Mohammadlali/Claud-Cloud-Project",
        "worker_repo": "Mohammadlali/agw-workers",
        "role": "Trunk / Platform & Gateway"
    },
    {
        "index": 1,
        "owner": "momonakikugava-pixel",
        "pat_env": "ACC1_PAT",
        "primary_repo": "momonakikugava-pixel/AirboxVIP_Coffeenet",
        "worker_repo": "momonakikugava-pixel/agw-workers",
        "role": "AirboxVIP Coffeenet / Voucher Bot"
    },
    {
        "index": 2,
        "owner": "lali94m-max",
        "pat_env": "ACC2_PAT",
        "primary_repo": None,
        "worker_repo": "lali94m-max/agw-workers",
        "role": "Fleet Worker"
    },
    {
        "index": 3,
        "owner": "ngocgminh5-debug",
        "pat_env": "ACC3_PAT",
        "primary_repo": None,
        "worker_repo": "ngocgminh5-debug/agw-workers",
        "role": "Fleet Worker (Debug / Pro)"
    },
    {
        "index": 4,
        "owner": "hmmletssee7-design",
        "pat_env": "ACC4_PAT",
        "primary_repo": None,
        "worker_repo": "hmmletssee7-design/agw-workers",
        "role": "Fleet Worker (Design)"
    },
    {
        "index": 5,
        "owner": "kidding602",
        "pat_env": "ACC5_PAT",
        "primary_repo": None,
        "worker_repo": "kidding602/agw-workers",
        "role": "Fleet Worker"
    },
    {
        "index": 6,
        "owner": "mohammadlali0707-stack",
        "pat_env": "ACC6_PAT",
        "primary_repo": "mohammadlali0707-stack/Control-Room",
        "worker_repo": "mohammadlali0707-stack/agw-workers",
        "role": "Control-Room / Ops Hub"
    },
    {
        "index": 7,
        "owner": "mohammad97okk",
        "pat_env": "ACC7_PAT",
        "primary_repo": None,
        "worker_repo": "mohammad97okk/agw-workers",
        "role": "Fleet Worker"
    },
    {
        "index": 8,
        "owner": "moradzahra85-png",
        "pat_env": "ACC8_PAT",
        "primary_repo": None,
        "worker_repo": "moradzahra85-png/agw-workers",
        "role": "Fleet Worker"
    }
]


def emit_digest(probe, status, data):
    """Emit standardized ##TBS## JSON line."""
    payload = {
        "v": 1,
        "probe": probe,
        "status": status,
        "data": data
    }
    print(MARKER + json.dumps(payload, sort_keys=True))


def fetch_github_api(endpoint, token=None, timeout=10):
    """Fetch JSON from GitHub API with optional Bearer token."""
    url = "https://api.github.com" + endpoint if endpoint.startswith("/") else endpoint
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "Claud-Cloud-StatusFeed/1.0",
        "X-GitHub-Api-Version": "2022-11-28"
    }
    if token:
        headers["Authorization"] = f"Bearer {token.strip()}"

    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read().decode("utf-8")
            return json.loads(data), None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return None, f"HTTP {exc.code}: {exc.reason} ({body[:120]})"
    except urllib.error.URLError as exc:
        return None, f"Network error: {exc.reason}"
    except Exception as exc:
        return None, f"Error: {str(exc)}"


def parse_iso_datetime(dt_str):
    """Parse ISO timestamp to datetime or None."""
    if not dt_str:
        return None
    try:
        clean = dt_str.replace("Z", "+00:00")
        return datetime.datetime.fromisoformat(clean)
    except Exception:
        return None


def extract_gate_file_timestamp(path):
    """Extract chronological timestamp (YYYYMMDDTHHMMSSZ) from filename."""
    fn = os.path.basename(path)
    m = re.search(r"(\d{8}T\d{6}Z)", fn)
    if m:
        return m.group(1)
    return fn


def collect_latest_gate_report(reports_dir=None):
    """Parse the newest Reports/gates/gates-*.txt log sorted chronologically."""
    base_dir = reports_dir or os.path.join(ROOT, "Reports", "gates")
    if not os.path.isdir(base_dir):
        return {
            "status": "unmeasured",
            "source": "none",
            "total": 0,
            "pass": 0,
            "fail": 0,
            "unmeasured": 0,
            "failing_gates": [],
            "commit": None,
            "note": "Gates directory not found"
        }

    pattern = os.path.join(base_dir, "gates-*.txt")
    raw_files = glob.glob(pattern)
    if not raw_files:
        return {
            "status": "unmeasured",
            "source": "none",
            "total": 0,
            "pass": 0,
            "fail": 0,
            "unmeasured": 0,
            "failing_gates": [],
            "commit": None,
            "note": "No gates-*.txt reports found"
        }

    # Sort strictly by ISO-like timestamp in filename descending
    files = sorted(raw_files, key=extract_gate_file_timestamp, reverse=True)
    latest_path = files[0]
    filename = os.path.basename(latest_path)

    pass_count = 0
    fail_count = 0
    unmeasured_count = 0
    failing_gates = []
    cited_commit = None
    overall_status = "pass"

    try:
        with open(latest_path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()

        for line in lines:
            if "##TBS##" in line:
                idx = line.find("##TBS##")
                raw = line[idx + len("##TBS##"):].strip()
                try:
                    obj = json.loads(raw)
                    if obj.get("probe") == "gate_suite":
                        data = obj.get("data", {})
                        pass_count = data.get("pass", pass_count)
                        fail_count = data.get("fail", fail_count)
                        unmeasured_count = data.get("unmeasured", unmeasured_count)
                        cited_commit = data.get("commit", cited_commit)
                        not_pass = data.get("not_pass", [])
                        if not_pass:
                            failing_gates.extend(not_pass)
                        overall_status = obj.get("status", overall_status)
                except Exception:
                    pass
            elif line.startswith("[") and "fail" in line:
                failing_gates.append(line.strip())

        total = pass_count + fail_count + unmeasured_count
        if total == 0:
            for line in lines:
                m = re.match(r"^(\d+)\s+gates:\s+(\d+)\s+pass,\s+(\d+)\s+fail,\s+(\d+)\s+unmeasured", line)
                if m:
                    total = int(m.group(1))
                    pass_count = int(m.group(2))
                    fail_count = int(m.group(3))
                    unmeasured_count = int(m.group(4))
                    break

        if fail_count > 0 or unmeasured_count > 0:
            overall_status = "fail"

        return {
            "status": overall_status,
            "source": filename,
            "total": total or 54,
            "pass": pass_count,
            "fail": fail_count,
            "unmeasured": unmeasured_count,
            "failing_gates": list(set(failing_gates)),
            "commit": cited_commit,
            "report_file": filename
        }
    except Exception as exc:
        return {
            "status": "error",
            "source": filename,
            "total": 0,
            "pass": 0,
            "fail": 0,
            "unmeasured": 0,
            "failing_gates": [f"Read error: {str(exc)}"],
            "commit": None,
            "note": str(exc)
        }


def collect_account_data(acc, env_tokens=None, now_utc=None):
    """Collect commits, issues, and workflow runs for one account."""
    tokens = env_tokens or os.environ
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)

    idx = acc["index"]
    owner = acc["owner"]
    pat_env = acc["pat_env"]
    token = tokens.get(pat_env, "").strip()

    repos_to_check = []
    if acc["primary_repo"]:
        repos_to_check.append(acc["primary_repo"])
    if acc["worker_repo"] and acc["worker_repo"] not in repos_to_check:
        repos_to_check.append(acc["worker_repo"])

    acc_result = {
        "index": idx,
        "owner": owner,
        "role": acc["role"],
        "token_env": pat_env,
        "token_available": bool(token),
        "primary_repo": acc["primary_repo"],
        "worker_repo": acc["worker_repo"],
        "repos": repos_to_check,
        "commits": [],
        "open_issues": [],
        "blocked_issues": [],
        "stale_issues": [],
        "agy_tasks": [],
        "failed_runs": [],
        "status": "green",
        "errors": []
    }

    if not token:
        acc_result["status"] = "offline_unconfigured"
        acc_result["note"] = f"Secret {pat_env} is not injected into current environment"
        return acc_result

    for repo in repos_to_check:
        # 1. Recent Commits
        commits_data, err = fetch_github_api(f"/repos/{repo}/commits?per_page=5", token=token)
        if err:
            acc_result["errors"].append(f"{repo} commits: {err}")
        elif isinstance(commits_data, list):
            for c in commits_data:
                sha = c.get("sha", "")[:7]
                commit_obj = c.get("commit", {})
                msg = commit_obj.get("message", "").split("\n")[0]
                author_name = commit_obj.get("author", {}).get("name", owner)
                date_str = commit_obj.get("author", {}).get("date", "")
                acc_result["commits"].append({
                    "repo": repo,
                    "sha": sha,
                    "message": msg[:90],
                    "author": author_name,
                    "date": date_str,
                    "html_url": c.get("html_url", f"https://github.com/{repo}/commit/{sha}")
                })

        # 2. Open Issues
        issues_data, err = fetch_github_api(f"/repos/{repo}/issues?state=open&per_page=15", token=token)
        if err:
            acc_result["errors"].append(f"{repo} issues: {err}")
        elif isinstance(issues_data, list):
            for iss in issues_data:
                if "pull_request" in iss:
                    continue

                num = iss.get("number")
                title = iss.get("title", "")
                body = iss.get("body", "") or ""
                labels = [lb.get("name", "").lower() for lb in iss.get("labels", [])]
                created_at_str = iss.get("created_at", "")
                updated_at_str = iss.get("updated_at", "")
                comments_count = iss.get("comments", 0)
                html_url = iss.get("html_url", f"https://github.com/{repo}/issues/{num}")

                is_blocked = (
                    "blocked" in labels or
                    "[blocked]" in title.lower() or
                    "blocked:" in title.lower() or
                    "blocked by" in body.lower()
                )

                is_stale = False
                updated_dt = parse_iso_datetime(updated_at_str)
                if updated_dt:
                    age_hours = (now - updated_dt).total_seconds() / 3600.0
                    if age_hours > 48.0 and comments_count == 0:
                        is_stale = True

                issue_entry = {
                    "repo": repo,
                    "number": num,
                    "title": title,
                    "url": html_url,
                    "is_blocked": is_blocked,
                    "is_stale": is_stale,
                    "comments": comments_count,
                    "created_at": created_at_str,
                    "updated_at": updated_at_str,
                    "labels": labels
                }

                acc_result["open_issues"].append(issue_entry)
                if is_blocked:
                    acc_result["blocked_issues"].append(issue_entry)
                if is_stale:
                    acc_result["stale_issues"].append(issue_entry)

        # 3. Actions / Workflow Runs
        runs_data, err = fetch_github_api(f"/repos/{repo}/actions/runs?per_page=10", token=token)
        if err:
            acc_result["errors"].append(f"{repo} actions: {err}")
        elif isinstance(runs_data, dict) and "workflow_runs" in runs_data:
            for r in runs_data.get("workflow_runs", []):
                run_id = r.get("id")
                name = r.get("name", "Workflow")
                status = r.get("status", "unknown")
                conclusion = r.get("conclusion") or status
                event = r.get("event", "")
                created_at_str = r.get("created_at", "")
                html_url = r.get("html_url", f"https://github.com/{repo}/actions/runs/{run_id}")

                run_entry = {
                    "repo": repo,
                    "id": run_id,
                    "name": name,
                    "status": status,
                    "conclusion": conclusion,
                    "event": event,
                    "created_at": created_at_str,
                    "url": html_url
                }

                acc_result["agy_tasks"].append(run_entry)

                if conclusion in ("failure", "timed_out", "startup_failure"):
                    created_dt = parse_iso_datetime(created_at_str)
                    if created_dt:
                        age_h = (now - created_dt).total_seconds() / 3600.0
                        if age_h <= 48.0:
                            acc_result["failed_runs"].append(run_entry)
                    else:
                        acc_result["failed_runs"].append(run_entry)

    if acc_result["failed_runs"] or acc_result["blocked_issues"]:
        acc_result["status"] = "red"
    elif acc_result["stale_issues"]:
        acc_result["status"] = "amber"
    else:
        acc_result["status"] = "green"

    return acc_result


def probe_control_room_gates(acc6_token):
    """Attempt to probe gate health of Control-Room via ACC6_PAT."""
    if not acc6_token:
        return {"status": "unmeasured", "note": "ACC6_PAT not available"}

    url = "/repos/mohammadlali0707-stack/Control-Room/contents/Reports/gates"
    data, err = fetch_github_api(url, token=acc6_token)
    if err or not isinstance(data, list):
        return {"status": "unmeasured", "note": f"Control-Room gate directory query: {err or 'no contents'}"}

    gate_files = [f for f in data if f.get("name", "").startswith("gates-") and f.get("name", "").endswith(".txt")]
    if not gate_files:
        return {"status": "unmeasured", "note": "No gates-*.txt in Control-Room/Reports/gates"}

    latest_file = sorted(gate_files, key=lambda x: x.get("name", ""), reverse=True)[0]
    return {
        "status": "connected",
        "latest_file": latest_file.get("name"),
        "url": latest_file.get("html_url")
    }


def build_status_feed(env_tokens=None, reports_dir=None, subdomain="status.airboxvip.top"):
    """Build the complete status feed document."""
    tokens = env_tokens or os.environ
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_iso = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

    # 1. Local Gate Health
    ccp_gates = collect_latest_gate_report(reports_dir=reports_dir)

    # 2. Control Room Gate Health
    cr_token = tokens.get("ACC6_PAT", "").strip()
    cr_gates = probe_control_room_gates(cr_token)

    # 3. 9-Account Status Gathering
    accounts_feed = []
    all_stuck_items = []
    all_recent_tasks = []

    for acc in ACCOUNTS:
        data = collect_account_data(acc, env_tokens=tokens, now_utc=now_utc)
        accounts_feed.append(data)

        for fr in data.get("failed_runs", []):
            all_stuck_items.append({
                "type": "failed_run",
                "severity": "red",
                "account": data["owner"],
                "repo": fr["repo"],
                "title": f"Workflow run failed: {fr['name']} (ID {fr['id']})",
                "detail": f"Conclusion: {fr['conclusion']}",
                "url": fr["url"],
                "timestamp": fr["created_at"]
            })

        for bi in data.get("blocked_issues", []):
            all_stuck_items.append({
                "type": "blocked_issue",
                "severity": "red",
                "account": data["owner"],
                "repo": bi["repo"],
                "title": f"Blocked issue #{bi['number']}: {bi['title']}",
                "detail": f"Labels: {', '.join(bi['labels'])}",
                "url": bi["url"],
                "timestamp": bi["updated_at"]
            })

        for si in data.get("stale_issues", []):
            all_stuck_items.append({
                "type": "stale_issue",
                "severity": "amber",
                "account": data["owner"],
                "repo": si["repo"],
                "title": f"Stale issue #{si['number']}: {si['title']}",
                "detail": "No activity or replies in > 48 hours",
                "url": si["url"],
                "timestamp": si["updated_at"]
            })

        all_recent_tasks.extend(data.get("agy_tasks", []))

    if ccp_gates.get("status") == "fail" or ccp_gates.get("fail", 0) > 0:
        for fg in ccp_gates.get("failing_gates", []):
            all_stuck_items.append({
                "type": "gate_failure",
                "severity": "red",
                "account": "Mohammadlali",
                "repo": "Mohammadlali/Claud-Cloud-Project",
                "title": f"Failing gate: {fg}",
                "detail": f"Gate suite report: {ccp_gates.get('source')}",
                "url": f"https://github.com/Mohammadlali/Claud-Cloud-Project/blob/claude/gateway-auth-fix-nr7k0b/Reports/gates/{ccp_gates.get('source')}",
                "timestamp": now_iso
            })

    severity_order = {"red": 0, "amber": 1, "yellow": 2}
    all_stuck_items.sort(key=lambda x: (severity_order.get(x["severity"], 9), x.get("timestamp", "")), reverse=False)

    all_recent_tasks.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    all_recent_tasks = all_recent_tasks[:20]

    red_count = len([item for item in all_stuck_items if item["severity"] == "red"])
    amber_count = len([item for item in all_stuck_items if item["severity"] == "amber"])

    if red_count > 0:
        system_status = "red"
        headline = f"ALERT: {red_count} red/blocked item(s) require intervention"
    elif amber_count > 0:
        system_status = "amber"
        headline = f"ATTENTION: {amber_count} stale item(s) pending follow-up"
    else:
        system_status = "green"
        headline = "ALL SYSTEMS NOMINAL -- Quiet Green Doctrine"

    feed = {
        "metadata": {
            "version": 1,
            "generated_at": now_iso,
            "domain": "airboxvip.top",
            "subdomain": subdomain,
            "full_url": f"https://{subdomain}",
            "doctrine": "quiet_green_loud_red"
        },
        "overview": {
            "system_status": system_status,
            "headline": headline,
            "red_count": red_count,
            "amber_count": amber_count,
            "total_accounts": 9,
            "active_accounts": len([a for a in accounts_feed if a["token_available"]]),
            "stuck_items_count": len(all_stuck_items)
        },
        "gates": {
            "claud_cloud_project": ccp_gates,
            "control_room": cr_gates
        },
        "stuck_items": all_stuck_items,
        "recent_agy_tasks": all_recent_tasks,
        "accounts": accounts_feed
    }

    # Attach push notification config for PWA frontend
    r2_upload_url = generate_r2_presigned_upload_url() if generate_r2_presigned_upload_url else None
    feed["push_config"] = {
        "vapid_public_key": os.environ.get("VAPID_PUBLIC_KEY", DEFAULT_VAPID_PUBLIC),
        "r2_upload_url": r2_upload_url
    }

    return feed


def make_stuck_item_key(item):
    """Generate stable unique identity key for a stuck/red item."""
    itype = item.get("type", "unknown")
    repo = item.get("repo", "unknown")
    url = item.get("url", "")
    title = item.get("title", "")
    return f"{itype}:{repo}:{url or title}"


def detect_new_red_items(prev_feed, current_feed):
    """Return only red items that were NOT present in the previous run."""
    if not prev_feed or not isinstance(prev_feed, dict):
        return [item for item in current_feed.get("stuck_items", []) if item.get("severity") == "red"]

    prev_stuck = prev_feed.get("stuck_items", [])
    prev_red_keys = {make_stuck_item_key(it) for it in prev_stuck if it.get("severity") == "red"}

    current_stuck = current_feed.get("stuck_items", [])
    new_red = [it for it in current_stuck if it.get("severity") == "red" and make_stuck_item_key(it) not in prev_red_keys]
    return new_red


def archive_to_r2_if_configured(feed_data):
    """Archive status snapshot to Cloudflare R2 if R2_* env vars exist."""
    endpoint = os.environ.get("R2_S3_ENDPOINT")
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    bucket = os.environ.get("R2_BUCKET", "claud-cloud-status")

    if not (endpoint and access_key and secret_key):
        return False, "R2 credentials not provided in environment; skipping R2 snapshot archival."

    try:
        import boto3
        from botocore.config import Config

        s3 = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(signature_version="s3v4")
        )

        body = json.dumps(feed_data, indent=2)
        s3.put_object(Bucket=bucket, Key="status.json", Body=body, ContentType="application/json")

        ts = feed_data["metadata"]["generated_at"].replace(":", "").replace("-", "")
        s3.put_object(Bucket=bucket, Key=f"history/status-{ts}.json", Body=body, ContentType="application/json")
        return True, f"Successfully archived status to R2 bucket '{bucket}'."
    except ImportError:
        return False, "boto3 not installed; skipping R2 archival."
    except Exception as exc:
        return False, f"R2 upload error: {str(exc)}"


def main():
    parser = argparse.ArgumentParser(description="Collect 9-account status feed")
    parser.add_argument("--out", default=os.path.join(ROOT, "StatusFeed", "status.json"),
                        help="Target output JSON path")
    parser.add_argument("--subdomain", default="status.airboxvip.top",
                        help="Target subdomain on airboxvip.top")
    parser.add_argument("--gates-dir", default=os.path.join(ROOT, "Reports", "gates"),
                        help="Path to gates report directory")
    parser.add_argument("--test-push", action="store_true",
                        help="Send test push notification even if no new red items")
    args = parser.parse_args()

    # Read previous feed snapshot before overwriting
    prev_feed = None
    if os.path.isfile(args.out):
        try:
            with open(args.out, "r", encoding="utf-8") as fh:
                prev_feed = json.load(fh)
        except Exception:
            prev_feed = None

    feed = build_status_feed(reports_dir=args.gates_dir, subdomain=args.subdomain)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(feed, fh, indent=2, ensure_ascii=False)

    print(f"Wrote status feed to: {args.out}")
    print(f"Status: {feed['overview']['system_status'].upper()} - {feed['overview']['headline']}")
    print(f"Gates: {feed['gates']['claud_cloud_project']['pass']}/{feed['gates']['claud_cloud_project']['total']} pass")

    # Detect new red items and deliver Web Push notification
    new_red = detect_new_red_items(prev_feed, feed)
    if new_red or args.test_push:
        count = len(new_red)
        print(f"Push Alert Check: {count} NEW red item(s) detected.")
        if load_subscription_from_r2 and send_push:
            sub, sub_err = load_subscription_from_r2()
            if sub:
                first = new_red[0] if new_red else {"title": "Test notification", "account": "Admin"}
                title = f"[RED ALERT] {count} new stuck item(s) in operations" if new_red else "[TEST] Claud-Cloud Operations"
                body = f"{first['title']} ({first['account']})"
                push_ok, push_msg = send_push(sub, title, body, target_url=f"https://{args.subdomain}#stuck-section")
                print(f"Web Push Dispatch: {push_msg}")
            else:
                print(f"Web Push Notice: Skipped ({sub_err or 'No subscriber registered in R2'}).")
        else:
            print("Web Push Notice: Push modules not available; skipping dispatch.")
    else:
        print("Push Alert Check: No new red items (Quiet Green doctrine enforced).")

    r2_ok, r2_msg = archive_to_r2_if_configured(feed)
    print(f"R2 Snapshot: {r2_msg}")

    emit_digest("status_feed_collected", "pass", {
        "out": os.path.relpath(args.out, ROOT) if args.out.startswith(ROOT) else args.out,
        "system_status": feed["overview"]["system_status"],
        "red_count": feed["overview"]["red_count"],
        "amber_count": feed["overview"]["amber_count"],
        "new_red_count": len(new_red),
        "accounts_total": feed["overview"]["total_accounts"],
        "accounts_active": feed["overview"]["active_accounts"],
        "gates_status": feed["gates"]["claud_cloud_project"]["status"],
        "subdomain": args.subdomain
    })

    return 0


if __name__ == "__main__":
    sys.exit(main())
