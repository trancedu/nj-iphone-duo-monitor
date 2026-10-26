# Safari checkout experiment — 2026-10-26

> Historical record: production has since switched to Safari. See [current Safari production handoff](safari-production-handoff-2026-10-26.md).

Safari remains test-only. Chrome's live LaunchAgent, router, configurations and
Mini forwarding endpoint are unchanged. Safari has no HTTP listener, LaunchAgent,
Mini routing or background checkout loop. The standalone Node/AppleScript harness
runs fixed DOM operations; no AI participates while it executes.

## Verified live result

Created a separate Safari profile `PickupTest18Pro` and tested iPhone 18 Pro
6.3-inch 256GB Burgundy. Its cart was seeded separately with No AppleCare and
quantity one. The four user-prepared Duo profile carts were read successfully:
Duo256White, Duo256Black, Duo512White and Duo512Black each had their corresponding
single device. The later Duo 256GB White follow-up is recorded below; the other three Duo carts were only read.

The final uninterrupted run reached the real pickup contact page, selected
Apple SoHo, October 27, 9:30–9:45 a.m. (second available slot), filled and verified
the user-provided contact information, and left the final Continue with Apple Pay
button enabled and untouched. No wallet authorization or order submission was
attempted. The test profile window is left open and its profile lock retained.

| Stage | Seconds |
| --- | ---: |
| Start through bag verification | 1.608 |
| Wait for Apple Pay checkout entry to become ready | 1.541 |
| Click checkout entry | 0.172 |
| Pickup page ready | 2.680 |
| Select store and second available slot | 1.022 |
| Click Continue to Pickup Details | 0.165 |
| Pickup contact page loading | 9.103 |
| Fill and read back contact fields | 0.170 |
| Verify final Apple Pay button ready | 0.161 |
| **Start to final button ready** | **16.622** |

Preseeding the cart is excluded. Timing includes bag load/readiness at the start.
The report finishes after bringing Safari forward (16.796 seconds). This is one
observation; it does not demonstrate that Safari is faster than Chrome or that
its actual Apple Pay wallet/payment is faster, because the final button was not
clicked. Earlier calibration attempts stopped on explicit selector/readback
errors; they were inspected and corrected before the final uninterrupted run.

Private timing evidence: `mac_receiver/runtime-safari/safari-41863-1793056401866.local.json`.
Contact information is kept in the ignored local configuration, not in this doc.

## Run manually

