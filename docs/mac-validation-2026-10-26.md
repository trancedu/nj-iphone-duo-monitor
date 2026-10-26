# Mac validation — 2026-10-26

Tested commit: `95cbb27f68385333aa581e57dbaff3a3f30c464d` in an isolated worktree. Original checkout has pre-existing uncommitted changes, so fast-forward was blocked and those changes were preserved.

## Automated and local HTTP checks

- Node 24.15.0; npm ci completed with zero reported vulnerabilities.
- Node / Playwright: 12 passed.
- Python: 41 run, 40 passed and 1 skipped (commissioning captures absent).
- Loopback-only dry-run: health OK; prepare queued then dry_run_completed; resending the identical event returned original timestamps; incorrect secret returned HTTP 401.
- Local event: detected-to-received 84 ms; detected-to-finished 85 ms. These are local dry-run measurements, not LAN or browser timings.
- Dedicated persistent Chrome initially launched and health reported browser_ready true. Later health reported false; dedicated Chrome wallet/login/checkout are not verified.
- Temporary receiver stopped after validation. Local config remains dry_run true and selectors_verified false. No LaunchAgent installed and no Mini forwarding enabled.

## Existing daily Chrome: manual page-flow validation

Reused the user's existing one-item bag: iPhone Duo 256GB Star White, quantity 1. No add/remove operation was performed. Clicked the explicitly identified navigation Apple Pay button, selected I’ll pick it up, then supplied ZIP 07094 after the user confirmed it.

The five displayed stores (American Dream, West 14th Street, Upper West Side, Fifth Avenue, Grand Central) all showed Currently unavailable and disabled radio controls. Stopped on this list without selecting a store or time or clicking Continue/Pay. No wallet authorization or order submission was performed. This demonstrates navigation in the existing daily Chrome only, not an end-to-end receiver run or wallet readiness.

## Observed adaptation gaps

- Bag item wrapper uses data-autom="bag-item-1", unlike the example exact bag-item selector.
- Actual accessible Apple Pay label is Check out with Pay; the current browser.mjs regex does not include the Apple logo character.
- There are two visible Apple Pay buttons with IDs shoppingCart.actions.navApwCheckout and shoppingCart.actions.apwCheckout. A verified unique semantic scope is needed; do not use an arbitrary first match.
- ZIP was initially empty; selecting pickup alone did not show a store list. Current code has no ZIP completion stage, so this state needs manual handoff.
- Store structure selectors were not verified in the dedicated profile. Keep selectors_verified false.
- Mini-to-Mac LAN, persistent service installation, dedicated Chrome login/wallet, product add path and end-to-end live event remain unverified.

No application source or remote branch was modified during this test.

## Follow-up: actual Mac Mini to Mac LAN communication

At 2026-10-26 16:23:56 America/New_York, authenticated to the existing MacMini SSH alias and executed a temporary Python HTTP client there. The shared receiver secret was sent only over SSH stdin, not printed or saved to a remote file. No monitoring configuration, Telegram delivery, or agent chat was changed.

Confirmed the actual TCP source/target with getsockname/getpeername: 192.168.31.173 → 192.168.31.35:8765. Hostname DNS resolution was not used as source-IP evidence.

- Health HTTP 200, mode dry_run.
- Event lan-mini-854e2aa02573 accepted with HTTP 202 queued.
- Status became dry_run_completed, independently confirmed on the receiving Mac.
- Identical duplicate returned HTTP 200 with exactly the original status/timestamps.
- Incorrect secret returned HTTP 401.
- Measured HTTP round trips: 38–49 ms. Cross-host timestamp difference: 67 ms to receive, 70 ms to finish; subject to host clock alignment.

Receiver is now left running temporarily in this chat's command session, bound to 192.168.31.35 and loopback on port 8765, allowing only Mini 192.168.31.173 and loopback. dry_run true, prewarm_browser false, selectors_verified false. No browser was opened or changed by this communication test. No LaunchAgent installed. Mini live forwarding remains disabled. A receipt in this HTTP service does not automatically wake the AI chat.

## Follow-up: James and CDP scripts

