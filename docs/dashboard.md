# Read-only pickup dashboard

Private URL on this Mac mini: **http://100.83.108.82:8890/iphone-duo-dashboard/**

Open from a device connected to the same Tailscale network. This is a private preview, not a public website; no Funnel or router port forwarding is enabled. The existing shared report server binds to the Mini's Tailscale address on port 8890.

## What it shows

- Current 12-store, four-configuration inventory: 256GB / 512GB × Star White / Night Sky, from the production ZIP 07094 response.
- Separate store cards and a filterable history by store, capacity, color and date range. Older 1TB / 2TB observations are retained and marked historical; they are not currently polled.
- First positive observation, last positive observation, pickup dates and subsequent disappearance evidence. Repeated observations are merged into periods, never presented as a count of phones.
- 5 / 30 / 60 minute request counts, errors, HTTP 541, success rate, mean/P95/max successful refresh gaps, average successful response latency, a one-hour per-minute result chart and the last 200 completed queries.
- Stale data and connection warnings. A failed query is never interpreted as out-of-stock.

All times are America/New_York. Eligibility means the existing monitor's criteria: selectable pickup store, available status, and pickup date from today through the configured next three days. A loss of eligibility is not necessarily physical sold-out stock.

## Architecture and isolation

```text
Existing inventory service (unchanged)
  ├─ Telegram / Mac bridge (unchanged)
  └─ existing local query logs + positive events + latest snapshot
                 ↓ read only, incremental JSONL offsets
       dashboard/collector.py (separate LaunchAgent, nice +10)
          ├─ runtime/dashboard/history.sqlite3 (private state)
          └─ dashboard/site/data.json (sanitized, atomic replacement)
                 ↓ existing private report HTTP server
       dashboard/site/index.html + style.css + app.js
```

The observer reads existing files every 0.5 seconds, exports JSON roughly every five seconds, and the visible browser page fetches JSON every five seconds. Background tabs pause fetching until visible. It makes **no Apple, proxy, Telegram or Mac receiver requests**, loads no credential files, and writes neither the production monitor's state nor its configuration. It does import the existing parsing functions to preserve the current eligibility semantics.

Only `dashboard/site` is linked into the shared web root. Do not link the repository, `runtime`, logs or private environment files. The published JSON contains public store/product data and aggregate operational statistics; no proxy addresses, credentials, cookies or checkout data. Generated JSON and SQLite state are not committed.

## Historical evidence limitations

Before this dashboard, positive observations were retained but full inventory snapshots were overwritten. It is impossible to reconstruct every historical sold-out instant exactly.

- `snapshot`: the observer saw that exact store/configuration cease to qualify. The timestamp is the local snapshot write time, not Apple's physical inventory transition time.
- `query_empty`: a successful later query, started after the last positive observation, included the same SKU and known store coverage and returned zero eligible offers. This supplies an **upper bound**, labeled historical inference. Current coverage inference is intentionally restricted to known 07094/12-store responses.
- No matching evidence: end remains unknown. Unknown does not mean still available.

The new observer persists state transitions, including the last positive snapshot before a negative one. Sampling can miss intermediate snapshots or extremely short transitions. HTTP errors, malformed snapshots, missing SKUs or unknown coverage cannot close a period. All snapshot changes roll back together on malformed input.

## Installation and operation on the Mini

Python 3.9+ and the existing monitor repository are required. No new packages are required.

```sh
cd /Users/codex/workspace/nj-iphone-duo-monitor
python3 -m unittest discover -s tests -p test_dashboard.py -v
python3 dashboard/collector.py --once  # initial import; only while observer is stopped
python3 deploy/dashboard_service.py install
python3 deploy/dashboard_service.py status
```

`install` writes `~/Library/LaunchAgents/com.trancedu.iphone-duo-dashboard.plist` and starts only the observer. If already loaded, it leaves it running. LaunchAgent starts at login and restarts after failure. The collector uses a lock to prevent duplicate observers. Check `runtime/dashboard/stdout.log` and `stderr.log` for collector failures.

Publish once through the **existing** report server:

```sh
ln -s /Users/codex/workspace/nj-iphone-duo-monitor/dashboard/site \
  /Users/codex/workspace/_published_reports/iphone-duo-dashboard
curl -I http://100.83.108.82:8890/iphone-duo-dashboard/
```

If the symlink exists, leave it in place. The shared service is `com.trance.published-reports-server`; never change its web root to the repository. Frontend edits need a browser reload. To apply collector changes, restart **only** this observer:

```sh
python3 deploy/dashboard_service.py stop
python3 deploy/dashboard_service.py install
```

Stopping/removing this dashboard does not stop inventory monitoring. To remove web access, unlink only `_published_reports/iphone-duo-dashboard`. Keep the private SQLite database if you want to retain observed transitions.

## Deployment verification, 2026-10-27

- Six focused tests passed: error handling, SKU/store coverage and request timing, period splitting, incremental/incomplete JSONL ingestion, malformed snapshots and export field whitelisting.
- Private URL returned HTTP 200; browser loaded current data without console errors. Store/capacity filters and error-only query filter worked. The existing narrow browser viewport displayed responsive cards correctly.
- Observer PID 75561; source monitor PID 72913 remained unchanged. Observer stderr was empty; all 48 store/configuration rows were present and generated data was fresh.
