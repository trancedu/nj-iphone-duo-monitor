# NJ / NY iPhone Duo pickup monitor

Python 3.9+ standard-library monitor for Apple US store pickup. No packages or paid services required.

- Production alerts: iPhone Duo only, connect to a carrier later. Each cycle queries 256GB Star White first, then one randomly selected variant from the other seven color/capacity combinations.
- Alert only when store selection is enabled AND the **pickup** upper date is today through three days ahead in America/New_York. Delivery dates never trigger an alert.
- Regular scans start approximately every 60–70 seconds. Every day from 07:55 inclusive to 08:15 exclusive in America/New_York, scans start approximately every 20–22 seconds. Two sequential regional requests, five seconds apart, remain the maximum per cycle. Each request batches both selected SKUs. Failures always use the longer backoff, including during the morning window. No parallel workers or overlapping scans.
- HTTP errors back off 5, 10, 20, 40, then 60 minutes; honor longer Retry-After. No proxy rotation, CAPTCHA handling, or immediate retry loops.
- Same store/SKU/date notification suppressed for 30 minutes, including across restarts. Failed sends are retried on a later scan.
- An independent launchd watchdog checks health every minute. Process exits/hangs must persist for two minutes; failed queries/notifications for five minutes. It sends one alert per outage and one recovery notice after two healthy checks. New outage alerts are limited to one per hour; failed Telegram attempts retry at most every five minutes. State survives restarts.

## Verified on 2026-10-24

The repository was empty when cloned. The legacy `/shop/fulfillment-messages` API returned HTTP 541. The first replacement, `/shop/sba/pickup-detail`, returned only 12 stores despite 35 requested IDs. That implementation missed observable stores.

The coverage investigation on 2026-10-24 verified all 35 NJ/NY store IDs using `/shop/retail/pickup-message`, with regional ZIP queries and `parts.0` / `parts.1` batching. Production now uses this endpoint. See [the investigation report](docs/coverage-investigation-2026-10-24.md).

Five ZIPs (07078, 10001, 08002, 11755, 13290) cover all 35 watched stores in captured responses. Each cycle queries one rotating primary area and one rotating secondary area. The priority white 256GB model completes a full store sweep in three cycles: about 3–3.5 minutes normally, or 60–66 seconds in the morning window. Each individual store is checked when its region is queried; not all 35 stores are queried every 20 seconds. Random other variants have no fixed revisit interval.

Wrong response location, missing expected stores and missing SKUs are errors, never out-of-stock results. `runtime/state.json` records per-cycle coverage and per-SKU/store observation times (`coverage_history`); `fresh_coverage_counts` uses a ten-minute freshness window. Official store directory: https://www.apple.com/retail/storelist/ .

The previous “one stock event today” finding covers only the initial 12-store roster; historical availability at the other 23 stores is unknown.

## Run

```sh
python3 -m unittest discover -s tests -v
python3 monitor.py --smoke-test
python3 monitor.py --notify-test
python3 monitor.py --once --dry-run
python3 monitor.py
```

Credentials: export `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, or pass `--env-file /path/to/private.env`. The deployed Mac reuses `/Users/codex/.codex/secrets/market-radar.env`. Secrets are never stored in the repository, raw logs, or Apple requests.

`--smoke-test` checks the selected two Duo variants across every configured region, ten seconds apart, saves diagnostic JSON, never sends inventory alerts, and exits nonzero on failed regional queries or incomplete 35-store coverage. `--once` exits nonzero on failed inventory/notification processing. `--dry-run` never sends Telegram messages. Do not run diagnostic commands in tight loops.

`catalog.json` and `config.json` contain the discovered Duo SKUs and product links verified against Apple's current product page. Production config.json lists all eight variants but queries only two per cycle: fixed 256GB Star White plus one random other variant. Random selections are independent, so other variants have no guaranteed revisit interval; they average once per seven cycles. `--discover` refreshes catalog.json; update config.json deliberately after reviewing changes.

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

`morning_peak` config enables the 07:55–08:15 local-time window at 20 seconds per cycle. This is roughly six regional inventory requests per minute during that window (both SKUs per request). This schedule is an experiment based on one observed 08:14 restock, not a guarantee of a daily release time.

Stock alerts are sent immediately after each regional batch completes, before the second regional request. Each alert includes the exact capacity/color, observation time, pickup date, store and product URL. Positive observations are also appended to `runtime/availability-events.jsonl` so future history does not rely only on overwritten snapshots.

With `auto_open_product_page: true`, a newly sent stock alert also opens the exact product URL in the Mac's default browser, at most once per model per cycle. It does not select a pickup store or advance checkout. Use your regular browser with your Apple login and payment details ready; you complete checkout and confirm payment yourself. Browser-opening failures are logged separately and do not stop stock checks.
