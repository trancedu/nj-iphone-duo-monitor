# Chrome production: first arrival with 60-second unlock

> 当前规则已更新：最多额外刷新2次；明确无货回袋后提前解锁；优先新请求，否则补跑10秒内最新候选；有货页面永不自动回袋/解锁。详见[最新执行策略](pickup-execution-policy.md)。下文旧策略描述保留为历史记录。

Status update (2026-10-27): the single production receiver has switched back to
Safari under the shared policy. Chrome windows and configuration remain as a
standby. The Chrome cutover details below describe the earlier deployment.

The shared operator policy for both browsers is documented in
[自提执行策略：首条独占，60秒后释放](pickup-execution-policy.md).

The active Mac LaunchAgent `com.trancedu.apple-pickup-router` now runs the
`receiver-chrome` bundle under `~/Library/Application Support/iPhoneDuo/`.
The Mini endpoint, allowed sources, and shared secret are unchanged.

Four independent Chrome user-data roots use CDP ports 9223–9226 for A=256 White,
B=256 Night Sky, C=512 White, and D=512 Night Sky. Existing matching quantity-one
carts were reused; no additional phones were added.

`single_active_request: true` reserves a persistent global lock before browser
readiness checks. Only the first new accepted event can execute. Other new events
receive `409 busy` with `global_manual_unlock_required`; they are not queued or
replayed after completion. Duplicate already-recorded events return their prior
result without repeating browser operations. The global lock survives restarts,
retaining its original trigger time. It now expires 60 seconds after the first
trigger, including sold-out results, manual-review errors and handoff. This is
an absolute deadline, not an idle timer: typing or clicking does not extend it.
A one-second metadata timer starts a separate cleanup process at expiry. That
process first stops the controller, then returns only the expired profile to
Bag, clears its task/global lock, and resumes reception. Old rejected events are
never replayed. Cleanup/navigation take additional time after the 60-second
trigger. If Bag restoration fails, the old task is still stopped and unlocked;
the failure is recorded for inspection. Other profiles are not navigated by
automatic cleanup. Manual unlock still restores all four carts.

In this mode each Engine disables hold queues, unavailable auto-release,
tab-close release, handoff idle return, and idle bag refresh. The selected first
page retains its configured maximum three additional pickup refreshes (four
checks including the initial check). If the requested store is not visible,
Chrome expands a single Show more stores button or link, waits for that exact
store, and never substitutes the first listed store. No other
profile starts checkout or reloads in response to later events. Payment remains
manual, with the existing boundary before the final Apple Pay button.

Double-click `clear-chrome-locks.command` (or `clear-locks.command`) to stop the
receiver, cancel unfinished/held work, return all four dedicated profiles to Bag
sequentially, verify each matching quantity-one cart, release per-profile and
global locks, then restart the receiver. The helper reads the active LaunchAgent
configuration, so it supports the current Chrome or former Safari deployment.
It does not add products or pay. A failed cart restore retains the global gate
and the affected profile lock. State snapshots are backed up privately.

## Validation

- 31 focused Node tests passed: global exclusion, a slow first browser readiness
  check, duplicate safety, persistence across router restart, explicit release,
  rejected-first admission, and four concurrent HTTP requests admitting only one,
  plus existing receiver/Safari adapter checks.
- Initial separate live Chrome checks: A/B/D reached pickup and found American
  Dream unavailable. C encountered an actual HTTP 500 checkout navigation; it
  later passed a single-profile recheck with HTTP 200 and unavailable pickup.
  These tests used zero extra refreshes and do not prove Apple Pay authorization.
- Before cutover all four Chrome carts were verified sequentially. Authenticated
  production health reported Chrome/live, four ready profiles, the first-arrival
  execution policy, and no global or profile locks/pending events.

This change removes simultaneous browser preparation as a possible contributor;
it does not establish that concurrency caused the earlier Apple errors.
