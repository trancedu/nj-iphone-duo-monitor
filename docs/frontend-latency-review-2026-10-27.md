# Frontend latency review: pickup standby versus manual iPhone

Date: 2026-10-27, Eastern. This is a code/evidence review and an engineering budget, **not a measured claim that the current Mac completes checkout in the target times**. No live browser, payment or order operation was performed for this review. Paid inventory polling remains disabled.

## Repository and deployment facts

The Mini worktree was clean. All dashboard work was already committed and pushed at `1f6ca26`. `git fetch origin` found no further commits: local HEAD and origin/main were equal. There were no outstanding dashboard changes to commit or merge.

The fetched Safari workflow in `mac_receiver/safari/shopping.mjs` still starts by verifying Bag and then entering checkout. The user reports that the Mac is now kept on the pickup-store page. The earlier isolated simulation report at `runtime/voice-forward-test/20261027-161643/result.json` also contains `standby_refresh_at`, which is absent from the fetched workflow. This is evidence of a deployment/source mismatch; it is not a reason to replace the user's running Mac with the older Bag-entry workflow. The Mac's configured LAN `/health` endpoint was unreachable during this review, so the latest deployed standby implementation could not be independently inspected. Have the Mac-side changes pushed before implementing a hot-path refactor against this checkout.

## Endpoints of the timing comparison

`t0`: Mini has confirmed an eligible inventory result and can enqueue the event. Time from Apple's actual inventory change to detection is a separate delay and is not included below.

`ready`: correct store/date/time selected, pickup contact filled and validated, final Apple Pay button enabled, target window ready for the user. This is what fetched Safari `handoff_at` means. It is **not** an open system Apple Pay sheet, completed biometric authorization, inventory reservation or accepted order.

`authorization`: user clicks Apple Pay and performs the required device confirmation. Order acceptance/server processing is a further stage with variable duration. See Apple's [Safari payment guide](https://support.apple.com/en-ca/guide/safari/ibrw8e207504/mac) and [Apple Pay instructions](https://support.apple.com/en-us/102626). Neither source supplies a Face ID versus Touch ID speed benchmark.

## Evidence currently retained on the Mini

- An earlier pickup-standby simulation reached Mac receipt about **0.404s** after detection, and `pickup_page_ready_at` **3.530s** after receipt. It ended `pickup_unavailable`; it does not measure successful store/date/contact/payment readiness.
- Three historical `awaiting_user` receipts have received-to-handoff intervals **14.800s, 23.754s and 25.504s**. They lack detailed per-stage timestamps in the retained sender log and concern earlier runs. They cannot establish the latest pickup-standby path's median/P95 or prove which step was slow.
- The sender's routine delivery log keeps only selected stage timestamps. The Mini cannot recover missing Mac stage breakdowns from those receipts.
- Inventory API response latency cannot be substituted for checkout-page latency; they are different requests and workflows.

## What the fetched code already does well

`mac_receiver/safari/dom.mjs` fills First Name, Last Name, Email and Phone in **one DOM call** using native input setters plus input/change events, and verifies readback. There is no per-character typing delay. Contact entry itself is likely a small part of the path, but its actual execution time on the Mac has not been measured here.

`shopping.mjs` uses conditional waits, identifies the requested store, checks availability, chooses enabled date/time options, and protects a found-stock page. Sound/notification work is queued independently rather than awaited by the browser workflow. Final payment is intentionally outside the automation operations in this fetched version.

The main unavoidable page waits are fresh pickup inventory, date/time updates after store selection, and the transition to pickup-contact details. Filling existing DOM fields cannot eliminate those server/UI dependencies.

## Target budget for the user's pickup-page standby path

These are **engineering estimates to validate on the Mac**, assuming the profile is logged in, on the right product's pickup page, online, fresh enough to use, no task is blocking it, no CAPTCHA, no retry, and the requested store is genuinely selectable.

| Phase from t0 | Target budget | Main dependency |
| --- | ---: | --- |
| LAN delivery and dispatch | 0.1–0.5s | Sender queue and local receiver |
| Refresh pickup and obtain usable fresh list | 0.8–2.5s | Apple response and page update |
| Reveal/choose correct store, date and slot | 0.5–1.5s | Dependent options and automation bridge |
| Continue and load pickup-contact page | 0.5–1.5s | Page/server transition |
| Batch-fill contact and verify readiness | 0.1–0.4s | Existing input fields and validation |
| Foreground and indicate handoff | 0.1–0.3s | Local window operation |

