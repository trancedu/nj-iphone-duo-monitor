# NJ / NY iPhone Duo pickup monitor

> 当前规则已更新：最多额外刷新2次；明确无货回袋后提前解锁；优先新请求，否则补跑10秒内最新候选；有货页面永不自动回袋/解锁。详见[最新执行策略](docs/pickup-execution-policy.md)。下文旧策略描述保留为历史记录。

Current Mac receiver policy (2026-10-27): Safari is active, with Chrome available
as a standby. One browser task runs at a time. After two additional unavailable
checks, a verified Bag restore releases the lock; new arrivals take priority over
the newest waiting request still within ten seconds. Finding target stock protects
the page from all automatic return/unlock; only tasks without stock expire after
60 seconds. See the [shared execution policy](docs/pickup-execution-policy.md) and
[deployment/unlock notes](docs/chrome-first-arrival-2026-10-27.md).

Python 3.9+ standard-library monitor for Apple US store pickup.

## Split pickup response (Mac mini → Mac)

See the [current end-to-end flow and Mini–Mac HTTP protocol](docs/current-pickup-flow.md) for polling, Telegram, authenticated LAN delivery, retries, status queries and deduplication. The production Mac receiver routes four products to independent Safari Profiles; its configured workflow prepares pickup details and stops before final Apple Pay authorization. The original [split deployment guide](docs/split-pickup-deployment.md) documents the initial Chrome/dry-run setup. LAN forwarding is opt-in; existing Telegram stock alerts remain independent.

The optional [DataImpulse smoke test](docs/dataimpulse-smoke.md) checks credentials, country targeting and one inventory response with bounded traffic. It does not enable DataImpulse production polling.

The [bounded hybrid fallback](docs/hybrid-dataimpulse.md) can use DataImpulse only when successful inventory refreshes are stale. It shares existing notifications and has absolute expiry and paid-request/body budgets; it is disabled unless configured.

See the [2s / 1.5s / 1s DataImpulse cadence comparison](docs/dataimpulse-cadence-2026-10-27.md) for the finite isolated experiment and its response-time, gap and traffic tradeoffs.

## Private dashboard

The [read-only stock dashboard](docs/dashboard.md) shows live store/configuration status, availability history, disappearance evidence and request health. Open http://100.83.108.82:8890/iphone-duo-dashboard/ from the same Tailscale network. Its independent observer does not add Apple requests or change the monitor.

## Current stock monitoring

Current Mac mini deployment (2026-10-27): **`dataimpulse_monitor.py` is the only live inventory source**, targeting US Rotating exits, ZIP **07094 (12 stores)** and all four 256GB/512GB color combinations. Target dispatch spacing is one second with at most four requests in flight. Telegram, LAN forwarding and stock deduplication are preserved. The old subscription-pool and hybrid trial modes are inactive. See [current DataImpulse-only deployment](docs/dataimpulse-live.md); older proxy/region schedules below are historical modes.

- Production alerts: iPhone Duo only, connect to a carrier later. Every request batches all four 256GB/512GB × Star White/Night Sky configurations; 1TB and 2TB are excluded.
- Alert only when store selection is enabled AND the **pickup** upper date is today through three days ahead in America/New_York. Delivery dates never trigger an alert.
- Regular scans start approximately every 180–190 seconds. Every day from 07:55 inclusive to 08:15 exclusive in America/New_York, scans start approximately every 60–70 seconds. Two sequential regional requests, five seconds apart, remain the maximum per cycle. Each request batches both selected SKUs. Failures always use the longer backoff, including during the morning window. No parallel workers or overlapping scans.
- HTTP errors back off 5, 10, 20, 40, then 60 minutes; honor longer Retry-After. No proxy rotation, CAPTCHA handling, or immediate retry loops.
- Same store/SKU/date notification suppressed for 30 minutes, including across restarts. Failed sends are retried on a later scan.
- An independent launchd watchdog checks health every minute. Process exits/hangs must persist for two minutes; failed queries/notifications for five minutes. It sends one alert per outage and one recovery notice after two healthy checks. New outage alerts are limited to one per hour; failed Telegram attempts retry at most every five minutes. State survives restarts.

## Verified on 2026-10-24

The repository was empty when cloned. The legacy `/shop/fulfillment-messages` API returned HTTP 541. The first replacement, `/shop/sba/pickup-detail`, returned only 12 stores despite 35 requested IDs. That implementation missed observable stores.

The coverage investigation on 2026-10-24 verified all 35 NJ/NY store IDs using `/shop/retail/pickup-message`, with regional ZIP queries and `parts.0` / `parts.1` batching. Production now uses this endpoint. See [the investigation report](docs/coverage-investigation-2026-10-24.md).

Production was optimized on 2026-10-25 to a fixed pair: **07078 (Short Hills) + 11530 (Garden City)**. Each captured response contains 12 stores; only SoHo and Upper West Side overlap, yielding **22 distinct watched stores every cycle**, including American Dream, all seven Manhattan stores, both Brooklyn stores and Queens Center. This is the best qualifying pair among the captured candidates, not a proven optimum over every ZIP. A new 07054 probe returned HTTP 541, so further probing stopped. See [pair comparison](docs/region-optimization-2026-10-25.json).

