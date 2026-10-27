# Safari handoff inactivity timeout

Production enables `handoff_idle_timeout_seconds: 600` for all four Duo profiles.
The resident receiver checks awaiting-user tasks about every five seconds.
This is an explicit exception to preserving the successful handoff indefinitely.
The standalone test CLI has no resident watchdog.

A page-local observer is armed before the form is filled and brought forward.
Trusted mouse movement/clicks, keyboard input, changes, scrolling gestures and
touch activity update a monotonic inactivity clock. Script-generated DOM events
are ignored. Only the last activity timestamp is logged; key contents, form
values and pointer coordinates are never recorded. Re-arming the same event does
not erase recorded activity or payment state.

After ten minutes without page activity, the browser performs a final atomic
idle check and returns to the bag. It verifies/restores the expected single-device
cart, sounds/notifies, then releases the profile lock. Only still-valid held
requests may dispatch; existing held-event expiry is unchanged. If cart restoration
fails, the task remains locked for review and an error notification is attempted.

Trusted interaction with the final Apple Pay button, or a trusted form submission,
marks payment as started. That suspends automatic return until explicit release;
wallet interactions can occur outside the webpage and must never be interrupted.
A changed page, lost observer, mismatched event, unreadable browser or unknown
state also suspends automatic return. No watchdog operation clicks Pay, accepts
terms, authorizes a wallet or submits an order.

The final idle decision and navigation share one JavaScript task. The server then
keeps the task lock during bag restoration, preventing a later request from
modifying the same profile concurrently. A user action arriving before that final
check cancels the return. Recent DOM state is never inferred from an old poll.

Validation includes a full 107-test Node run, followed by a focused 12-test final
idle suite including trusted mouse movement and restore-failure notification.
Tests use a simulated monotonic clock and locally fulfilled browser pages, so no
real order is used to exercise payment-start detection or the ten-minute boundary.
Native Safari read-only verification confirmed the new dispatcher refuses to
claim a non-handoff bag page. Production health reports 600 seconds for A–D,
four ready browsers, and deployed module hashes matching source.
