# Coverage investigation — 2026-10-24

The initial production implementation used `/shop/sba/pickup-detail?product=<sku>&stores.0=<id>...` and got 12 stores even when 35 NJ/NY IDs were submitted. A single-store request for Garden State Plaza (`R117`) returned `body.content: []`.

The conclusion that 23 stores were unobservable was too broad. A comparison using `/shop/retail/pickup-message?pl=true&location=07078&parts.0=MK1E4LL/A` returned Short Hills, Willowbrook, Menlo Park, Rockaway, Garden State Plaza and Bridgewater, including explicit unavailable states. Changing the ZIP changed the returned roster. The response also included an `availabilityStores` field with the old 12-store roster, separate from `body.stores`; the monitor must inspect `body.stores` rather than treating that roster or the SBA detail endpoint as the full store directory. We cannot infer Apple's internal filtering implementation from these responses.

All 35 official target IDs were found across five captured regional queries:

| ZIP | Role | Region |
|---|---|---|
| 07078 | Primary | Short Hills / northern NJ |
| 10001 | Primary | NYC |
| 08002 | Secondary | Southern and central NJ |
| 11755 | Secondary | Long Island / Westchester |
| 13290 | Secondary | Upstate NY, with surrounding stores returned |

Local raw evidence is saved in ignored `runtime/coverage-investigation/retail-*.json`. The local commissioning test normalizes the five captures and asserts that their watched-store union equals all 35 target IDs. Extra areas were probed to find this smaller covering set. No query returned a rate-limit error in this investigation.

Production now uses `/shop/retail/pickup-message` with `location` and a batch of the two selected SKUs (`parts.0`, `parts.1`). One primary area and one secondary area rotate each cycle, so the request cap remains two inventory requests. The fixed white 256GB variant reaches all target stores over three cycles. Primary areas repeat every two cycles; secondary areas every three. Other variants remain random and have no fixed revisit guarantee.

Each region has its verified expected store IDs. A wrong returned location, missing expected store, missing SKU, or malformed availability status counts as a query failure. Unknown stores are not marked out of stock. `coverage_history` tracks when each SKU/store was actually observed; `fresh_coverage_counts` counts observations from the last ten minutes. Per-cycle coverage is not the same as a full rotation.

Historical statements such as “only one stock event today” apply only to the original 12-store coverage. The missing 23 stores' historical availability cannot be reconstructed from the old monitor logs.
