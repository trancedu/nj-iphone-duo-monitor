# NJ / NY iPhone Duo pickup monitor

Python 3.9+ standard-library monitor for Apple US store pickup. No packages or paid services required.

- Production alerts: iPhone Duo only, connect to a carrier later. Each cycle queries 256GB Star White first, then one randomly selected variant from the other seven color/capacity combinations.
- Alert only when store selection is enabled AND the **pickup** upper date is today through three days ahead in America/New_York. Delivery dates never trigger an alert.
- One scan starts approximately every 60–70 seconds; two sequential SKU requests, five seconds apart. No parallel workers or overlapping scans.
- HTTP errors back off 5, 10, 20, 40, then 60 minutes; honor longer Retry-After. No proxy rotation, CAPTCHA handling, or immediate retry loops.
- Same store/SKU/date notification suppressed for 30 minutes, including across restarts. Failed sends are retried on a later scan.
- An independent launchd watchdog checks health every minute. Process exits/hangs must persist for two minutes; failed queries/notifications for five minutes. It sends one alert per outage and one recovery notice after two healthy checks. New outage alerts are limited to one per hour; failed Telegram attempts retry at most every five minutes. State survives restarts.

## Verified on 2026-10-24

The repository was empty when cloned. The legacy `/shop/fulfillment-messages` API returned HTTP 541 (and once 503). The replacement is the `/shop/sba/pickup-detail` endpoint published in Apple's own product-page JavaScript. It returns explicit store availability and `pickupEncodedUpperDateString`.

Official store directory: https://www.apple.com/retail/storelist/

`stores.json` lists 12 NJ and 23 NY stores. All 35 IDs are requested per SKU, but **Apple currently returns only 12 stores: American Dream (NJ) and 11 NY stores**. The other 23 stores are **unknown, not sold out**. Returned and unreported IDs are tracked per SKU in `runtime/state.json`. This limitation must not be represented as full coverage of both states.

NJ and NY smoke tests for iPhone 18 Pro Max and Duo returned valid responses. Duo currently reports “Check back for availability on 10.24”; this is not an available pickup slot. Stock changes quickly.

## Run

```sh
python3 -m unittest discover -s tests -v
python3 monitor.py --smoke-test
python3 monitor.py --notify-test
python3 monitor.py --once --dry-run
python3 monitor.py
```

Credentials: export `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, or pass `--env-file /path/to/private.env`. The deployed Mac reuses `/Users/codex/.codex/secrets/market-radar.env`. Secrets are never stored in the repository, raw logs, or Apple requests.

`--smoke-test` checks one Pro Max and one Duo against both states, saves diagnostic JSON, never sends inventory alerts, and exits nonzero on failed regional queries. `--once` exits nonzero on failed inventory/notification processing. `--dry-run` never sends Telegram messages. Do not run diagnostic commands in tight loops.

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