The user authorized and we enabled Safari Settings → Developer → Allow JavaScript
from Apple Events. Remote automation remains disabled. Unlike this approach,
[Safari WebDriver creates isolated automation windows](https://developer.apple.com/documentation/webkit/about-webdriver-for-safari),
so it does not reuse these existing profile windows.

From the repo root, discover current window IDs:

```sh
node mac_receiver/safari/shopping.mjs --list-windows
```

Copy `receiver.safari-test.example.json` to an ignored `receiver.safari-test.local.json`
and supply real pickup contact information privately. The local configuration used
in this experiment already exists. It permits any available store for this test;
set `test_any_available_store: false` to require the configured store.

Example for the current test window (IDs change if windows are recreated):

```sh
node mac_receiver/safari/shopping.mjs prepare \
  --window-id 41863 --profile PickupTest18Pro \
  --config mac_receiver/receiver.safari-test.local.json \
  --url https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-burgundy-unlocked
```

Actions: `inspect` reads only, `seed` prepares/verifies the bag without checkout,
`prepare` continues to the final Apple Pay button. The same command can address a
Duo window with that profile's exact product URL, ID and profile name; this was
not connected to stock signals in this experiment.

The selected window must have exactly one tab and the expected profile prefix.
There is a persistent lock per profile, including across window IDs. Completed
handoffs and uncertain failures remain locked. Re-running `prepare` on a locked
profile refuses to start. Only after the test is actually finished, release it:

```sh
node mac_receiver/safari/shopping.mjs release \
  --window-id 41863 --profile PickupTest18Pro \
  --config mac_receiver/receiver.safari-test.local.json \
  --url https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-burgundy-unlocked \
  --confirm-test-finished
```

Release never navigates, clears a cart or submits anything. It refuses to release
a running process. No Safari background queue is installed. Do not concurrently
shop in another window of the same Safari profile: those windows share its cart.

## Boundaries and validation

Only a cart containing exactly the expected product, quantity one, can continue.
An empty bag can be seeded once; an uncertain Add result stops rather than
repeating Add. Existing wrong items are never silently removed. The script waits
for checkout readiness, handles native/ARIA radios and formatted phone numbers,
and chooses the second available future time through the shared time-selection
function. Only recognized unavailable pickup results get bounded refreshes;
stock appearing stops refreshing immediately. Unknown pages, authentication or
CAPTCHA stop for inspection. The Safari test harness preserves a sold-out pickup
page; it does not restore or clear user-prepared Duo carts.

Eight local Playwright fixture tests passed (no Apple requests): end-to-end
contact handoff; stock appearing on refresh; bounded sold-out retries; wrong bag
rejection; no final payment operation; explicit window/profile binding;
asynchronous ARIA radio state; formatted phone readback. Actual Safari was tested
separately as reported above. Safari's stock-retry behavior is fixture-verified;
the live Pro run had stock and did not refresh. The follow-up below verified actual Safari sold-out refreshes.

## Follow-up: Duo 256GB White simulated signal

Manually invoked the same deterministic test harness on `Duo256White` (window
41488), with its pre-existing single-device cart, configured ZIP 07094 and
required store Apple West 14th Street. Safari remains disconnected from Mini
production forwarding. The ambiguous spoken product name was interpreted as
the existing white 256GB Duo, as stated before execution.

- Pickup page ready: 3.175 seconds from script start.
- First unavailable result: 4.865 seconds.
- Five additional refreshes and checks: 16.751 seconds.
- Total: 21.616 seconds; six checks, all unavailable.

No time/contact or payment stage was entered. The Safari test preserved the
pickup page and brought its window forward for inspection, without altering
Chrome's production service. This is not a measurement of an in-stock checkout
through final Apple Pay readiness. Private timing report:
`mac_receiver/runtime-safari/safari-41488-1793056624368.local.json`.

## Audible feedback and expanded scenarios

Safari test completion now brings the selected window forward, plays a system
sound, and submits a notification identifying the profile/product and outcome:
Glass for manual Apple Pay handoff; Pop for unavailable pickup; Basso for errors
or a blocked duplicate request; Ping for a seeded bag. Notifications include no
contact information. Foreground, sound and notification failures are independent;
failed sound gets a terminal-bell fallback. Notification failure cannot change a
successful checkout into a retry or release an uncertain profile lock. Reports
record `sound_played`, `notification_submitted`, foreground status, and
`feedback_completed_at`. Successful submission is not proof that macOS displayed
a banner; delivery depends on the user's notification settings.

Actual Safari retests:

| Scenario | Workflow result/time | Including feedback |
| --- | --- | ---: |
| Duo 256GB White: six checks, unavailable | 14.533 seconds | 17.341 seconds |
| Pro 256GB Burgundy: ready before final Apple Pay | 16.672 seconds | 19.196 seconds |
| Duplicate request using same locked profile and different window ID | Blocked; original page unchanged | Basso/notification succeeded |
| Binding an existing Pro window as a different profile | Rejected immediately; original page unchanged | Read-only guard test |

Both actual checkout outcomes successfully foregrounded their Safari window,
completed system sound playback, and submitted the notification. Pro remains on
the filled contact page; the final Apple Pay button was not clicked. Chrome's
live authenticated health still reports all four browsers ready and no active
request at the final verification.

The **25 local automated tests** comprise 17 DOM/flow scenarios and eight feedback
tests. DOM fixtures run in headless Chrome with all network requests locally
fulfilled; they test the Safari-specific DOM dispatcher and fixed orchestration,
not real Safari/WebKit engine behavior. Real Safari checks are separately listed
above. Coverage adds wrong quantity, extra items, unknown store markup, missing
date after stock selection, contact failure, CAPTCHA, unexpected sites, feedback
channel failures, and stock appearing during a retry pause. The last case now
causes an immediate pre-refresh recheck and continues without reloading the
available page. That final pre-refresh protection is fixture-verified; it was
added after the real sold-out retest reported above.

Run the focused checks:

```sh
node --test mac_receiver/tests/safari.test.mjs mac_receiver/tests/safari_feedback.test.mjs
```

Private live evidence summary:
`mac_receiver/runtime-safari/feedback-scenarios-20261026.local.json`.
Safari remains manual test-only, with no Mini listener or production switch.
