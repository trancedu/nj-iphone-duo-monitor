# Four-profile iPhone 18 Pro end-to-end checkout preparation

## User correction and scope

Prepared four independent Chrome user-data profiles A–D, replacing their test-only Duo bags as authorized. The user corrected the third URL to **512GB Burgundy**, so all four final URLs are unique:

| Profile | Test product | Final test pickup store |
|---|---|---|
| A | iPhone 18 Pro 256GB Burgundy | Apple West 14th Street |
| B | iPhone 18 Pro 256GB Glacier | Apple SoHo |
| C | iPhone 18 Pro 512GB Burgundy | Apple West 14th Street |
| D | iPhone 18 Pro 512GB Glacier | Apple Staten Island, available tomorrow |

All four were preseeded with exactly the corresponding single item, quantity 1, No AppleCare. Preparation and clearing were excluded from timings. The tests were sequential, not a simultaneous four-profile wall-clock benchmark. No headless test suite ran during the timed browser rounds.

## Actual URL router

New authenticated profile_router.mjs replaces the old single-profile listener on 192.168.31.35:8765 plus loopback. It uses the existing private bearer secret, source allowlist and loopback-only reset endpoint. It selects a profile by exact configured URL and keeps independent durable task locks/hold queues per profile. An event ID cannot move to a different profile by changing its URL. Unknown URLs are rejected, not sent to an arbitrary bag. Duplicate aliases, if ever configured, use the first configured slot; the corrected current four aliases are unique.

Primary production assignments remain the four Duo URLs; the user-provided Pro test URLs are explicit aliases on A–D. After the user closes a completed test handoff tab, that slot re-seeds its primary Duo outside the critical path before releasing held work. No existing handoff is overwritten by an incoming event. Main listener now owns the four per-profile state locks; manual CLI maintenance must stop it first.

Notifications name Profile A/B/C/D plus the exact product, and bring that profile's page to the foreground. Final Continue with Apple Pay is never clicked.

## Successful-run timing

| Profile | Bag check | Apple Pay/store/time | Contact-page navigation | Fill/verify/handoff | Total |
|---|---:|---:|---:|---:|---:|
| A | 0.590 s | 2.233 s | 10.428 s | 0.077 s | **13.328 s** |
| B | 0.654 s | 13.569 s | 9.965 s | 0.110 s | **24.298 s** |
| C | 0.469 s | 2.648 s | 10.448 s | 0.085 s | **13.650 s** |
| D | 0.584 s | 12.784 s | 9.947 s | 0.073 s | **23.388 s** |

Mean 18.666 seconds. Actual fill-only intervals were 58/91/70/55 ms. No Add or removal occurred during any successful timed round. The long intervals are observed page/store transitions and readiness waits, not AI deliberation or fixed sleep. These full contact-page timings must not be compared directly with the earlier 2.454-second Duo test that stopped at an unavailable store list.

Timings above are final successful rounds only; setup and failed calibration/retry time are excluded. A and C passed on the initial round. B initially stopped on the fixed preferred store being unavailable; D initially stopped because its store was beyond the first five. B/D retries exposed native radio inputs covered by Apple's associated labels. Fixed exact event-store selection, bounded Show more stores expansion, label clicks with checked-state verification (no force), and conditional wait for date controls. Then B/D were rerun from the bag through the full form. No repeat Add or final payment action was used to recover.

## Verification and current state

Read-only final verification found all four pickup-info headings visible, all four expected contact fields matched in each profile, and final co-options-applePay buttons enabled. All four remain awaiting_user and locked, with Chrome open. No Continue with Apple Pay, wallet authorization, agreement acceptance or order submission occurred.

43 Node tests passed before the final native-label fix; all 6 targeted pickup-details tests passed including the new covered-radio regression (44 distinct tests covered). Native tests and syntax/whitespace checks passed. Private contact values remain only in ignored local configs and the user-requested local form screenshots, not in source or this report.

Private evidence:
- runtime-cdp/pro-test-profiles.local.json — corrected four aliases and preseed manifest
- runtime-cdp/pro-router-checkout-results.local.json — initial rounds
- runtime-cdp/pro-router-checkout-retries.local.json — intermediate failed retries
- runtime-cdp/pro-router-checkout-final-retries.local.json — successful B/D reruns
- runtime-cdp/pro-router-timing-summary.local.json — successful round comparison
- runtime-cdp/pro-router-final-verification.local.json — four final form checks

Run resident router from the repository root:

```sh
node --env-file=mac_receiver/.env mac_receiver/profile_router.mjs --config mac_receiver/receiver.router.local.json
```

This is a running foreground command-session service, not an installed login LaunchAgent. Mini stock-monitor hook activation/configuration was not changed by this test. The previous five-tab shopping window remains open, but its old HTTP listener was stopped; new signals reach the four-profile router.