User changed the selected profile from trancedu2 to James. Confirmed the visible Chrome window and extension browser both identify James. Current Chrome Stable main process has no remote debugging switch, and 127.0.0.1:9222 has no listener. Local State identifies James as Profile 6 under the default Chrome data root. No profile contents, cookies or credentials were copied, and no daily Chrome restart was performed.

Added optional CDP connection support, standalone shopping CLI, dedicated Chrome launch script, a separate preview-by-default clear-bag module, CDP config example and deployment instructions. Updated Apple Pay logo/duplicate navigation button handling and explicit pickup ZIP support. Cleanup is not exposed by the LAN API and is never called by preparePickup.

Ran the actual clearBag function in James through an adapter to the existing browser connection: clear_preview, items 1, removed 0. Ran preparePickup against the existing same-one iPhone Duo: bag validation and Apple Pay navigation succeeded; existing-connection adapter initially read native checked rather than aria-checked (corrected in adapter), then its Processing condition wait reached the connector deadline. Subsequent read confirmed pickup selected, ZIP 07094, five disabled stores and zero selected stores. This is not evidence that the standalone CDP CLI ran end to end on James. No store/time/Continue/Pay/order submission, new add, or real removal was performed.

Standalone shopping.mjs check against 9222 returned stopped/cdp_not_listening. A separate automated integration test launched temporary installed Chrome Stable with an independent profile and real loopback CDP, executed the standalone CLI successfully, and confirmed Chrome stayed open after CLI exit. This test made no Apple requests.

Final verification: 19 Node/Playwright tests passed; Python 41 run, 40 passed and 1 skipped. Shell and Node syntax and git diff whitespace checks passed. The original LAN receiver remains dry-run; Mini live forwarding was not enabled. Files are local worktree changes, not pushed.

## Real CDP live execution after user supplied Duo URL

User explicitly requested execution without login using the Duo 256GB Star White URL. Dedicated stable Chrome on loopback CDP had an empty bag. Live commissioning selected No AppleCare, added exactly once, verified one matching row and quantity control, and entered Apple Pay. Initial store-list CSS used legend:text-is but the real legend wraps a heading; it timed out and preserved manual_review lock. Inspected actual DOM, changed selector to legend:has-text, independently checked all five store radios were covered and disabled, and explicitly reset the inspected failed event before a fresh test.

Then executed the standalone shopping.mjs prepare command, event duo-cdp-verified-20261026-001. It reused the same one item, did not add again, and completed as pickup_unavailable. Detected 20:45:28.373Z, bag-ready 20:45:29.018Z (645 ms), Apple Pay 20:45:29.084Z (711 ms), finished 20:45:31.654Z (3281 ms). Observed pickup selected, five disabled store radios, zero selected stores; no Continue/Pay or order submission. Chrome remains open, bag contains one item, and manual lock is retained. Local CDP selectors_verified is now true following actual coverage verification. LAN listener is separately still dry_run, browser_ready false; this does not mean the independent CDP browser is unavailable.

Final Node test count is 20 passed, including a regression fixture with a heading nested inside the legend. Mini production config could not be read through the existing trancemini SSH account due to filesystem permissions; no production forwarding was enabled or modified in this session.

## User-authorized Pickup Details extension and full rerun

User explicitly authorized choosing a later pickup time, clicking Continue to Pickup Details, and filling the four contact fields from their screenshots, with a firm stop before Continue with Apple Pay. First tested the current live page: selected the fourth enabled option, 7:30–7:45 p.m., entered details and filled the four fields without clicking final Apple Pay.

Implemented opt-in pickup_details configuration in a private ignored local file; no real contact values are included in source, docs, tests or event logs. Default behavior remains store-list handoff. Added deterministic New York time selection with the preferred fourth option and best-effort 60-minute lead, exact configured-store selection, per-field fill verification and final-button visibility check. Script contains no click on the final co-options-applePay button.

25 Node/Playwright tests passed, including slot selection, future-day handling, a real mocked browser details form, forbidden final payment action, and unavailable configured-store stopping. Existing default-mode tests still pass.

