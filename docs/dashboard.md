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

## Independent availability segments and duration ranges

Current policy: **a recorded unavailable result always ends that store/SKU's segment. A later positive result starts a new row, even one second later. No wave merging and no global historical-first field are published or displayed.** The prior wave presentation was removed because it counted across confirmed no-stock intervals.

Each row shows the same store/configuration's first positive observation (`start`), last positive observation (`last_seen`), and first subsequent negative confirmation (`end`, if known). Displayed duration is a range labeled **有货时长范围（估计）**: `duration_lower_seconds = last_seen - start`, and `duration_upper_seconds = next_unavailable.t - previous_unavailable.t` when both surrounding negative queries are usable. No next segment is included. Unknown ends have an unknown upper bound; the current clock is never substituted. A single observed time point can have a zero lower bound and a nonzero upper bound. The upper interval now starts at the preceding last successful negative, not the first positive. These are response-time observation estimates, not proven physical inventory lifetimes.

The backend exports only independent `periods` plus `history_rules` with `merge_across_unavailable=false` and `duration_basis=positive_span_to_surrounding_negative_span`. There is no merged `waves` output or historical first field. Validated surrounding negative queries determine the upper duration estimate; the lower estimate uses only positive observations. Filters do not regroup or extend intervals.

Valid per-store/SKU snapshot negatives or later successful zero-offer queries with matching SKU/store coverage end a segment. HTTP failures and missing coverage remain unknown, never out-of-stock. Historical snapshots were overwritten, so retained evidence cannot prove every unrecorded transition. More than 120 seconds without any positive observation and no valid negative also splits a segment as `observation_gap`, with unknown end. A current positive snapshot cannot extend an older segment across such a gap.

Indexed in-memory evidence lookup avoids a repeated database scan per positive observation. Tests cover immediate restock after a negative, exact per-segment duration, excluding delayed negative confirmation, zero-span single observations, unknown long gaps, matching coverage and errors, current snapshot isolation, different-store separation and indexed/direct evidence equivalence.

Example: negative at 08:00:00, positive at 08:00:01, last positive at 08:00:03, next negative at 08:00:04 gives a displayed estimate of **2–4 seconds**: lower = 03−01; upper = 04−00. A negative between positives still splits the records; no time from the next segment is borrowed.


### Evidence record count is not an independent query count

One query response can yield a positive event-log record, a positive snapshot record, and a saved last-positive snapshot when the state changes. The old `observations` count incorrectly suggested these were distinct query observations. It has been removed from the UI and renamed `evidence_records` in exported data. Because older records lack a shared request ID, the dashboard does not invent an exact independent-query count or deduplicate requests using an arbitrary time threshold.

History timestamps now show milliseconds; for example the retained Queens Center / black 512GB record at 16:05:23.541–16:05:23.542 contains three records but only about 1ms of observed timestamp difference. At second-level resolution both endpoints looked identical. The lower observation span is about 0.001 seconds, not “three successful checks over zero seconds.” Under the current surrounding-query rule, the preceding validated negative finished at 16:05:23.399 and the first usable following negative at 16:05:26.323, giving an estimated **0.001–2.924 seconds**. The snapshot at 16:05:24.799 is retained as observed negative evidence but is not itself used as a traceable non-overlapping boundary.

Fourteen focused tests now cover duplicate same-instant evidence, a zero lower bound with a known upper bound, unknown ends, excluding later segments, and all previous coverage/error/segmentation guarantees.

### Error-versus-unavailable audit, 2026-10-27

An HTTP/network/schema error never proves absence. Historical query inference requires the post-validation result `http_200`, `offers=0`, the matching SKU and known store coverage, and a request that started after the last positive observation. A successful HTTP response alone is insufficient: empty/malformed responses or missing fields fail parsing rather than becoming a negative.

Snapshot evidence comes from `last-inventory.json`, which both production backends replace only after inventory parsing succeeds. The dashboard validates its location, store records, requested SKUs, availability flags and pickup-date schema again. Snapshot errors roll back without clearing the last positive state. Missing stores are not visited or turned into negative records. A stale snapshot remains stale, not a new negative. A long observation gap is labeled unknown rather than confirmed unavailable.

All 140 retained `query_empty` segment endings were checked against their exact recorded completion timestamp, validated-success result, zero offers, matching SKU/store coverage and request start after the last positive; zero mismatches were found. The other 101 endings use snapshot evidence; old full snapshots were overwritten and cannot all be independently replayed. Their producer/consumer validation paths were reviewed and covered by tests instead of claiming the original bodies remain available.

Fifteen tests passed, including a currently positive snapshot followed by missing SKU, missing boolean flag, unknown display status, wrong ZIP, empty store list and an error body: none writes a negative or clears the positive state. A subsequent explicit unavailable response does. The error-query test also covers HTTP 541/403/429/500, network errors, non-JSON, invalid response and missing coverage, even if a failed row happens to contain `offers=0`.

“Unavailable” here means not qualifying for the configured near-term pickup window (today through the next three days). A store with a later pickup date can cease to qualify without being physically sold out; error handling and this eligibility rule are separate concepts.


## Surrounding-negative bounds and pre-detection request timing

Current upper estimate (2026-10-27): **first usable negative after the positive segment minus the last usable negative before it**. The positive-span lower estimate is unchanged. The UI now has seven columns, adding preceding negative response time, gap until first positive and that request's latency. The following negative column distinguishes a validated non-overlapping query from an old snapshot whose request timing is unknown.

Boundary selection uses only post-validation `http_200` / zero-eligible-offer queries with the same SKU and known store coverage. A following boundary must have started after the segment's last positive and returned before the next positive segment. For a later segment, a preceding boundary must also have started after the previous segment's last positive; an older negative from before a different stock episode cannot be borrowed. Error rows and old snapshots without stable request IDs do not establish finite range boundaries. Segment splitting still retains snapshot negative observations, but shows their unverified request timing.

Exported fields: `previous_unavailable` / `next_unavailable` contain response time `t`, request start and latency; `pre_detection_gap_seconds` measures first positive minus preceding negative response time. `duration_upper_seconds` is null if either side is missing. `upper_unknown_reason` explains why. `request_envelope_upper_seconds` includes the preceding negative request's entire latency (next negative response minus preceding negative request start), shown in the duration tooltip as a looser reference. Neither interval claims Apple's exact server-side evaluation time or cache freshness. Positive legacy observations also lack a shared request ID, so not every overlapping positive/negative response can be totally ordered.

Audit of the 88 old records whose first-positive-to-negative span was at most three seconds: a loose prior-response scan found 71 had a successful zero-offer response within three seconds before first detection (31 within one second), but this did not yet exclude boundaries from before another segment. After the stricter per-segment/request-order checks, 64 have usable preceding negatives; 56 of those are within three seconds, 23 within one second, and five over ten seconds away. Only 45 have both usable sides; 43 now have unknown upper estimates (24 lack a valid preceding boundary, 19 lack a following non-overlapping boundary). These data do not establish whether stock was purchased or withdrawn.

Eighteen focused tests pass, including the new upper formula, nearest preceding/first following selection, error/wrong-store exclusion, in-flight negative exclusion, not borrowing another segment's boundaries, absent-boundary unknowns and request-envelope arithmetic. Production monitor PID 87305 was unchanged; only the independent dashboard observer was reloaded.
