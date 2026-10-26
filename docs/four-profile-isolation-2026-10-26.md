# Four independent Chrome profiles: live cart-isolation test

## Scope and identity

Created four fresh **Chrome Stable processes with four independent user-data directories**, not four tabs/windows in one profile and not merely four transient incognito contexts. Each process has its own Default profile, localhost-only CDP endpoint and browser storage root. No Apple account login or cookies were copied from the existing shopping browser.

| Profile | Assigned product | Local CDP port |
|---|---|---:|
| A | iPhone Duo 256GB Star White | 9223 |
| B | iPhone Duo 256GB Night Sky | 9224 |
| C | iPhone Duo 512GB Star White | 9225 |
| D | iPhone Duo 512GB Night Sky | 9226 |

Actual directory/PID manifest is private mac_receiver/runtime-cdp/four-profiles.local.json. Each root is a distinct fresh directory beneath ~/.apple-shopping-profiles/. lsof confirmed each port bound to 127.0.0.1, with four distinct Chrome PIDs.

## Experiment

All four were freshly navigated to the live Apple bag and verified empty. Then added exactly one assigned item at a time, selecting No AppleCare and verifying quantity 1. After each addition, freshly loaded **all four** bag pages to avoid relying on stale tab content.

| After operation | A | B | C | D |
|---|---:|---:|---:|---:|
| Initial state | 0 | 0 | 0 | 0 |
| Add A product in A | 1 | 0 | 0 | 0 |
| Add B product in B | 1 | 1 | 0 | 0 |
| Add C product in C | 1 | 1 | 1 | 0 |
| Add D product in D | 1 | 1 | 1 | 1 |

Every occupied bag held only that profile's assigned exact configuration, quantity 1. No cross-profile cart contamination was observed in any of the four sequential rounds. After A entered checkout, B/C/D were freshly checked again and still held exactly their own single assigned item.

Conclusion: these four **logged-out** independent profiles had independent Apple bags in this live test. The result does not establish persistence forever or independence after future account/session changes. The existing single-profile five-tab pool and daily Chrome were not cleared or closed.

## Preseeded checkout timing

Preloading all four profiles was excluded from timing. Ran the existing deterministic prepare script on A, with warm-product pages disabled and automatic bag clearing disabled. It reloaded and verified the existing single target, skipped Add entirely, and entered Apple Pay/pickup.

| Stage | Time |
|---|---:|
| Event to verified target-only bag | 0.477 s |
| Verified bag to pickup result | 1.977 s |
| Total | **2.454 s** |

Event: profile-A-preseeded-20261026-001. Result: pickup_unavailable, five visible stores disabled. No Add/removal/time/contact/final payment occurred during this timed run. Previous five-tab test was 3.718 s; this run was 1.264 s shorter, but those are sequential measurements on different sessions with potentially different cached state/location and network behavior, not a controlled guarantee.

## Current state and scripts

- Four test Chrome instances remain open; A is at the unavailable pickup list, B/C/D at their separate one-item bags.
- Per-profile private configurations: mac_receiver/receiver.profile-A.local.json through D. State directories: runtime-profiles/A through D.
- Original resident receiver remains on its prior five-page profile. **No automatic URL-to-four-profile production router was enabled by this experiment.**
- Launcher: node mac_receiver/start_four_profiles.mjs (creates fresh directories; occupied ports are rejected).
- Isolation experiment: node mac_receiver/profile_isolation.mjs (expects fresh empty profiles, refuses to silently clear existing bags).
- Private live evidence: runtime-cdp/profile-isolation-result.local.json; timing: runtime-cdp/four-profiles-timing.local.json.

For future production routing, map the four exact canonical URLs to A/B/C/D and keep an independent task lock per slot. Recheck exact item/quantity before checkout; after the user completes or abandons a slot, replenish only that slot outside the signal's critical path. Preseeding the bag is a preparation optimization; the test did not verify perpetual retention or stock reservation.