After inspecting the filled contact page, explicitly reset the previous completed task for the user-requested rerun. Executed standalone shopping.mjs prepare for iphone18-details-20261026-001 from the bag preflight, reusing the one matching iPhone 18 Pro 512GB Burgundy. Detected 21:06:05.919Z; bag-ready 21:06:06.613Z; Apple Pay navigation 21:06:06.673Z; slot selected 21:06:09.730Z; contact verified and handoff 21:06:20.243Z. Total 14.324 seconds. Final status awaiting_user, Chrome open and task locked, final Apple Pay not clicked. No repeat Add, deletion or order submission during rerun. Mini forwarding and LAN live settings were not enabled by this change.

## Second-slot policy, shared-bag test, hold queue and speed instrumentation

User authorized selecting the second available future slot with no one-hour lead, automatic recognized old-bag cleanup between released tasks, and holding new requests while a task is under user control. Updated private local config accordingly. Same-one bags are reused; other recognized bags are cleared before the next Add, with no AI question. Active tasks keep the lock and are never cleared by an arriving event.

Read-only live isolation experiment used one new tab and one CDP-created new window in the existing profile. Each saw the same one iPhone 18 Pro 512GB Burgundy; both test surfaces were closed and the original completed contact page retained. No checkout actions were performed in those test surfaces.

Measured current-page contact fill+readback: First Name 10+10 ms, Last Name 183+2 ms, Email 7+2 ms, Phone 7+2 ms; total 223 ms. Guard 21 ms. Previous run’s slot-to-details interval was 10.512 seconds, not a per-field delay. Added separate navigation/page-ready/fill stage times and noWaitAfter on the intermediate Continue click with explicit target-form readiness. No faster full live latency is claimed: current active payment handoff was deliberately not overwritten for a benchmark.

Resident receiver supports optional persistent held queue (8 max), expiration after 180 seconds from detection, cancellation of held events at restart, same-ID deduplication, and FIFO dispatch only after active task release. Closing the designated task tab after completion causes an explicit release gesture, new working tab and next fresh event; unrelated tabs and full CDP/browser disconnect do not release. Single-use CLI stays busy rather than pretending to run a resident queue. Python sender now keeps polling held status.

Verification: 30 Node/Playwright tests passed, including real loopback CDP task-tab closure releasing held work and whole-browser closure retaining the lock; Python 42 run, 41 passed, 1 skipped. Source and tests contain no real contact values.

Stopped the previous dry-run listener and started the updated resident receiver on 192.168.31.35:8765 plus loopback, restricted to Mini 192.168.31.173 and localhost. Health now mode live, browser_ready true, active iphone18-details-20261026-001, pending 0. Verified actual HTTP health from MacMini as well. Original final contact page and active handoff lock remain intact. Mini’s monitor hook/config was not enabled or modified in this turn. Receiver is a foreground command-session process, not an installed login LaunchAgent.

## Silver 1TB live timing test

Initial request encountered idle closed work tab (browser_not_ready). Added bounded shared ensurePage recreation on incoming event when idle; active handoff locks are never reset by this recovery. Full existing 30 Node tests passed and new receiver regression passed (31 total covered). Restarted resident receiver preserving state, then sent fresh silver-timing-20261026-002 through authenticated local HTTP. It automatically removed the old Burgundy item, added the new Silver 1TB Pro Max once and reached pickup_unavailable. All five displayed stores were disabled, none selected; no time/contact step or final Apple Pay occurred. Event-creation to completion 13.268 s, excluding the earlier receiver repair. Per-stage timings saved in private runtime-cdp/silver-timing-report.local.json. Current task remains locked for user inspection.

## Four-variant preloading comparison

User authorized preloading four Duo combinations, excluding setup time, then retaining only one URL-matched target for checkout. Implemented separate guarded preload and trim paths, tested missing-target/quantity/uncertain-removal cases. Apple live removal detached its old button before row update; the first calibration stopped. Added product-identity and row-count waits, with an async regression test, then re-preloaded and completed the valid run.

Same-target live control empty-bag run: 5.438 seconds; preloaded trim run: 6.018 seconds (0.580 seconds slower), excluding preparation/calibration. Three removals: 855/856/856 ms. Both stopped at pickup_unavailable, all five visible stores disabled, none selected; no final payment interaction. This single warm-cache pair is not a general performance guarantee. Detailed comparison: preloaded-duo-benchmark-2026-10-26.md. Experimental strategy remains opt-in rather than replacing the resident receiver's normal strategy.

