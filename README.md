# status-dashboard

Fleet-wide operations status dashboard for **status.airboxvip.top**.

Shows live health for:
- `mohammadlali0707-stack/Claud-Cloud-Project` (CCP) gates
- `mohammadlali0707-stack/Control-Room` gates
- All 9 fleet accounts (recent commits, open/blocked/stale issues, recent Actions runs)

## Why this repo exists

This dashboard used to live inside CCP's own repo (`StatusFeed/` +
`.github/workflows/deploy-status-feed.yml`). It was moved out 2026-09-11
because it was never CCP-specific -- it reports on Control-Room and all 9
accounts too, and CCP itself now lives entirely on a different GitHub
account (ACC6, `mohammadlali0707-stack`). At the time, a fleet-wide
dashboard belonging to the account that manages the fleet meant ACC0
(`Mohammadlali`), and this repo was created there.

**Corrected 2026-09-13: this repo itself now lives on ACC6
(`mohammadlali0707-stack/status-dashboard`), alongside Control-Room and
CCP** -- ACC0 no longer manages the fleet (Control-Room moved off it too;
see `mohammadlali0707-stack/Control-Room`'s `Team/COMPANY_SCOPE.md`, "What
changed 2026-09-13"), so the original placement reasoning above no longer
holds, though the repo's identity (not CCP-specific) is unchanged.

## Layout

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The dashboard UI (Persian/RTL) |
| `manifest.json`, `sw.js`, `icons/` | PWA install + push notification support |
| `api/subscribe.js` | Vercel serverless function storing push subscriptions in Cloudflare R2 |
| `vapid_public.json` | Public half of the Web Push VAPID keypair (not secret) |
| `vercel.json` | Names the Vercel project (`claud-cloud-status`) so deploys keep landing on the same project/domain |
| `Tools/collect_status_feed.py` | Regenerates `status.json` by querying all 9 accounts + Control-Room via their PATs |
| `Tools/send_push_notification.py` | Encrypted Web Push delivery (RFC 8291/8292) when a new red item appears |
| `Tools/ensure_cloudflare_dns.py` | Read-first Cloudflare DNS check -- only adds the subdomain CNAME if missing, never touches existing records |
| `.github/workflows/deploy-status-feed.yml` | Scheduled (every 5 min) + manual: regenerate `status.json`, ensure DNS, deploy to Vercel |

## Secrets this repo needs

`ACC0_PAT` .. `ACC8_PAT` (one PAT per fleet account, for cross-account status
queries -- `ACC0_PAT` doubles as this repo's own self-push credential, a
cross-account one as of 2026-09-13 since this repo itself moved to ACC6),
`VERCEL_TOKEN`, `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_S3_ENDPOINT`, `VAPID_PRIVATE_KEY`,
`VAPID_PUBLIC_KEY` (optional).

## The `Reports/gates` gap

`collect_latest_gate_report()` looks for `Reports/gates/gates-*.txt` in
*this* repo to build the "CCP gate health" card. That directory doesn't
exist here (CCP's own gate reports live on ACC6, not in this dashboard
repo), so it degrades gracefully to `"status": "unmeasured"` rather than
crashing -- this is a known, accepted gap from the move, not a bug. Making
that card cross-repo (querying ACC6's `Reports/gates` via API, the same way
`probe_control_room_gates()` already does for Control-Room) is real
follow-up work, not yet done.
