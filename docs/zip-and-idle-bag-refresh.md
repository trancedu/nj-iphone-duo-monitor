# ZIP selection and idle Safari bag refresh

## ZIP behavior

The shared optional environment variable is `APPLE_PICKUP_ZIP`. It must contain
exactly five digits. Leaving it unset preserves the checked-in defaults.

On Mac Mini, setting it adds one regional inventory query to every normal cycle;
the configured New Jersey and New York regions continue to run. The optional
ZIP's store roster is read from Apple's response and validated for unique store
IDs, state codes, all configured SKUs, and pickup fields. It does not replace
either existing region. The inventory event carries the ZIP that produced it,
so the Mac receiver searches the same area during pickup preparation.

On the Mac receiver, the same variable overrides its fallback pickup ZIP. An
event's own `pickup_zip` takes precedence, so a New York event continues to use
the ZIP of its monitored region even if a separate fallback is configured.
Standalone browser scripts use the environment variable as their ZIP override.

For a future California trial, add `APPLE_PICKUP_ZIP=94596` to the existing
Mini monitor environment file and restart that monitor. This is additive: the
regular New Jersey/New York checks remain enabled. It adds one Apple inventory
request per cycle, with the existing request gap. To return to the present
coverage, remove the variable and restart the monitor. This checkout does not
change the live environment or the configured New York-area regions.

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
