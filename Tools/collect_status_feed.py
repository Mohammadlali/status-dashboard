#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Per-project status feed collector for the fleet's tracked products.

For each project in PROJECTS, using that project's own account PAT:
- Recent commits.
- Open, blocked, and stale issues.
- Latest Actions run outcomes (success/failure).
- Gate health from that repo's own Reports/gates/*.txt, read live via the
  GitHub API (never local disk -- this collector runs from
  Mohammadlali/status-dashboard, which is not any of the repos it reports on).
- Anything red or stuck (failed runs, blocked issues, stale issues, failing
  gates) rolled into one alert list.
- Enforces the project doctrine: quiet green when nominal, prominent red
  alerts when stuck.
- Optionally archives snapshots to Cloudflare R2 if R2_* credentials are provided.

This is deliberately project-centric, not account-centric: two accounts in
this fleet (ACC0, ACC6) each host more than one product, so "one card per
account" cannot answer "how is project X doing" on its own. PROJECTS names
each product once, independent of which account happens to host it.

Usage:
    python3 Tools/collect_status_feed.py [--out StatusFeed/status.json] [--subdomain status.airboxvip.top]
"""

import argparse
import base64
import datetime
import json
import os
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

# Every product this fleet runs, named once, independent of which of the 9
# accounts happens to host it. ACC0 hosts both Control-Room and this
# dashboard; ACC6 hosts Claud-Cloud-Project (TEHRAN: BLIND SPOT) since the
# 2026-09-11 migration -- an account-shaped list cannot represent that.
PROJECTS = [
    {
        "key": "tbs",
        "name": "TEHRAN: BLIND SPOT",
        "repo": "mohammadlali0707-stack/Claud-Cloud-Project",
        "pat_env": "ACC6_PAT",
        "role": "ویژوال ناول فارسی (Ren'Py) -- تنها محصول میزبانی‌شده روی ACC6"
    },
    {
        "key": "control_room",
        "name": "Control-Room",
        "repo": "Mohammadlali/control-room",
        "pat_env": "ACC0_PAT",
        "role": "هماهنگی سازمانی و پل‌های cross-account، میزبانی روی ACC0"
    },
    {
        "key": "airboxvip",
        "name": "AirboxVIP Coffeenet",
        "repo": "momonakikugava-pixel/AirboxVIP_Coffeenet",
        "pat_env": "ACC1_PAT",
        "role": "ربات ووچر قهوه‌نت"
    },
    {
        "key": "status_dashboard",
        "name": "Status Dashboard",
        "repo": "Mohammadlali/status-dashboard",
        "pat_env": "ACC0_PAT",
        "role": "همین داشبورد وضعیت که در حال مشاهده‌اش هستید"
    },
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


def parse_gate_suite_report_text(text):
    """Parse a gates-*.txt transcript's real ##TBS## gate_suite line into
    pass/fail/unmeasured/commit."""
    pass_count = fail_count = unmeasured_count = 0
    cited_commit = None
    overall_status = "pass"

    for line in text.splitlines():
        if MARKER not in line:
            continue
        idx = line.find(MARKER)
        raw = line[idx + len(MARKER):].strip()
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        if obj.get("probe") != "gate_suite":
            continue
        data = obj.get("data", {})
        pass_count = data.get("pass", pass_count)
        fail_count = data.get("fail", fail_count)
        unmeasured_count = data.get("unmeasured", unmeasured_count)
        cited_commit = data.get("commit", cited_commit)
        overall_status = obj.get("status", overall_status)

    total = pass_count + fail_count + unmeasured_count
    if fail_count > 0 or unmeasured_count > 0:
        overall_status = "fail"

    return {
        "status": overall_status,
        "total": total,
        "pass": pass_count,
        "fail": fail_count,
        "unmeasured": unmeasured_count,
        "commit": cited_commit,
    }


def probe_repo_gates(token, repo):
    """Live gate health for a repo, read via the GitHub API rather than
    local disk -- this collector runs from Mohammadlali/status-dashboard,
    which is never the repo whose gates it is checking."""
    if not token:
        return {"status": "unmeasured", "note": "no token available for this project"}

    url = f"/repos/{repo}/contents/Reports/gates"
    data, err = fetch_github_api(url, token=token)
    if err or not isinstance(data, list):
        return {"status": "unmeasured", "note": f"{repo}: gate directory query failed: {err or 'no contents'}"}

    gate_files = [f for f in data if f.get("name", "").startswith("gates-") and f.get("name", "").endswith(".txt")]
    if not gate_files:
        return {"status": "unmeasured", "note": f"No gates-*.txt in {repo}/Reports/gates"}

    latest_file = sorted(gate_files, key=lambda x: x.get("name", ""), reverse=True)[0]

    file_meta, ferr = fetch_github_api(latest_file.get("url"), token=token)
    if ferr or not isinstance(file_meta, dict) or "content" not in file_meta:
        return {
            "status": "unmeasured",
            "source": latest_file.get("name"),
            "url": latest_file.get("html_url"),
            "note": f"could not read file content: {ferr or 'no content field'}"
        }

    try:
        text = base64.b64decode(file_meta["content"]).decode("utf-8", errors="replace")
    except Exception as exc:
        return {
            "status": "unmeasured",
            "source": latest_file.get("name"),
            "url": latest_file.get("html_url"),
            "note": f"decode error: {exc}"
        }

    parsed = parse_gate_suite_report_text(text)
    parsed["source"] = latest_file.get("name")
    parsed["url"] = latest_file.get("html_url")
    return parsed


def collect_project_status(project, env_tokens=None, now_utc=None):
    """One project's full standalone status: gate health, recent commits,
    open/blocked/stale issues, and recent Actions runs (with failures
    flagged) -- all through that project's own account PAT."""
    tokens = env_tokens or os.environ
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    token = tokens.get(project["pat_env"], "").strip()
    repo = project["repo"]

    result = {
        "key": project["key"],
        "name": project["name"],
        "repo": repo,
        "role": project["role"],
        "token_available": bool(token),
        "status": "offline_unconfigured",
        "gates": {"status": "unmeasured", "note": f"{project['pat_env']} not available"},
        "commits": [],
        "open_issues": [],
        "blocked_issues": [],
        "stale_issues": [],
        "recent_runs": [],
        "failed_runs": [],
        "errors": [],
    }
    if not token:
        result["note"] = f"Secret {project['pat_env']} is not injected into current environment"
        return result

    result["gates"] = probe_repo_gates(token, repo)

    # Recent commits
    commits_data, err = fetch_github_api(f"/repos/{repo}/commits?per_page=5", token=token)
    if err:
        result["errors"].append(f"commits: {err}")
    elif isinstance(commits_data, list):
        for c in commits_data:
            sha = c.get("sha", "")[:7]
            commit_obj = c.get("commit", {})
            result["commits"].append({
                "sha": sha,
                "message": commit_obj.get("message", "").split("\n")[0][:90],
                "author": commit_obj.get("author", {}).get("name", project["name"]),
                "date": commit_obj.get("author", {}).get("date", ""),
                "html_url": c.get("html_url", f"https://github.com/{repo}/commit/{sha}")
            })

    # Open / blocked / stale issues
    issues_data, err = fetch_github_api(f"/repos/{repo}/issues?state=open&per_page=15", token=token)
    if err:
        result["errors"].append(f"issues: {err}")
    elif isinstance(issues_data, list):
        for iss in issues_data:
            if "pull_request" in iss:
                continue

            num = iss.get("number")
            title = iss.get("title", "")
            body = iss.get("body", "") or ""
            labels = [lb.get("name", "").lower() for lb in iss.get("labels", [])]
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
                "number": num,
                "title": title,
                "url": html_url,
                "is_blocked": is_blocked,
                "is_stale": is_stale,
                "comments": comments_count,
                "created_at": iss.get("created_at", ""),
                "updated_at": updated_at_str,
                "labels": labels
            }

            result["open_issues"].append(issue_entry)
            if is_blocked:
                result["blocked_issues"].append(issue_entry)
            if is_stale:
                result["stale_issues"].append(issue_entry)

    # Recent Actions runs
    runs_data, err = fetch_github_api(f"/repos/{repo}/actions/runs?per_page=10", token=token)
    if err:
        result["errors"].append(f"actions: {err}")
    elif isinstance(runs_data, dict) and "workflow_runs" in runs_data:
        for r in runs_data.get("workflow_runs", []):
            run_id = r.get("id")
            conclusion = r.get("conclusion") or r.get("status", "unknown")
            created_at_str = r.get("created_at", "")
            run_entry = {
                "id": run_id,
                "name": r.get("name", "Workflow"),
                "status": r.get("status", "unknown"),
                "conclusion": conclusion,
                "event": r.get("event", ""),
                "created_at": created_at_str,
                "url": r.get("html_url", f"https://github.com/{repo}/actions/runs/{run_id}")
            }
            result["recent_runs"].append(run_entry)

            if conclusion in ("failure", "timed_out", "startup_failure"):
                created_dt = parse_iso_datetime(created_at_str)
                age_h = (now - created_dt).total_seconds() / 3600.0 if created_dt else 0.0
                if not created_dt or age_h <= 48.0:
                    result["failed_runs"].append(run_entry)

    if result["failed_runs"] or result["blocked_issues"] or result["gates"].get("fail", 0) > 0:
        result["status"] = "red"
    elif result["stale_issues"]:
        result["status"] = "amber"
    else:
        result["status"] = "green"

    return result


