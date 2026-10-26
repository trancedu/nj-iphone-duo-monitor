# Clash isolated proxy smoke test — 2026-10-25

The bounded diagnostic uses the existing `monitor.Client.inventory_region` method,
ZIP **07094**, and the repository SKUs `MK1E4LL/A` (256GB Star White) and
`MK1J4LL/A` (1TB Star White). SKU identities are inherited from the repository;
this test did not independently rediscover Apple's catalog.

`proxy_smoke.py` reads the local Clash config and starts a temporary separate
Mihomo process. Each loopback HTTP listener is pinned to one exact outbound node.
It does not change Clash Verge's running config or selected proxy. Credential
material is held in a private temporary directory and removed on exit.

Successful requests would start at 0, 20, and 40 seconds, once per node. This is
a one-shot diagnostic, with no scheduler, alerts, or immediate retries. Any
inventory error stops subsequent Apple requests, including when switching nodes
would otherwise be possible. Slow responses may prevent the one-minute target.

## Observed result

At **21:40:10 America/New_York**, the first Apple request returned **HTTP 541**.
No inventory JSON was obtained. Remaining Apple requests were skipped. An earlier
startup attempt failed locally while parsing JSON Unicode escapes; that was fixed
before any network request from that attempt.

The private Mihomo log confirms the Apple connection used
`🇺🇸美国01|流媒体|0.1x`. Listeners for US media nodes 01, 02, and 03 all started.
The three `api.ipify.org` preflight requests failed with the monitor's generic
`network_error`, so neither distinct exit IPs nor their geography was verified.
The error's underlying cause was not determined.

**Conclusion:** Python can explicitly route through a named node using its pinned
local port. The inventory smoke test failed; three successful queries within one
minute and sustained reliability remain unverified. Node rotation does not prove
protection from throttling or blocking. HTTP 541 alone does not prove a permanent
IP ban or establish its cause.

Local evidence (Git-ignored):

- `runtime/proxy-smoke-20261025-214009/report.json`
- `runtime/proxy-smoke-20261025-214009/mihomo.log`

## Reproduction

Run only as a deliberate diagnostic, respecting any current backoff:

```sh
python3 proxy_smoke.py
```

Override nodes with exactly three distinct `--node 'exact name'` arguments. The
script requires macOS Ruby's standard YAML support and the installed Clash Verge
Mihomo binary, with configurable paths via `--clash-config` and `--mihomo`.
The normal monitor and deployment configuration are unchanged.

Mihomo documents per-listener `proxy` routing at
https://wiki.metacubex.one/en/config/inbound/listeners/ .

## Follow-up non-Apple connectivity diagnostic, 21:47 local time

No further Apple requests were made. Direct connections, the running Clash
127.0.0.1:7897 port, and the same three pinned nodes were tested separately.
All three nodes returned HTTP 200 from Cloudflare's trace endpoint and example.com.
The generic api.ipify.org endpoint intermittently failed on nodes 02/03 with
`SSL: UNEXPECTED_EOF_WHILE_READING`; its IPv4-only api4.ipify.org endpoint
succeeded for every path, with these observed IPv4 exits:

| Path | IPv4 |
|---|---|
| Explicit direct connection | Local ISP exit (omitted) |
| Running Clash port 7897 (current rules) | 23.237.50.28 |
| US media 01 | 23.237.50.27 |
| US media 02 | 23.237.50.28 |
| US media 03 | 23.237.50.35 |

Thus three distinct IPv4 exits were verified at test time. They share the same
first three octets; no inference of independent providers or failure domains is
supported. These results establish general connectivity, not Apple acceptance.

`scutil --proxy` showed no enabled system HTTP/HTTPS/SOCKS proxy. The running
Mihomo API reported rule mode, mixed-port 7897, and TUN disabled. Explicit Python
proxy configuration works without enabling either system proxy or TUN.

Evidence: `runtime/proxy-smoke-20261025-214703/` (three sites) and
`runtime/proxy-smoke-20261025-214729/` (IPv4-only confirmation).

```sh
python3 proxy_smoke.py --connectivity-only
python3 proxy_smoke.py --connectivity-only --probe-url 'https://api4.ipify.org?format=json'
```

## Explicit three-node Apple comparison, 22:00 local time

At the user's request, one query per node was made for ZIP 07094, with a
three-second wait after each completed query and no retries. IPv4 preflight
confirmed the same .27, .28 and .35 exits. Query starts were 22:00:21.424,
22:00:25.928 and 22:00:29.462 America/New_York. All finished within 10.008 seconds.

**All three returned HTTP 200 and 12 store records**, with response location 07094
and matching store IDs. The two selected SKUs (256GB and 1TB Star White) were
`unavailable` at every returned store on all three responses. This is a successful
bounded smoke test, not evidence of sustained polling reliability or an inventory
check of the other six variants. The previous 541 cause remains undetermined.

The private Mihomo log records a separate Apple connection using each selected
node. Exit IPs were measured against api4.ipify.org; Apple's own view of the
source IP is not exposed by the inventory response.

Evidence: `runtime/proxy-smoke-20261025-220020/` contains report.json, all three raw
Apple JSON responses and mihomo.log. No notifications or continuous monitor were
started, and no running Clash config was changed.

```sh
python3 proxy_smoke.py --compare-three --zip 07094
```

The default diagnostic retains stop-on-error behavior. Explicit comparison is
limited to these three requests; an HTTP 429 or Retry-After stops it early.

## Ten-node comparison, 23:19–23:20 local time

At the user's request, expanded the bounded diagnostic to ten distinct node
names (all labelled US in the subscription), one request per node with three
seconds after each response. Queried the same ZIP 07094 and the same two SKUs.
No retries or continuous polling. All ten Apple connections appear in the route
log. The Apple request phase took 33.943 seconds.

| Node label | Preflight IPv4 | Apple response |
|---|---|---|
| US media 01 | Unverified this run (network_error) | 200, 12 stores |
| US media 02 | 23.237.50.28 | 200, 12 stores |
| US media 03 | 23.237.50.35 | 541 |
| US media 04 | 23.237.50.36 | 541 |
| US media 05 | 203.10.97.121 | 200, 12 stores |
| US Los Angeles media 01 | 23.237.50.28 | 200, 12 stores |
| US Los Angeles media 02 | 23.237.50.36 | 200, 12 stores |
| US high-speed 01 | 23.237.50.27 | 541 |
| US high-speed 02 | 23.237.50.28 | 200, 12 stores |
| US high-speed 03 | 23.237.50.35 | 541 |

Six responses succeeded; four returned 541 and no stock records. Every successful
response showed both selected SKUs unavailable at all 12 stores. Nine preflights
verified five distinct IPv4 addresses: different node names often share an exit.
The same observed IPv4 (.36) appeared on both a failing and a successful node, so
these observations do not support treating 541 as proof of a permanent IPv4 ban.
The earlier successful .35 test also failed in this run. A single observation per
node is insufficient to rank long-term reliability or isolate the failure cause.
Subscription region labels were not independently geolocated.

Evidence: `runtime/proxy-smoke-20261025-231916/` contains report.json, six raw
Apple JSON responses, and mihomo.log. The CLI now accepts `--compare-nodes` with
3–10 exact `--node` names; `--compare-three` remains an alias. Default diagnostic
behavior and production monitoring settings remain unchanged.