White 256GB is now checked at every watched store each cycle: about 3–3.2 minutes normally, or 1–1.2 minutes in the morning window, absent errors. The second SKU is random and has no fixed revisit interval. Southern NJ, northern fringe stores, Smith Haven and the four distant upstate stores are outside this focused 22-store roster. `stores.json` retains the original 35-store directory as historical reference; production reads `config.json`.

Wrong response location, missing expected stores and missing SKUs are errors, never out-of-stock results. `runtime/state.json` records per-cycle coverage and per-SKU/store observation times (`coverage_history`); `fresh_coverage_counts` uses a ten-minute freshness window. Official store directory: https://www.apple.com/retail/storelist/ .

The previous “one stock event today” finding covers only the initial 12-store roster; historical availability at the other 23 stores is unknown.

## Run

An independent experimental rotating-proxy runner is available for the local
07094 test. It uses persistent per-exit cooldowns and does not change the standard
monitor below. See [deployment instructions](docs/proxy-monitor-deployment.md).

```sh
python3 -m unittest discover -s tests -v
python3 monitor.py --smoke-test
python3 monitor.py --notify-test
python3 monitor.py --once --dry-run
python3 monitor.py
```

Credentials: export `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, or pass `--env-file /path/to/private.env`. The deployed Mac reuses `/Users/codex/.codex/secrets/market-radar.env`. Secrets are never stored in the repository, raw logs, or Apple requests.

`--smoke-test` checks the selected two Duo variants across every configured region, ten seconds apart, saves diagnostic JSON, never sends inventory alerts, and exits nonzero on failed regional queries or incomplete configured-store coverage. `--once` exits nonzero on failed inventory/notification processing. `--dry-run` never sends Telegram messages. Do not run diagnostic commands in tight loops.

`catalog.json` and `config.json` contain the discovered Duo SKUs and product links verified against Apple's current product page. Production config.json contains only the four monitored 256GB/512GB variants, with `selection.skus` explicitly batching all four. `catalog.json` preserves the full eight-model reference catalog. `--discover` refreshes catalog.json; update config.json deliberately after reviewing changes.

## Mac deployment

The generated launchd plist uses this checkout and its Python interpreter. For another machine, regenerate the absolute paths and set a credentials path before installation.

```sh
./deploy/install.sh
launchctl print gui/$(id -u)/com.trancedu.iphone-duo-monitor
cat runtime/state.json
tail -20 runtime/monitor.log
```

LaunchAgent starts at user login and restarts on crashes. The Mac must remain awake and connected; no checks run while it sleeps or is powered off. Persistent state keeps backoff and notification suppression across restarts.

Stop:

```sh
launchctl bootout gui/$(id -u)/com.trancedu.iphone-duo-monitor
```

Restart:

```sh
launchctl kickstart -k gui/$(id -u)/com.trancedu.iphone-duo-monitor
```

Runtime responses/state/logs are ignored by Git. The application log rotates at 2 MB with three backups.

## Independent health watchdog

`watchdog.py` runs separately and does not import monitor.py, so a syntax error or crash in the stock monitor does not disable health checks. `deploy/install.sh` installs both LaunchAgents. The monitor still restarts automatically via launchd. A completed watchdog run normally appears as not running between minute ticks; inspect `runtime/watchdog-state.json` for its last check.

```sh
cat runtime/watchdog-state.json
launchctl print gui/$(id -u)/com.trancedu.iphone-duo-watchdog
```

The watchdog respects a future retry deadline when detecting hangs. It owns health notifications; the stock monitor sends inventory alerts only. A computer shutdown, sleep, or loss of network prevents immediate Telegram delivery; local monitoring resumes when the computer is awake and connected.

## Faster morning alerts and browser shortcut

`morning_peak` config enables the 07:55–08:15 local-time window at 60 seconds per cycle. This is roughly two regional inventory requests per minute during that window (both SKUs per request). This schedule is an experiment based on one observed 08:14 restock, not a guarantee of a daily release time.

Stock alerts are sent immediately after each regional batch completes, before the second regional request. Each alert includes the exact capacity/color, observation time, pickup date, store and product URL. Positive observations are also appended to `runtime/availability-events.jsonl` so future history does not rely only on overwritten snapshots.

With `auto_open_product_page: true`, a newly sent stock alert also opens the exact product URL in the Mac's default browser, at most once per model per cycle. It does not select a pickup store or advance checkout. Use your regular browser with your Apple login and payment details ready; you complete checkout and confirm payment yourself. Browser-opening failures are logged separately and do not stop stock checks.

## HTTP walkthrough

Open [the six-page Chinese HTTP guide](docs/http-guide/index.html) locally or through a static server. It explains the current regional request URL, a trimmed real JSON response, store rotation, Telegram POST and failure handling. Interactive controls simulate locally and do not query Apple.