def build_status_feed(env_tokens=None, subdomain="status.airboxvip.top"):
    """Build the complete status feed document."""
    tokens = env_tokens or os.environ
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_iso = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

    projects_feed = [collect_project_status(p, env_tokens=tokens, now_utc=now_utc) for p in PROJECTS]

    all_stuck_items = []
    all_recent_runs = []

    for proj in projects_feed:
        name = proj["name"]
        repo = proj["repo"]

        for fr in proj.get("failed_runs", []):
            all_stuck_items.append({
                "type": "failed_run",
                "severity": "red",
                "account": name,
                "repo": repo,
                "title": f"اجرای ناموفق: {fr['name']} (#{fr['id']})",
                "detail": f"نتیجه: {fr['conclusion']}",
                "url": fr["url"],
                "timestamp": fr["created_at"]
            })

        for bi in proj.get("blocked_issues", []):
            all_stuck_items.append({
                "type": "blocked_issue",
                "severity": "red",
                "account": name,
                "repo": repo,
                "title": f"ایشوی مسدود #{bi['number']}: {bi['title']}",
                "detail": f"برچسب‌ها: {', '.join(bi['labels'])}",
                "url": bi["url"],
                "timestamp": bi["updated_at"]
            })

        for si in proj.get("stale_issues", []):
            all_stuck_items.append({
                "type": "stale_issue",
                "severity": "amber",
                "account": name,
                "repo": repo,
                "title": f"ایشوی بدون‌پاسخ #{si['number']}: {si['title']}",
                "detail": "بدون فعالیت یا پاسخ در بیش از ۴۸ ساعت",
                "url": si["url"],
                "timestamp": si["updated_at"]
            })

        g = proj.get("gates", {})
        if g.get("fail", 0) > 0:
            all_stuck_items.append({
                "type": "gate_failure",
                "severity": "red",
                "account": name,
                "repo": repo,
                "title": f"{g.get('fail')} گیت ناموفق در {name}",
                "detail": f"گزارش: {g.get('source', '-')}",
                "url": g.get("url") or f"https://github.com/{repo}",
                "timestamp": now_iso
            })

        all_recent_runs.extend(
            {**r, "project": name, "repo": repo} for r in proj.get("recent_runs", [])
        )

    severity_order = {"red": 0, "amber": 1, "yellow": 2}
    all_stuck_items.sort(key=lambda x: (severity_order.get(x["severity"], 9), x.get("timestamp", "")), reverse=False)

    all_recent_runs.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    all_recent_runs = all_recent_runs[:20]

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
            "version": 2,
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
            "total_projects": len(projects_feed),
            "active_projects": len([p for p in projects_feed if p["token_available"]]),
            "stuck_items_count": len(all_stuck_items)
        },
        "projects": projects_feed,
        "stuck_items": all_stuck_items,
        "recent_runs": all_recent_runs
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
    parser = argparse.ArgumentParser(description="Collect per-project status feed")
    parser.add_argument("--out", default=os.path.join(ROOT, "StatusFeed", "status.json"),
                        help="Target output JSON path")
    parser.add_argument("--subdomain", default="status.airboxvip.top",
                        help="Target subdomain on airboxvip.top")
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

    feed = build_status_feed(subdomain=args.subdomain)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(feed, fh, indent=2, ensure_ascii=False)

    print(f"Wrote status feed to: {args.out}")
    print(f"Status: {feed['overview']['system_status'].upper()} - {feed['overview']['headline']}")
    for proj in feed["projects"]:
        g = proj["gates"]
        print(f"Project {proj['name']}: gates {g.get('pass', 0)}/{g.get('total', 0)} ({g.get('status', 'unmeasured')}), overall {proj['status']}")

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
        "projects_total": feed["overview"]["total_projects"],
        "projects_active": feed["overview"]["active_projects"],
        "projects_status": {p["key"]: p["status"] for p in feed["projects"]},
        "subdomain": args.subdomain
    })

    return 0


if __name__ == "__main__":
    sys.exit(main())
