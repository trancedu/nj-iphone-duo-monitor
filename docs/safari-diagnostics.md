# Safari pickup diagnostics

Production now records a bounded, structured observation for each initial store
check, store-list expansion and pre-refresh stock check. Records are correlated
by the original Mini `event_id`. Errors also attempt a read-only diagnostic
capture before the page can be changed. This never clicks a control or captures
the whole page, screenshot, cookies, contact form values or authentication key.

Per-profile files under the stable Safari runtime directory:

- `events.jsonl`: lifecycle stages, canonical product URL, requested store name/ID,
  backend/profile, reason and timestamps.
- `diagnostics.jsonl`: timestamped store observations and sanitized failure context.
- `events.json`: durable task state plus the most recent observation and a count.
  The authenticated `/status/EVENT_ID` response also returns `last_observation`
  and `diagnostic_count` when observations exist.

Observation fields include phase/attempt, Safari profile/window ID, requested
store name and ID, configured ZIP, ZIP actually readable from the page, sanitized
Apple origin/path and checkout state, and up to 40 store rows. Each row includes
the accessible store label, available/unavailable wording, enabled and visible
states, and a store ID when the DOM exposes a recognizable ID. A missing page ZIP
or store ID is null; configured ZIP is not presented as the observed ZIP.

Only known observation fields are serialized. URL query strings, arbitrary
checkout states, HTML, unrelated page content and contact configuration are
excluded. Text and row counts are capped. Diagnostic history rotates at 10 MiB,
retaining two older files (`.1`, `.2`); files use mode 0600 inside private runtime
directories. No extra Apple request is made for normal logging: the existing store
DOM read supplies the added metadata.

Verdicts distinguish:

| Verdict | Meaning |
| --- | --- |
| `target_store_not_listed` | The expected store is absent from the observed rows; inventory is unconfirmed. |
| `target_store_not_selectable` | Matching store row exists, but its radio is disabled. Read the captured availability text alongside this state. |
| `target_store_selectable` | The matching radio is enabled; proceed without refreshing. |
| `target_store_ambiguous` | More than one row matches; stop for review. |

After bounded rechecks, a missing target now produces `manual_review` with reason
`target_store_not_listed`, retaining the page/task lock. It is no longer reported
as `pickup_unavailable`. A found-but-disabled target retains the unavailable
outcome and standby restoration behavior. Store-list expansion still waits for
asynchronous rows before deciding. Error reasons now reach Safari notifications,
so the notification no longer reduces a known error to `unknown`.

Example local search (replace EVENT_ID):

```sh
rg 'EVENT_ID' "$HOME/Library/Application Support/iPhoneDuo/receiver-safari/runtime-profiles/"*/diagnostics.jsonl*
```

The historical Garden State Plaza event
`0d6d5b370eb645f58d02ac3b25a34569` predates this logging. Its original page/store
state cannot be reconstructed retroactively. New events after deployment include
the richer evidence. Native Safari read-only smoke verification succeeded on the
current bag page, and deployed module hashes match source. Existing event
histories/locks were retained during the idle receiver restart.

Validation: the full Node suite passed 90 tests before the final asynchronous
expansion regression was added; the final Safari-focused suite passed 43 tests,
including that additional case. Coverage includes missing versus disabled stores,
raw availability/visibility, partial row loading, expanding a delayed target,
privacy filtering, log rotation/permissions, status persistence and notification
reason propagation. Fixture browser tests use local fulfilled pages; no order or
final Apple Pay action is used for logging verification.