The sum is about **2.1–6.7s**, so a sensible initial target is **3–7 seconds to the Apple Pay button being ready**, rather than promising one second. Slow Apple responses, stale sessions, unavailable stock, queue contention and retries can push this past ten seconds or stop it entirely.

If the user is already nearby and ready, a planning allowance of another **roughly 2–5 seconds** for opening Apple Pay and device authorization suggests **about 5–12 seconds to user authorization** in a favorable case. This is not measured, a guaranteed completion time, or a promise of order acceptance. Authorization time varies by hardware, payment-sheet readiness, user reaction and any extra confirmation.

For future validation, a reasonable aspirational metric is readiness median <=5s / P95 <=10s on successful warm-path trials; neither statistic is presently established.

## Why automation can beat a shorter phone flow

Computer automation runs while the person reacts. Do not add the full human reaction delay before starting the automated steps:

```text
Mac authorization time ≈ max(automatic preparation, user ready at Mac)
                         + Apple Pay interaction / authorization

Manual phone time ≈ reaction + find/unlock/switch to correct phone/product
                    + pickup store/time steps + Apple Pay interaction
```

Illustrative assumptions only: Mac preparation 5s and person ready in 2s, followed by 2s payment interaction, gives 7s. Phone reaction/device switching 4s, navigation/store/time 4s and payment 2s gives 10s. But a phone already in hand on the right page could beat that Mac. These are examples of overlap, not human-performance measurements.

Thus, the Mac's strength is eliminating manual device/product selection and starting immediately. The extra contact-page network transition is a real disadvantage, while entering four contact fields is already batched. There is no evidence here that Face ID versus Touch ID is the deciding difference. If the real purchasable window is only one or two seconds, neither ordinary manual flow nor a multi-transition browser flow can promise success.

## Highest-value optimization work, without changing payment authorization

1. **Synchronize the actual standby implementation first.** Audit readiness guards on the real Mac. Reuse an already-valid pickup page and correct product; do not re-enter Bag or checkout on every event. Avoid blindly deploying the fetched Bag-entry workflow over the Mac's newer standby code.
2. **Make the complete detected batch reach the Mac before slow side channels.** `monitor.notify_offer` enqueues that offer's bridge message before its Telegram call, which is good. However, production loops offers sequentially and `telegram()` is synchronous; a later offer in the same successful API result can wait behind an earlier Telegram send. Measure this and, if needed, enqueue all eligible events first and send Telegram in a bounded worker, preserving deduplication and errors. This potential change was not deployed by this review.
3. **Reduce automation round trips, not validations.** Every `SafariWindow.call` currently spawns `osascript`; waits repeatedly create those calls. Batch deterministic same-DOM work (identify and select the uniquely matching available store; read/select already-enabled choices) with guards. Retain waits between real server-driven state transitions. A persistent bridge or in-page observation state machine is a candidate only after Mac measurements show that process/Apple Events overhead matters.
4. **Avoid unnecessary UI work.** Reveal stores only if needed; skip clicking already-selected valid date/time choices; do not change ZIP when correct. Keep exact store/SKU/quantity and allowed-time checks. Do not remove required steps merely to shorten a stopwatch result.
5. **Keep contact filling as one operation.** Validate the configured values before an event, then fill/check once when the correct page mounts. The next-page response is the likely cost; per-character input is not currently present.
6. **Separate early signal and ready-to-pay signal.** Early alert gets the person ready while automation works. A distinct ready signal tells them when interaction is useful. Keep audio, foregrounding and notification out of page-critical waits where possible; do not delay a task for speech completion.

## Measurements needed on the Mac

Record detection/receipt, dispatch, refresh start, fresh pickup list ready, stock found, store selected, slot options ready, slot selected, Continue clicked, contact page ready, contact verified, Apple Pay button ready and foreground ready. Keep user payment-sheet/authorization timestamps separate when manually tested; do not log contact/payment values, cookies or checkout page contents.

Measure warm successful runs separately from unavailable/retry runs and cold/session-expired runs. A local fixture can measure selector/bridge overhead but cannot establish Apple's network latency. Compare a person on a ready phone and a person who must find/unlock the phone as separate scenarios. Do not infer the latest successful path's speed from an unavailable trial or from the three old total-only receipts.

No monitor provider, polling interval, browser/payment behavior, active task or lock was changed for this analysis. The Mac must be reachable before a credible current-path benchmark is possible.
