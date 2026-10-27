# Manual inventory provider selection

Current user instruction (2026-10-27): **Clash subscription pool while away; paid DataImpulse only when the user explicitly asks. No automatic time-of-day, peak-period or absence/presence switching.** Neither provider selection nor the environment variable creates a schedule.

`deploy/proxy_service.py start-live` chooses a provider in this order:

1. Explicit `--provider clash` / `--provider dataimpulse`.
2. Shell environment `IPHONE_MONITOR_PROVIDER=clash` / `dataimpulse`.
3. Remembered selection in `runtime/proxy-monitor/live-provider.json`.
4. Existing LaunchAgent inspection, then Clash as the initial default.

The selected value is also included in the service's LaunchAgent environment. Editing a shell variable does not change an already-running process: explicitly run the start command to switch. The existing shared process lock prevents running the two inventory backends simultaneously.

## Switch manually

```sh
cd /Users/codex/workspace/nj-iphone-duo-monitor
IPHONE_MONITOR_PROVIDER=clash python3 deploy/proxy_service.py start-live \
  --env-file /Users/codex/.codex/secrets/market-radar.env
```

Clash mode merges the cached subscription profiles, verifies exit connectivity and deduplicates measured IPs before polling. It retains ZIP 07094, 12 stores and all four monitored variants, target spacing 2s, four workers, at least 60s between requests on each measured IP, and existing error cooldowns. Warmup can take a few minutes if subscription nodes are slow/unreachable. Actual successful refresh gaps depend on available exits and failures, and are not guaranteed to be 2s. Existing subscriptions may themselves have a subscription cost, but this mode makes no DataImpulse inventory requests.

Every service-managed Clash invocation includes **`--disable-paid-fallback`**. This ignores any old `DATAIMPULSE_FALLBACK_CONFIG` entry in the private notification environment file, so a stale hybrid configuration cannot silently resume paid requests.

Only after an explicit user request to return to paid mode:

```sh
IPHONE_MONITOR_PROVIDER=dataimpulse python3 deploy/proxy_service.py start-live \
  --env-file /Users/codex/.codex/secrets/market-radar.env \
  --proxy-env-file /Users/codex/.codex/secrets/dataimpulse.env
```

The paid mode's existing one-second target/four-worker configuration is retained. The Mini's Telegram, Mac event forwarding, separate local speech service and dashboard remain enabled through either switch. Switching does not reset or modify the Mac's current browser task.

## Verification

Inspect `runtime/proxy-monitor/live-provider.json` and the LaunchAgent program arguments. In Clash mode `current.json` should show the new process and exit pool, no active `dataimpulse` fallback configuration, and successful queries after node warmup. In DataImpulse mode the backend is `dataimpulse_only`.

Tests cover environment/CLI precedence, persistence and mandatory no-paid-fallback arguments, plus ignoring an old paid fallback environment entry. No scheduling or automated mode switch is added.
