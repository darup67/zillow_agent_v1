# Zillow Agent

Daily real-estate market digest by ZIP code, emailed to darup67@gmail.com.
Zero dependencies (Node core only). Same house style as `~/flip-notifier`.

## Status

- **51 ZIPs** across 7 markets — ~10,000 for-sale + ~3,250 rental listings
  - Primary buy box (houses 2005+, $150k–750k): **3,934**
  - Condos & townhomes 1–2BR ($100k–450k): **389**
  - Rentals 1–2BR ($900–3,000/mo): **978**
  - Full run ~3.5 min
  - Atlanta intown: Intown East (4), Westside (4), South Intown (3), South Metro (2)
  - Exurbs: **Gwinnett County (19)**, **Hall County (10)**, **Jackson County (9)**
- Runs **daily at 7:30 AM** via launchd (`com.dhruv.zillowagent`); full run ~2.5 min
- Emails only when something changed (configurable)

County ZIPs were selected from the Census 2020 ZCTA-to-county relationship file,
including a ZIP when **>=50% of its land area** falls in the three-county region.
Duluth (30097), Snellville (30087) and Auburn (30011) are included by hand — they
sit at 43%/32%/26% but are markets you'd expect to see. Note 30607 is a Jackson
County ZIP by land but carries an **Athens** mailing address; drop it if Athens
inventory is noise.

## A note on the data source

Zillow has **no public API**, and its internal endpoints are hard-blocked by
PerimeterX (verified: HTTP 403 + captcha from this machine). Listing data
therefore comes from **Redfin's public `gis-csv` endpoint**, which returns the
same MLS-sourced inventory and responds reliably.

Queries go by **bounding box** (computed from bundled Census 2020 ZCTA centroids
in `zips.tsv`), then results are filtered to the **exact ZIP** client-side. This
sidesteps region-ID lookup, which is also blocked.

### Row cap and tiling (important)

The endpoint returns **at most 350 rows**. `num_homes` above 350 returns an empty
body, and `page_number` is silently ignored — every page repeats page 1. So a
dense ZIP would be quietly truncated, and because results sort newest-first the
rows dropped are the **oldest** ones — exactly the stale-and-reduced listings the
motivated-seller section depends on.

The agent handles this with an **adaptive quadtree**: any box returning >=348 rows
is split into four quadrants and re-fetched, recursively to depth 3 (up to 64
tiles). Results are unioned and deduped by MLS number. The per-ZIP log line shows
the tile count. Recovery is significant — 30043 went from 219 to 389 active
listings, 30316 from 198 to 278.

If you ever see `still at row cap at max depth` in the log, that ZIP is denser
than 64 tiles can cover; raise `MAX_DEPTH` in `zillow-agent.js`.

Because this reads a public endpoint rather than a contracted API, treat it as
best-effort: if a run starts returning empty, the endpoint shape likely changed.
`zillow-agent.log` will show it.

## Commands

```bash
node ~/zillow-agent/zillow-agent.js --dry-run   # fetch + write preview.html, no email, no state change
node ~/zillow-agent/zillow-agent.js --no-email  # fetch + update state, skip email
node ~/zillow-agent/zillow-agent.js             # full run (what launchd does)
node ~/zillow-agent/zillow-agent.js --reset     # wipe state; next run re-baselines
```

`--dry-run` is the one to use while tuning filters: open `preview.html` in a
browser to see exactly what the email would look like.

## Parameterization — `config.json`

Everything is in `config.json`. Edit, then `--dry-run` to see the effect.

### `markets`
Named groups of ZIPs. Add/remove freely; any US ZIP works.
```json
{ "name": "Intown East", "zips": ["30307", "30316", "30317", "30306"] }
```
Current: Intown East, Westside, South Intown, South Metro.

### `searches` — one section per search

The email renders **one top-level section per entry** in `searches`, each with its
own filters and its own change history. Add or remove entries freely.

| Field | Meaning |
|---|---|
| `id` | stable key for the state bucket — **do not rename**, it resets that section's baseline |
| `name` | section heading in the email |
| `shortName` | used in the subject line |
| `type` | `"sale"` or `"rental"` |
| `enabled` | set `false` to skip without deleting |
| `filters` | the filter set below |

Current searches: **Primary buy box** (houses 2005+), **Condos & townhomes 1–2BR**,
and **Rentals 1–2BR**.

For-sale data is fetched **once per ZIP and shared** across all `sale` searches, so
adding another sale search costs no extra requests.

