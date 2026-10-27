# Safari attention alerts

The user requested brief, faster, voice-only alerts for available pickup.
Current inventory-signal speech is exactly one of: 二五六白, 二五六黑, 五一二白, 五一二黑.
It uses Tingting at rate 320, with no three-tone prefix, intro, city, or extra
payment sentence. It is announced when a new task starts verifying a received
inventory signal, before checkout finishes. Final ready notification stays visible
without repeating already-queued configuration speech. Non-ready statuses retain their short distinct status tones.
System output volume was changed once from 38% to 70%; runtime does not override
subsequent user volume adjustments.

Playback is submitted to one bounded FIFO audio queue shared by all profiles in
the resident process. Actual sound and speech run in afplay/say child processes;
the checkout path does not wait for playback completion. Notifications and
foregrounding remain separate. A new speech job cannot overlap a currently
playing job, and a failed job does not stall later alerts. The queue accepts up
to 32 pending jobs; a full queue reports refusal and attempts the terminal-bell
fallback, while the visual notification still proceeds. Pending audio is not
replayed automatically after a receiver process restart.

The immediate event feedback reports `audio_queued` and `audio_job_id`, not a
premature claim that sound already played. `feedback_dispatched_at` records
submission/notification completion; actual playback completion goes into each
profile's private, rotated `feedback.jsonl`, correlated by event ID/job ID.
`/health` exposes only background queue busy/pending counts. Logs contain no
contact details or typed input. Speech failure and notification failure cannot
alter checkout state or trigger another browser operation.

A preview uses the explicit Safari 提醒试听 notification title. Native two-job
preview verification returned both jobs in about 275 ms while the first job was
still playing and the second was queued. Both completed with speech success and
zero tone repetitions. This is audio submission timing, not checkout timing.
Forty-three focused queue, notification, routing, lock and receiver tests passed.
The production module hashes were verified after an idle restart; four Safari
profiles remain ready.
