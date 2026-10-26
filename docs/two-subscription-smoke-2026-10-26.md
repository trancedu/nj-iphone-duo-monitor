# Two-subscription smoke test — 2026-10-26 EDT

The local monitor now reads all cached remote subscriptions from Clash Verge Rev, without changing the GUI-selected profile or fetching/logging subscription URLs. This deployment retains ZIP 07094, 12 stores, and fixed white 256GB plus one random configuration per request.

## Bounded verification

- Subscription A: three inventory requests succeeded. One initially selected exit was already cooling down and was skipped; a different eligible node completed the third actual query.
- Subscription B: two inventory requests succeeded; one returned HTTP 541 and entered cooldown.
- 121 actual node entries across both subscriptions were loaded (53 + 68). Non-Apple probes measured 62 distinct usable connectivity exits. These are not 62 guaranteed Apple-compatible exits.
- A subsequent two-minute combined run made 60 inventory requests: 30 valid responses, 26 HTTP 541, 4 network errors. Both subscriptions contributed successes (10 and 20 respectively).
- Mean request start gap: 2.009 seconds; min 2.001, max 2.016. Mean successful completion gap: 3.948 seconds; maximum 21.067 seconds. These are short-run observations, not long-term guarantees.
- The minimum repeated-IP gap observed was 108.47 seconds. All requests respected the configured 60-second minimum and per-IP cooldowns; duplicate IPs cannot be in flight simultaneously.
- 30 local tests passed, including cross-subscription name collisions, duplicate exits, bounded concurrency, and global Retry-After admission blocking.

## Scheduling and limits

The service admits at most one new request every two seconds, with at most four requests in flight to prevent slow requests from blocking all later starts. Mutable state, notification deduplication and cooldown updates stay on the main thread. HTTP 429 / Retry-After blocks subsequent dispatch globally; requests already in flight may finish. Per-IP 403/541 cooldowns remain 5, 10, 20 minutes and longer up to one hour. A restart preserves them.

At 0.5 requests/second and a 60-second minimum per-IP interval, 30 healthy independent exits are the theoretical capacity floor. More distinct exits provide cooldown headroom but do not establish a safe Apple rate. To use a 120-second minimum at the same aggregate start rate requires 60 continuously usable exits. Current measured connectivity exits include Apple-blocked exits, so this test does not establish that stronger target.

The deployer now uses `--all-subscriptions --max-nodes 256 --workers 4`. New or refreshed cached profiles are picked up on service restart. Provider-only subscription profiles are rejected explicitly rather than silently ignored. Live service uses existing Telegram credentials for stock alerts only; no test messages were sent.

Raw diagnostic responses, endpoint IPs and runtime logs stay under ignored `runtime/`; no subscription credentials or URLs are included in this report.
