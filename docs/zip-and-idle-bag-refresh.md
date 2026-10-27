# ZIP selection and idle Safari bag refresh

## ZIP behavior

The shared optional environment variable is `APPLE_PICKUP_ZIP`. It must contain
exactly five digits. Leaving it unset preserves the checked-in defaults.

On Mac Mini, setting it replaces every configured regional query with a single
query for that ZIP. The previous regions are not queried while the variable is
set. The ZIP's store roster is read from Apple's response and validated for
unique store IDs, state codes, all configured SKUs, and pickup fields. The
inventory event carries the ZIP that produced it.

On the Mac receiver, the same variable overrides the event ZIP and configured
fallback ZIP. When unset, the event ZIP takes precedence over the JSON fallback.
Standalone browser scripts also support this environment variable.

For a future California trial, add `APPLE_PICKUP_ZIP=94596` to the existing
environment files on Mini and Mac, then restart both services. This switches all
monitoring and pickup preparation to that ZIP. To return to the present defaults,
remove the variable and restart both services. The variable has not been set in
the live environment, so the current New York-area configuration is unchanged.

The current monitor configuration contains two ZIPs, `07078` and `11530`.
The receiver's fallback pickup ZIP remains `07094`. New monitor events carry
their source ZIP so the checkout form can use the matching region.

## Idle bag refresh

The Safari router checks each profile every two seconds, but reloads no more
often than once per 300 seconds. It reloads only when the profile has no active
event or incoming request and the page is Apple's Bag with exactly the
preconfigured product at quantity one. It waits for the new document and
verifies the same bag again. Pages in checkout, pickup, manual review, payment
handoff, or any unrecognized state are left alone. A failed or mismatched
refresh is logged without clearing the bag or retrying the reload immediately.

This keeps the idle bag page fresh as a best effort. It does not guarantee that
Apple will preserve any server-side checkout state indefinitely.