Post-benchmark verification: all 37 Node/Playwright tests passed. Restored normal-strategy live resident receiver, preserving duo-ab-preloaded-20261026-002 as the active completed handoff lock. No pending event was executed.

## Five-page prepared-product design and live benchmark

User steered from assuming an empty bag to a five-page design: four Duo tabs prepared with No AppleCare plus one actual bag tab for decisions and checkout. Implemented guarded tab discovery, public-URL tab identity across Apple's confirmation navigation, conditional stale-tab re-preparation, no Add during warmup, Add once on the selected tab and strict post-add validation on the fifth tab. Completed-tab close holds the old lock through idle cleanup/re-warm, then dispatches held work.

Live paired control 6.130 seconds, five-page path 3.718 seconds, a 2.412 second / 39.3% reduction for this one pair. Both used Duo 256GB Star White, included initial bag refresh/check and post-add verification, and stopped pickup_unavailable. Setup was excluded; proof verified four distinct ready pages, all No AppleCare true/Add enabled, and empty fifth bag. Detailed stage comparison is in five-page-warm-benchmark-2026-10-26.md; private raw events in five-page-comparison.local.json. Local resident config now enables warm_product_pages, with experimental preloaded bag_strategy absent.

40 Node/Playwright tests passed; targeted warm-pool tests passed after the final empty-bag readiness wait change. No real contact data was added to source/tests. No payment submitted.

Warm-pool live receiver restarted successfully with the five-page configuration. Health browser_ready true, active duo-five-warm-20261026-001 preserved, pending 0. No new task or cleanup was triggered by the restart.

## Four independent profile cart isolation

User explicitly requested four actual Chrome profiles rather than tabs. Launched four installed Chrome Stable instances, each a fresh independent user-data root and Default profile, at localhost CDP 9223–9226. Original five-page profile and its locked handoff were preserved. Verified all four initially empty, then added only A and checked B/C/D stayed empty. Repeated for B, C and D, reloading all four bags after each Add. Full matrix passed, each assigned variant quantity 1 with no cross-contamination. No account login or cookie copying.

Timed direct checkout from A's preseeded target-only bag: 2.454 seconds, 0.477 s to verify bag and 1.977 s to pickup_unavailable. Timed run did no Add or removal. After A checkout B/C/D still had their own single assigned items. This is evidence for these four logged-out profiles, not for permanent retention or future shared-account behavior. Scripts/manifest/evidence and full matrix documented in four-profile-isolation-2026-10-26.md. Existing production receiver routing was not changed to these test slots.

## Four-profile router adopted; four corrected Pro aliases tested to final button

User selected four independent Profile strategy and supplied Pro test URLs, then corrected C to 512GB Burgundy. Prepared A=256 Burgundy, B=256 Glacier, C=512 Burgundy, D=512 Glacier, each exact item quantity 1. Built/authenticated URL-to-profile router with independent per-profile Engine locks, held queues, cross-profile event-ID conflict protection and model/Profile notifications. Main LAN listener now runs profile_router.mjs instead of the old five-page listener. Primary routing/reseed assignments remain the four Duo variants, with explicit corrected Pro test aliases.

A/C first successful rounds reached the final Continue with Apple Pay button in 13.328/13.650 seconds. B/D required calibration: fixed unavailable preferred-store behavior using event store_name, expanded more stores for Staten Island, and replaced covered-input check clicks with exact associated-label clicks + checked verification. Final B/D successful rounds: 24.298/23.388 seconds, SoHo and Staten Island tomorrow respectively. Setup and failed calibration attempts are excluded from those successful-round timings. Fill-only work was 55–91 ms, with page/store readiness taking the rest. No AI model exists in the runtime path.

All four final forms were read-only verified (4 expected contact fields each), final Apple Pay buttons visible/enabled, no final click or order. All four task locks preserved. 43 full-suite tests passed before final covered-radio fix; 6 targeted details tests passed afterward, covering 44 distinct tests. Contact data stayed private/ignored. Full report: four-profile-pro-checkout-2026-10-26.md. Mini monitor hook was not enabled/modified; router is a foreground resident process, not installed as login service.