### `filters` — which listings qualify
| Key | Effect |
|---|---|
| `minPrice` / `maxPrice` | price band (currently 150k–750k) |
| `minBeds` / `maxBeds` / `minBaths` | bed and bath bounds |
| `minRent` / `maxRent` | **rental only** — monthly rent band |
| `requireAvailableUnits` | **rental only** — drop communities with 0 units available |
| `minSqft` / `maxSqft` | size band |
| `minYearBuilt` / `maxYearBuilt` | vintage filter (**currently minYearBuilt 2005**) |
| `maxHoaMonthly` | drops high-HOA condos |
| `maxPricePerSqft` | hard $/sqft ceiling |
| `maxDaysOnMarket` | e.g. `7` = fresh inventory only |
| `propertyTypes` | exact Redfin strings (SFR, Townhouse, Condo/Co-op, Multi-Family…) |
| `excludeKeywords` | substring match on address/neighborhood |

`null` disables any filter.

**Missing-data policy:** a filter is skipped when the listing lacks that field, so
a home with no `YEAR BUILT` still passes `minYearBuilt` (~7.6% of inventory). This
is deliberate — better to show a listing than drop it over a blank MLS field. To
make it strict, remove the `l.yearBuilt != null &&` guard in `passesBuyBox()`.

### `signals` — what counts as an "update"
`newListings`, `priceCuts`, `priceIncreases`, `backOnMarket`, `statusChanges`,
`openHouses`, `goneFromMarket` (off by default — noisy).

### `dealScoring` — how deals are ranked
| Key | Effect |
|---|---|
| `discountVsZipMedianPct` | flag new listings this far under their ZIP's median $/sqft (default 8) |
| `priceCutMinPct` | ignore cuts smaller than this (default 2%) — kills noise |
| `staleDaysThreshold` | DOM above which a cut = motivated seller (default 45) |
| `maxRowsPerSection` | display cap per section (default 30) |

### `email`
`to`, `subjectPrefix`, and `sendWhenNothingNew` (false = stay quiet on flat days).

## Email layout

A contents strip at the top shows each section's update count, then one block per
search. Within a sale section: **★ Best value**, **🔥 Motivated sellers**, **New
listings**, **Price cuts**, **Price increases**, **Back on market**, **Status
changes**. Rental sections use **New rentals** / **Rent drops** / **Rent increases**
and skip deal scoring (there is no $/sqft median for rentals). A section with
nothing to report says "No changes today" rather than vanishing. **ZIP median
$/sqft** closes the email.

## Rentals

Rentals come from Redfin's `api/v1/search/rentals` (JSON, not CSV). It returns
every match inside the polygon in one response — `num_homes` is ignored — so no
tiling is needed. Most results are apartment **communities** carrying ranges
(1–2bd, $1,551–2,751, 6 units available) rather than single units, so rental rows
render as ranges and match a bed filter on **overlap**: a 0–1bd community satisfies
`minBeds: 1` because it contains 1-bed units.

## How change detection works

`state.json` holds a snapshot (price, status, DOM) keyed by MLS number. Each run
diffs fresh results against it, then overwrites it. So:

- The **first run is a baseline** — everything reads as "new".
- From day two, you only get genuine deltas.
- `--dry-run` never writes state, so it can't corrupt the baseline.

## Files

| File | Purpose |
|---|---|
| `zillow-agent.js` | engine: fetch, filter, diff, score, render |
| `send-email.js` | Gmail SMTP over TLS, HTML body (Keychain credential) |
| `config.json` | **your parameters** |
| `zips.tsv` | 33,144 US ZIP centroids + land area (Census 2020) |
| `state.json` | previous snapshot for diffing |
| `preview.html` | last `--dry-run` output |
| `zillow-agent.log` | run history |

## Scheduling

```bash
launchctl list | grep zillow                                     # check
launchctl unload ~/Library/LaunchAgents/com.dhruv.zillowagent.plist   # stop
launchctl load   ~/Library/LaunchAgents/com.dhruv.zillowagent.plist   # start
```

Change the time by editing `StartCalendarInterval` in the plist, then unload/load.
If the Mac is asleep at 7:30, launchd runs the job on next wake.

## Credentials

Reuses flip-notifier's Gmail app password from Keychain — nothing on disk:
```bash
security find-generic-password -a darup67@gmail.com -s flip-notifier-gmail -w
```
