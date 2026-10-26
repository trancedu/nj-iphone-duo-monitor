# 30 distinct-exit smoke test — 2026-10-25

An exit scan of 53 actual subscription nodes returned 51 valid measurements, representing 33 distinct IPv4 exits. Two IP probes failed TLS. Measurements were taken against api4.ipify.org, not reported by Apple. All node region names are subscription labels, not independently geolocated.

From this scan, 30 distinct exits were selected, prioritizing US and UK labels, then lower measured IP-probe latency. The scan was reused within five minutes; the script rejects older scan reports and excludes unverified/duplicate exits. The private Mihomo route log confirms one Apple connection per selected node.

Apple requests: 2026-10-25 23:25:35 through 23:27:07 America/New_York. ZIP 07094; SKUs MK1E4LL/A and MK1J4LL/A (256GB and 1TB Star White). One request per exit; no retries, parallel inventory requests, notifications or continuous scheduler. Minimum start spacing was 2.001 seconds. Slow responses delayed later requests; no catch-up bursts.

**Outcome: 15 HTTP 200 responses with 12 stores each; 12 HTTP 541 responses; 3 network errors.** Every successful response showed both selected SKUs unavailable. All 30 responses completed in 92.102 seconds; 25 requests started in the first minute. Therefore this sequential test did not achieve 30 requests per minute.

This is one bounded cycle. It does not validate recurring once-per-minute requests per exit or demonstrate avoidance of throttling. HTTP 541 is not sufficient to establish its underlying cause. A non-Apple IP probe cannot guarantee the exact source address Apple observes. More IPs alone did not eliminate failed queries.

| Node | Measured IPv4 | Apple result | Start offset (s) |
|---|---|---|---|
| 🇺🇸美国03 / 流媒体 / 0.1x | 23.237.50.35 | 541 | 0.0 |
| 🇺🇸美国高速05 / CTCU / 0.1x | 203.10.97.121 | 200 | 2.005 |
| 🇺🇸美国洛杉矶01 / 流媒体 / 0.01x | 23.237.50.28 | 200 | 4.01 |
| 🇺🇸美国04 / 流媒体 / 0.1x | 23.237.50.36 | 541 | 6.014 |
| 🇺🇸美国高速01 / CTCU / 0.1x | 23.237.50.27 | 541 | 8.019 |
| 🇬🇧英国伦敦02 / CTCU / 0.1x | 62.164.143.251 | 200 | 10.023 |
| 🇬🇧英国伦敦02 / 流媒体 / 0.1x | 62.164.143.254 | 541 | 12.028 |
| 🇯🇵日本高速08 / BGP / CTCU | 203.10.99.26 | 200 | 14.031 |
| 🇭🇰香港高速02 / BGP / CMCU | 95.40.215.88 | 541 | 21.661 |
| 🇭🇰香港高速04 / BGP / CMCU | 43.199.7.52 | 541 | 23.665 |
| 🇭🇰香港专线03 / BGP / 流媒体 | 95.40.174.142 | 200 | 25.67 |
| 🇭🇰香港高速05 / BGP / CMCU | 95.40.253.195 | 541 | 27.769 |
| 🇭🇰香港高速03 / BGP / CMCU | 43.198.216.28 | 541 | 29.774 |
| 🇭🇰香港专线02 / BGP / 流媒体 | 18.167.210.123 | 200 | 31.776 |
| 🇭🇰香港专线04 / BGP / 流媒体 | 95.41.46.48 | 200 | 33.779 |
| 🇭🇰香港专线01 / BGP / 流媒体 | 18.167.133.97 | 200 | 35.803 |
| 🇸🇬新加坡高速08 / BGP / CTCU | 66.90.98.34 | 541 | 37.835 |
| 🇸🇬新加坡高速02 / BGP / CTCUCM | 66.90.98.35 | 541 | 39.837 |
| 🇯🇵日本专线01 / BGP / 流媒体 | 203.10.99.35 | network_error | 42.235 |
| 🇸🇬新加坡高速04 / BGP / CTCUCM | 66.90.98.37 | 541 | 45.171 |
| 🇸🇬新加坡专线03 / BGP / 流媒体 | 47.129.104.55 | 200 | 47.176 |
| 🇯🇵日本高速01 / CTCU / 0.5x | 203.10.99.34 | 200 | 49.177 |
| 🇭🇰香港高速01 / BGP / CMCU | 18.163.53.90 | 200 | 52.29 |
| 🇸🇬新加坡高速03 / BGP / CTCUCM | 66.90.98.36 | 200 | 54.725 |
| 🇯🇵日本高速05 / BGP / CUCM | 203.10.99.28 | 200 | 57.466 |
| 🇸🇬新加坡专线04 / BGP / 流媒体 | 18.140.237.235 | network_error | 63.683 |
| 🇯🇵日本专线03 / BGP / 流媒体 | 203.10.99.42 | network_error | 65.688 |
| 🇯🇵日本高速04 / BGP / CUCM | 203.10.99.27 | 200 | 67.695 |
| 🇨🇳台湾专线01 / BGP / 流媒体 | 211.20.18.216 | 541 | 84.546 |
| 🇯🇵日本高速07 / BGP / CTCU | 203.10.99.10 | 200 | 86.55 |

Evidence:

- Exit scan: `runtime/proxy-smoke-20261025-232420/report.json`
- Inventory results and raw successful responses: `runtime/proxy-smoke-20261025-232535/`
- Running Clash configuration and production monitor were unchanged. Private test process terminated and temporary credential config was removed.
