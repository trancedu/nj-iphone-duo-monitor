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

## History display revision: waves, segments and elapsed span

The earlier “first found” column was a segment start, which could look like a false global first when inventory flickered between available/unavailable. The default history now shows **arrival waves**, with an optional **raw observation segments** view and expandable segments inside each merged wave.

- Group only the same store and SKU. Adjacent segments merge if the preceding segment has a known disappearance observation and the next segment starts within **120 seconds of its last positive observation**. This is a display heuristic, not proof of one physical replenishment or continuous availability. All negative evidence remains in the raw segments.
- Longer gaps become separate waves. More than 120 seconds without positive observations and without any valid disappearance evidence split raw segments with `end_reason=observation_gap`; the unknown end is never invented. A current positive snapshot cannot extend an old period across a long monitoring outage.
- `historical_first_seen` is the earliest retained observation for that store/SKU, independent of filters. It is not Apple's first-ever availability. Chronological `wave_number` and `segment_number` distinguish later arrivals. Filtering never recomputes these starts or numbers.
- `start`: this wave/segment's earliest observation; `last_seen`: its last positive observation; `end`: the final confirmed loss of near-term pickup eligibility. A latest snapshot only marks the latest matching segment as current, never old unknown periods.
- The displayed conservative duration is always **`observed_span_seconds = last_seen - start`**, labeled **有货首末跨度（保守）** in both wave and raw-segment views. It excludes all time after the last confirmed positive observation, even when a later negative confirmation exists. Unknown/ongoing ends still have a computable positive-observation span. A single time point displays 0 seconds with actual duration unknown. Merged waves may include short unavailable gaps, so this is not guaranteed continuous availability. `elapsed_seconds = end - start` remains an exported diagnostic field but is no longer used for the visible duration.

The exporter returns both `periods` (raw segments) and `waves` (including each raw segment), plus `history_rules`. These are derived from the existing retained evidence; no inventory request, notification policy or monitor state changes are needed. An indexed in-memory timeline built from one SQL history pass avoids a repeated query per observation and keeps the five-second UI refresh practical as history grows.

Verification: 12 focused dashboard tests passed, including flicker merging, earliest/latest timestamps and elapsed arithmetic, separation after long gaps, unknown ends, current snapshot isolation, different-store separation and equivalence of indexed versus direct absence evidence. On retained production evidence, 241 raw segments produced 96 display waves, with history calculation taking about 0.05 seconds. Browser store/color/capacity filters, wave expansion and switching to raw segments worked without console errors.

Example from retained history (all times Eastern, 2026-10-27): Fifth Avenue / white 256GB wave 7 began at **17:00:13**, was last observed available at **17:01:24**, and had a final inferred negative confirmation at **17:01:38**. The displayed conservative first-to-last-positive span is approximately **1 minute 11 seconds** (17:01:24 minus 17:00:13), covering two raw segments; the earlier history-first timestamp remains **08:49:24**. The roughly 14 seconds until the later negative confirmation are excluded. Short unavailable gaps within the merged wave are still possible, so this is not guaranteed continuous stock.
