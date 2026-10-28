# NJ / NY iPhone Duo pickup monitor

> 最新仓库执行规则：只做最先到的一条。忙时后续事件终态busy直接丢弃，不排队、不补跑；有货页面继续保护。见[执行策略](docs/pickup-execution-policy.md)。Mac运行版本需在上线后核验。

Repository receiver policy (2026-10-27): Safari/Chrome share a first-arrival global lock.
`drop_busy_events` defaults to true in exclusive mode. Busy events are durably rejected,
including retries after unlock; only new arrivals after release may start. Stock-found
pages stay protected until the user finishes or abandons them. The old ten-second
candidate fallback is opt-in compatibility behavior, not the user's current policy.
See the [strict first-only opportunity replay](docs/opportunity-first-only-2026-10-27.md).

Python 3.9+ standard-library monitor for Apple US store pickup.

## Split pickup response (Mac mini → Mac)

See the [current end-to-end flow and Mini–Mac HTTP protocol](docs/current-pickup-flow.md) for polling, Telegram, authenticated LAN delivery, retries, status queries and deduplication. The Mac receiver routes products to independent Safari Profiles; the user confirmed1TB frontend readiness on2026-10-28, and Mini forwarding now includes all six monitored variants; its configured workflow prepares pickup details and stops before final Apple Pay authorization. The original [split deployment guide](docs/split-pickup-deployment.md) documents the initial Chrome/dry-run setup. LAN forwarding is opt-in; existing Telegram stock alerts remain independent.

The optional [DataImpulse smoke test](docs/dataimpulse-smoke.md) checks credentials, country targeting and one inventory response with bounded traffic. It does not enable DataImpulse production polling.

The [bounded hybrid fallback](docs/hybrid-dataimpulse.md) can use DataImpulse only when successful inventory refreshes are stale. It shares existing notifications and has absolute expiry and paid-request/body budgets; it is disabled unless configured.

See the [2s / 1.5s / 1s DataImpulse cadence comparison](docs/dataimpulse-cadence-2026-10-27.md) for the finite isolated experiment and its response-time, gap and traffic tradeoffs.

The [bounded concurrency tradeoff review](docs/concurrency-tradeoff-2026-10-27.md) evaluates two different configurations preparing in parallel with one manual handoff. It is an analysis proposal; strict first-arrival execution remains selected.

For a timing budget and limitations of the pickup-page standby path versus manual iPhone checkout, see the [frontend latency review](docs/frontend-latency-review-2026-10-27.md). The estimates are not current-path benchmark results.

## Mac mini voice alerts

The [independent local speaker](docs/local-stock-audio.md) announces fresh arrivals as “二五六黑” / “五一二白” through Mac mini Speakers. A background worker coalesces repeats without blocking inventory polling or changing Telegram/Mac forwarding.

## Private dashboard

The [read-only stock dashboard](docs/dashboard.md) shows live store/configuration status, independent availability segments that always end on recorded unavailability, estimated duration ranges bounded by positive observations and surrounding successful negative queries, and request health. Open http://100.83.108.82:8890/iphone-duo-dashboard/ from the same Tailscale network. Its independent observer does not add Apple requests or change the monitor.

## Current stock monitoring

**Current Mini mode (2026-10-28): Clash subscription pool; DataImpulse remains stopped.** ZIP07094/12 stores, target dispatch every2 seconds, four workers, and a minimum60-second measured-IP interval are unchanged. Each request now batches **six** variants: 256GB/512GB/1TB × Star White/Night Sky; 2TB is excluded. Provider selection remains manual via `IPHONE_MONITOR_PROVIDER` / `--provider`, with paid fallback disabled in service-managed Clash mode. See [manual switching](docs/manual-monitor-provider.md) and the [1TB batch comparison/deployment](docs/one-tb-monitoring-2026-10-28.md).

Telegram, Mini speech and Mac forwarding cover all six variants. The user confirmed the1TB frontend is configured; `mac_forward_skus` now includes both1TB SKUs as well as the original four.

The earlier [DataImpulse-only deployment](docs/dataimpulse-live.md) is a retained alternative, not the currently selected source.

- Production alerts: iPhone Duo only, connect to a carrier later.
- Alert only when store selection is enabled AND the **pickup** upper date is today through three days ahead in America/New_York. Delivery dates never trigger an alert.
- Historical direct-monitor schedule (inactive in current Clash deployment): regular scans start approximately every180–190 seconds. Every day from 07:55 inclusive to 08:15 exclusive in America/New_York, scans start approximately every 60–70 seconds. Two sequential regional requests, five seconds apart, remain the maximum per cycle. Each request batches both selected SKUs. Failures always use the longer backoff, including during the morning window. No parallel workers or overlapping scans.
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
