# Safari production handoff — 2026-10-26

The user authorized Safari production activation. The existing authenticated
receiver at `192.168.31.35:8765/prepare` now routes to Safari. Mini's endpoint,
shared secret, allowlist and event format are unchanged. There is one production
LaunchAgent (`com.trancedu.apple-pickup-router`); it now runs the stable bundle
`~/Library/Application Support/iPhoneDuo/receiver-safari`. Chrome's production
receiver was stopped; its windows and the old stable bundle were preserved.
The temporary Safari preflight LaunchAgent was removed from automatic login.

Authenticated health reports `browser_backend: safari`, `mode: live`, all four
profiles ready, and no active/pending requests at final verification.

| Slot | Safari profile | Product |
| --- | --- | --- |
| A | Duo256White | Duo 256GB Star White |
| B | Duo256Black | Duo 256GB Night Sky |
| C | Duo512White | Duo 512GB Star White |
| D | Duo512Black | Duo 512GB Night Sky |

Each profile has one work window with one tab and a verified quantity-one cart.
Bindings are discovered by profile name, then pinned to the window ID; missing,
ambiguous or multi-tab windows are never replaced by an arbitrary window.
The unrelated Pro testing profile is not a production route.

## Runtime behavior

The existing fixed HTTP server, authentication, event deduplication, durable
per-profile locks and held queue are reused. Previous event histories were copied
from the stopped Chrome receiver, so the cutover does not replay old event IDs.
An event's store name overrides the configured fallback store; production never
uses the experimental any-available-store option.

Safari executes the deterministic shared workflow with no AI. It verifies the
bag, enters Apple Pay checkout/pickup, and checks the requested store. After a
recognized unavailable state it refreshes at most five additional times, with a
one-second pause and another stock check before each refresh. A store becoming
available stops refreshes immediately. A visible fieldset alone is insufficient:
store radio rows must finish rendering before inventory is evaluated. Unknown
markup or prolonged loading stops for inspection, preserving the task lock.

Available stock continues to the second available time window and configured
pickup contact fields. It stops with Continue with Apple Pay ready and untouched.
No final terms acceptance, wallet authorization or order submission is automated.
The selected Safari window is brought forward, a distinct system sound plays,
and a notification identifies its profile and outcome. Feedback success/failure
is recorded separately; notification delivery does not change checkout outcome.

A sold-out task is sounded/notified, restored to its prepared quantity-one bag,
and then released. Restoration failure retains the lock. A handoff stays locked;
new events for that profile are held, while other profiles can execute separately.
If an idle profile window is absent, incoming events can be held until it reopens
(subject to the configured event TTL).

## Completing a handoff

Safari cannot create an arbitrary named profile window through its normal
AppleScript API. If you close the sole checkout window, reopen that same profile
from Safari. Once the replacement window is present, the receiver restores its
cart and releases its queue. A loss of all known windows/Safari quit is treated as
a disconnect and never automatically releases active tasks.

Alternatively, after actually completing/abandoning the task, explicitly reset
its event ID through the existing local-only endpoint:

```sh
python3 bridge_client.py reset \
  --env-file "$HOME/Library/Application Support/iPhoneDuo/receiver-safari/.env" \
  --endpoint http://127.0.0.1:8765 \
  --event-id EVENT_ID --confirm-reset
```

Safari reset waits for the correct cart to be restored before releasing the lock.
If Safari was quit, reopen the corresponding profile before resetting. Do not run
the standalone test CLI against a production Duo profile concurrently. LaunchAgent
startup expects Safari's configured profile windows to be available; if they were
not open at login, open them and then restart the receiver job with `launchctl
kickstart gui/$(id -u)/com.trancedu.apple-pickup-router`.

## Actual Mini-to-Mac simulation

A simulated Duo 512GB Night Sky / Grand Central event was sent by Python running
on Mini over the real LAN HTTP route, using the existing authentication key.
The first attempt exposed a partially rendered store list during refresh. It
stopped with `manual_review`, played sound/notified, and retained its lock. We
added bounded store-row readiness checks, passed regression tests, restored the
cart via the local reset endpoint, and sent a fresh event ID for the retest.

Final event: `prod-safari-sim-512black-recheck-1793058461760754000`.

| Measurement | Seconds |
| --- | ---: |
| Mini HTTP acceptance round trip, including profile readiness | 0.373 |
| Mac receipt to completed six unavailable checks | 12.723 |
| Mac receipt to sound/notification completion | 14.933 |
| Mac receipt to restored cart and released task lock | 16.102 |
| Mini detection timestamp to unavailable result | 13.127 |

The final outcome was `pickup_unavailable`; no final payment stage was reached.
`Duo512Black` returned to `/shop/bag` with the matching device, quantity one.
System sound playback and notification submission both succeeded. The duplicate
original event remains recorded rather than being replayed.

Final focused suite: **48 tests passed**, including existing HTTP authentication,
queue/restart/dedup behavior, Safari event-store routing, missing/ambiguous windows,
close/reopen behavior, restore-before-release, failed restore lock retention,
stock appearing during retry pause, partial store rendering, contact and payment
boundaries, plus independent feedback channel failures. Browser DOM fixtures are
local headless Chrome tests; real Safari/LAN checks are separately reported above.

Private evidence: `mac_receiver/runtime-cdp/safari-production-simulation.local.json`
and `safari-cutover.local.json`. Rollback plist/config are preserved under
`~/Library/Application Support/iPhoneDuo/deployment-backups/safari-1793058281513134000`.
Rollback must preserve any newer Safari event histories and active tasks; do not
blindly reactivate stale Chrome state or replay requests.
