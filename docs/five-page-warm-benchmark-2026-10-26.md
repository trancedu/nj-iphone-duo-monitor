# Five-page prepared-product pool benchmark

User-selected design: four iPhone Duo product tabs (256/512 GB × Star White/Night Sky), each configured with No AppleCare, plus one dedicated bag/checkout work tab. The product pages are not shopping bags. They share the same session/cart and remain protected by the existing single-task lock.

## Runtime behavior

1. Reload the fifth page to check the actual bag. Empty means Add is needed; same target quantity 1 means reuse; recognized old items are automatically cleared only after the previous task has been released.
2. Find the URL-matched prepared product tab, verify URL/title, No AppleCare checked and Add enabled. If stale or missing, deterministically re-prepare that tab; never guess another configuration.
3. Invoke Add exactly once on that product tab. Reload the fifth page directly, without navigating the product tab through Review Bag.
4. Verify that the bag has exactly one item row, exactly one quantity control set to 1, and the exact target link. Unexpected extra items stop before checkout; no automatic Add retry.
5. Continue Apple Pay/pickup/details according to configured mode, always stop before final Continue with Apple Pay.
6. When the user closes the fifth task tab after handoff, keep the old lock during cleanup/re-warm: create its replacement, clear the abandoned/finished bag as authorized, restore all four product tabs, then release and dispatch held work. New requests remain held while this happens. No human-facing AI prompt is part of the runtime.

Prepared tab identity is tagged with a public product URL in window.name, so the same tab can be recovered after Apple's Add confirmation changes its pathname. Other Apple work tabs still cause ambiguity rejection. Whole-browser/CDP loss preserves the task lock.

## Commands

Explicitly release the previous completed task and stop the resident server before manual maintenance. In a private config set `warm_product_pages:true`, then:

```sh
node mac_receiver/shopping.mjs warm-pages --config mac_receiver/receiver.warm.local.json
node mac_receiver/shopping.mjs prepare --config mac_receiver/receiver.warm.local.json \
  --event-id UNIQUE_NEW_ID \
  --url 'https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-star-white-unlocked'
```

warm-pages makes an empty bag and four prepared tabs, without clicking Add. Its setup time is excluded from signal-to-result benchmarking. Do not run during an active human payment handoff. The resident server uses the same option and restores the pool following the task-tab release gesture.

## Live paired result — October 26, 2026

Same target: iPhone Duo 256GB Star White. Same profile and pickup-list stopping boundary. No other scripted browser tests were running during the live pair.

| Stage | Normal empty-bag flow | Five-page warm pool |
|---|---:|---:|
| Reload/check bag | 0.252 s | 0.303 s |
| Prepare product/No AppleCare | 0.744 s | 0.188 s |
| Add and verify target-only bag | 2.281 s | 1.037 s |
| Apple Pay to pickup result | 2.853 s | 2.190 s |
| Total | **6.130 s** | **3.718 s** |

Difference: **2.412 s (39.3%) faster** for this one pair. Timing begins at event creation/acceptance inside the fixed script, not during the preceding four-page setup. Both retained the initial bag reload and strict post-add checks; no skipped validation was needed to obtain the result.

This is one sequential network-dependent comparison, not a guaranteed latency or a statistical estimate. Both runs ended pickup_unavailable with all five displayed stores disabled, so this does not benchmark the in-stock time/contact portion or final payment. No payment was authorized or submitted.

Control ID: duo-five-control-20261026-001. Warm ID: duo-five-warm-20261026-001. Private raw timings: runtime-cdp/five-page-comparison.local.json. Initial four-page preparation proof: runtime-cdp/five-page-setup.local.json (all four No AppleCare true, Add enabled, fifth bag empty).

40 Node/Playwright tests passed, including five-tab preparation with zero Add calls, fifth-tab checkout, reuse of the prepared tab after Add-path changes, pool cleanup/re-warm without creating an orphan sixth Apple tab, and rejection of extra post-add bag items. Contacts remain in ignored local configuration only.
