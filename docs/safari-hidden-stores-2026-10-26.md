# Hidden store selection and early voice correction

Two actual Mini events established different outcomes:

- `1bf7a84ab9364ebca34e7c40227469a7`: Duo 512GB Star White / Fifth Avenue,
  detected 20:58:48 Eastern. Safari observed store R095 as Available Today,
  enabled=true, visible=false. The old workflow found inventory but skipped
  expanding the list because the row already existed in the DOM. Clicking its
  hidden control failed with `control_not_available`. No pickup time or payment
  was selected. This was a script defect, not evidence of unavailable stock.
- `11d5be7018a248e58293305a10d61811`: Duo 256GB Night Sky / Fifth Avenue,
  detected 20:59:28 Eastern. Eleven checkout observations reported R095 Currently
  unavailable with its radio disabled. This is a different outcome; these logs
  do not establish why the monitor and checkout inventory differed.

Correction: when the selected enabled target is hidden, the workflow latches
`pickup_stock_found_at`, clicks the unique visible Show more stores control
(button or link), waits for the target to be visible, rereads its current label,
and selects it. No inventory refresh occurs after the positive observation.
If stock changes during expansion, the workflow preserves the pickup page and
stops for review rather than refreshing or returning to the bag.

Previously configuration speech occurred only at final manual handoff, so both a
failed preparation and a sold-out outcome produced status tones without reading
the configuration. It now occurs at the start of each new executing inventory
signal: short voice only, e.g. 五一二白 or 二五六黑. The notification explicitly
says inventory is being verified. The announcement does not mean checkout has
already confirmed/reserved stock. It is asynchronous and cannot delay preparation.
Identical event-ID replays do not announce again; held events announce only when
they actually start. A successfully queued initial announcement suppresses duplicate
configuration speech at final handoff; the visual handoff notification remains.
If initial announcement failed to queue, final handoff may retry audio.

69 focused tests passed, including the exact sixth-hidden-row reproduction with
a Show more link, inventory changing during expansion without refresh, initial
announcement timing, dedup/hold behavior, and suppressed final duplicate audio.
Fixtures are local browser pages; payment is never submitted.

Native follow-up: the first recheck stopped when the bag checkout entry did not
navigate, retaining its page/lock. After inspecting the bag and explicitly
resetting that failed recheck, a fresh recheck
`retry-fifth-512white-verified-1793063440829649000` completed eleven observations
of R095 Currently unavailable (21:10:44–21:11:04 Eastern), restored its cart and
released its lock. Its initial voice completed successfully with zero tones.
This confirms early voice in actual Safari operation, but cannot recover or
reconstruct availability from the earlier 20:58 event. The successful hidden-row
path is regression-tested locally; that native follow-up no longer had stock.

Production module hashes match source. Four Safari profiles are ready with no
active tasks at final verification. Existing ten additional rechecks, preserved
positive-stock page, no final Pay click, and protected idle timeout remain intact.
