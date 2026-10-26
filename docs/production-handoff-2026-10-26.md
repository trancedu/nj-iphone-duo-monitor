# Production handoff — 2026-10-26

> Historical record: production has since switched to Safari. See [current Safari production handoff](safari-production-handoff-2026-10-26.md).

Mac receiver is running as LaunchAgent `com.trancedu.apple-pickup-router` from
`~/Library/Application Support/iPhoneDuo/receiver`, independent of this worktree.
The LaunchAgent keeps the Mac awake while the receiver runs. It starts at login;
Chrome CDP instances must already be available. KeepAlive is disabled: startup or
runtime failures require inspection rather than automatic checkout replay.

Four independent Chrome user-data roots and carts are prepared, quantity one,
No AppleCare. Production router has no Pro test aliases:

| Profile | Duo variant | Local CDP port |
| --- | --- | --- |
| A | 256GB Star White | 9223 |
| B | 256GB Night Sky | 9224 |
| C | 512GB Star White | 9225 |
| D | 512GB Night Sky | 9226 |

Verified after service installation: local authenticated health reports live,
all four browsers ready, all slots idle. A real SSH command executed on Mini
successfully reached the authenticated Mac LAN health endpoint. This proves
network/authentication connectivity, not that Mini's monitoring process has yet
enabled forwarding.

The user will enable Mini forwarding locally, as the monitoring user (`codex`):

```sh
python3 /Users/Shared/apple-pickup-bridge-eoeuqsbu/enable_pickup_bridge.py --apply
```

The staged installer preserves the existing monitoring LaunchAgent arguments
and Telegram settings, backs up changed files, verifies Mac health before
changes, and restarts the same monitoring job. Credentials are staged privately
with a codex-specific read ACL; do not paste them into chat or source control.
The installer stops without overwriting if the sender source differs from both
the expected base and the staged version.

The 18:19:59 Telegram notification for 512GB Star White at Fifth Avenue was
manually rechecked at 18:26:32; it was unavailable by then. No corresponding
incoming HTTP inventory event had been observed. C was restored to standby.
Sold-out production attempts now restore their cart and release automatically;
restore failure retains the task lock for inspection.

Runtime uses deterministic Node/Playwright, routes by canonical product URL,
selects the second available time window, fills configured pickup contact
information, and stops before Continue with Apple Pay. It never authorizes
payment or submits an order. Closing a completed task tab restores that profile's
Duo cart and then releases its queue; other profile slots are independent.

## Bounded pickup refreshes

Production now sets `pickup_unavailable_retries: 5` and
`pickup_retry_interval_ms: 1000`. After the initial recognized unavailable
result, the script reloads the current pickup page up to five additional times,
with a one-second pause before each reload. It restores pickup mode and ZIP as
needed and rechecks the requested store. It proceeds immediately when available.
It never repeats Add to Bag or the cart checkout click as part of this loop.
The profile remains locked through retries and restoration; all-unavailable
attempts return to the prepared bag. Unknown DOM, login/captcha and errors after
store/time selection stop for manual inspection without being treated as sold out.
Total retry duration includes Apple's page/network loading, beyond the five
seconds of pauses. Per-attempt start/unavailable/refresh timestamps are recorded.

Verified locally: stock appearing after refresh resumes immediately; five
additional reloads stop after six total checks; ZIP is reapplied; unrecognized
DOM stops immediately; no payment endpoint is reached. Browser tests 18/18 and
related pickup-details/receiver/warm-page tests 20/20 passed. Updated live
LaunchAgent health reports four ready browsers and no active tasks. Actual Apple
reload behavior will be exercised on the next incoming inventory event.
