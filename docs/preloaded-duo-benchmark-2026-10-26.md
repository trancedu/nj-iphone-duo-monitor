# Four-variant Duo bag benchmark — 2026-10-26

Target: iPhone Duo 256GB Star White. Same installed Chrome Stable, same dedicated CDP profile, same store-list stopping boundary. This is one sequential live paired comparison, not a statistically controlled latency guarantee. Product/site cache and network load can vary between runs.

## Method

1. Suspended the resident receiver, verified its current task was completed as pickup_unavailable with no pending event, and explicitly released that old test task.
2. Removed the old Silver Pro Max before the control timer; verified an empty bag.
3. Ran the normal deterministic prepare script from the empty bag to pickup_unavailable.
4. Released that completed control test. Kept its target Duo and preloaded the other three configured Duo variants, with No AppleCare on each. Verified four distinct variants, quantities exactly [1,1,1,1]. This setup was excluded from benchmark timing.
5. Ran the preloaded strategy: validate four rows, retain the exact target, remove the three unrelated variants once each, verify target quantity 1, then use the same checkout/pickup code.

The first trim calibration stopped because Apple detached a Remove button before the asynchronous item removal finished. No repeat destructive click was attempted. Fixed the wait to require the matching product row and final row count to update, replenished the removed variant, verified all four again, then ran the valid timed trim. Calibration and replenishment are excluded from the result below.

## Result

| Stage | Empty bag + Add | Preload four + delete three |
|---|---:|---:|
| Event to verified target-only bag | 2.468 s | 3.215 s |
| Verified bag to pickup result | 2.970 s | 2.803 s |
| Total | **5.438 s** | **6.018 s** |

Preloaded strategy was **0.580 s slower (10.7%)** in this pair, excluding all preload setup. Its three serial item deletions took 0.855, 0.856 and 0.856 seconds (2.567 seconds combined). The warmed normal product-page/Add/Review segment took 2.232 seconds after the initial bag inspection. Thus removing three items cost more than the work skipped in this particular run.

Both runs ended with five displayed stores unavailable, zero selected stores, and pickup_unavailable. Time selection/contact/payment were not executed. The result is only latency to the same unavailable pickup-list boundary, not to payment-ready for in-stock inventory.

## Artifacts and state

- Standard test event: duo-ab-empty-20261026-001.
- Valid preloaded test event: duo-ab-preloaded-20261026-002.
- Raw stage comparison is private runtime-cdp/duo-preload-comparison.local.json.
- Preload preparation proof is private runtime-cdp/preload-verified.local.json.
- Implementation: mac_receiver/preload_duo.mjs, mac_receiver/variant_bag.mjs; opt in with bag_strategy="preloaded_duo" in a private experiment config.
- Default receiver config was not switched to the experimental strategy. Current bag retains exactly one target Duo; the successful test task remains locked for user inspection. Four-variant state must be replenished between experiments, outside any human payment handoff.
