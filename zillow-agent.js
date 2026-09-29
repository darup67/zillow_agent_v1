#!/usr/bin/env node
/**
 * Zillow Agent — daily real-estate market digest by ZIP code.
 *
 * Zero dependencies. Follows the flip-notifier house style (node core only,
 * Gmail SMTP via Keychain, launchd scheduling).
 *
 * Usage:
 *   node zillow-agent.js              # fetch, diff, email, save state
 *   node zillow-agent.js --dry-run    # fetch + print digest, no email, no state write
 *   node zillow-agent.js --no-email   # fetch + diff + save state, skip email
 *   node zillow-agent.js --reset      # wipe state (next run treats everything as new)
 *   node zillow-agent.js --force      # save even if far fewer listings than last run
 *
 * Data sources:
 *   - Listings: Redfin gis-csv polygon search (bbox per ZIP, filtered to exact ZIP)
 *   - ZIP geometry: bundled Census 2020 ZCTA gazetteer centroids (zips.tsv)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { tagListings } = require('./jev-tags');

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
const BACKUP_PATH = path.join(DIR, 'state.backup.json');
const ZIPS_PATH = path.join(DIR, 'zips.tsv');
const LOG_PATH = path.join(DIR, 'zillow-agent.log');

const ARGS = new Set(process.argv.slice(2));
let SHOW_JEV = false;   // Jev tags: always in --dry-run preview, in email only when config.jev.showInEmail
const DRY_RUN = ARGS.has('--dry-run');
const NO_EMAIL = ARGS.has('--no-email') || DRY_RUN;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
}

/**
 * Roll the current state aside before anything overwrites or deletes it.
 *
 * State is the diff baseline: whatever it holds is what the NEXT run compares
 * against, so overwriting it consumes the pending diff. An unplanned run
 * therefore silently eats the day's changes with nothing to roll back to —
 * on 2026-09-07 an ad-hoc 22:24 run had to be reversed by reconstructing the
 * removals and pre-cut prices out of the digest email it had already sent.
 *
 * Keeps exactly one generation, which is all the daily cadence needs. Failure
 * is logged, not fatal: losing the backup must never cost the run itself.
 */
function backupState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      fs.copyFileSync(STATE_PATH, BACKUP_PATH);
      return true;
    }
  } catch (e) {
    log(`WARN could not back up state to ${BACKUP_PATH}: ${e.message}`);
  }
  return false;
}

/* ---------------------------------------------------------------- CSV parse */

// RFC4180-ish parser: handles quoted fields containing commas / escaped quotes.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const COL = {
  saleType: 0, soldDate: 1, propertyType: 2, address: 3, city: 4, state: 5,
  zip: 6, price: 7, beds: 8, baths: 9, location: 10, sqft: 11, lotSize: 12,
  yearBuilt: 13, dom: 14, ppsf: 15, hoa: 16, status: 17,
  ohStart: 18, ohEnd: 19, url: 20, source: 21, mls: 22, lat: 25, lng: 26,
};

function num(v) {
  if (v === undefined || v === null) return null;
  const n = parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------ ZIP geometry */

let ZIP_INDEX = null;
function loadZips() {
  if (ZIP_INDEX) return ZIP_INDEX;
  ZIP_INDEX = new Map();
  const raw = fs.readFileSync(ZIPS_PATH, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [zip, lat, lng, sqmi] = line.split('\t');
    ZIP_INDEX.set(zip, { lat: parseFloat(lat), lng: parseFloat(lng), sqmi: parseFloat(sqmi) });
  }
  return ZIP_INDEX;
}

// Bounding box sized to the ZIP's actual land area, padded 35% so irregular
// ZIP shapes are fully covered. Exact ZIP filtering happens after fetch.
function zipBox(zip) {
  const z = loadZips().get(zip);
  if (!z) return null;
  const sqmi = Math.max(z.sqmi || 1, 0.5);
  const halfSideMi = Math.sqrt(sqmi) / 2 * 1.35;
  const dLat = halfSideMi / 69;
  const dLng = halfSideMi / (69 * Math.cos(z.lat * Math.PI / 180));
  return { w: z.lng - dLng, e: z.lng + dLng, s: z.lat - dLat, n: z.lat + dLat };
}

const boxToPoly = b =>
  `${b.w.toFixed(6)} ${b.s.toFixed(6)},${b.e.toFixed(6)} ${b.s.toFixed(6)},` +
  `${b.e.toFixed(6)} ${b.n.toFixed(6)},${b.w.toFixed(6)} ${b.n.toFixed(6)},` +
  `${b.w.toFixed(6)} ${b.s.toFixed(6)}`;

const quadrants = b => {
  const mx = (b.w + b.e) / 2, my = (b.s + b.n) / 2;
  return [
    { w: b.w, e: mx, s: b.s, n: my }, { w: mx, e: b.e, s: b.s, n: my },
    { w: b.w, e: mx, s: my, n: b.n }, { w: mx, e: b.e, s: my, n: b.n },
  ];
};

/* ---------------------------------------------------------------- fetching */

// Redfin caps gis-csv at 350 rows; num_homes above that returns an empty body
// and page_number is ignored. So a box that comes back full is assumed
// truncated and gets split into quadrants (see fetchZip).
const ROW_CAP = 350;
const CAP_TRIGGER = 348;   // treat as truncated at/above this
const MAX_DEPTH = 3;       // up to 64 tiles for the densest ZIPs

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'user-agent': UA,
        'accept': 'text/csv,application/csv,*/*',
        'accept-language': 'en-US,en;q=0.9',
        'referer': 'https://www.redfin.com/',
      },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// Fetch one box. Returns every parsed row (no ZIP filter) so the caller can
// judge truncation against the true row count.
async function fetchBox(box, cfg) {
  const qs = new URLSearchParams({
    al: '1',
    num_homes: String(ROW_CAP),
    ord: 'days-on-redfin-asc',
    page_number: '1',
    poly: boxToPoly(box),
    sf: '1,2,3,5,6,7',
    status: '9',
    uipt: '1,2,3,4,5,6,7,8',
    v: '8',
  });
  const url = `https://www.redfin.com/stingray/api/gis-csv?${qs}`;

  let lastErr;
  for (let attempt = 1; attempt <= cfg.fetch.retries; attempt++) {
    try {
      const rows = parseCSV(await httpGet(url, cfg.fetch.timeoutMs));
      const out = [];
      for (const r of rows) {
        if (r.length < 20) continue;                    // disclaimer / blank
        if (r[COL.saleType] === 'SALE TYPE') continue;  // header
        out.push(r);
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (attempt < cfg.fetch.retries) await sleep(1500 * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

// Adaptive quadtree: split any box that comes back at the row cap, so dense
// ZIPs aren't silently truncated. Results are unioned and deduped by MLS#.
async function fetchZip(zip, cfg) {
  const root = zipBox(zip);
  if (!root) { log(`  ! ${zip}: unknown ZIP (not in zips.tsv), skipping`); return { listings: [], tiles: 0 }; }

  const byId = new Map();
  let tiles = 0, truncated = false;
  const queue = [{ box: root, depth: 0 }];

  while (queue.length) {
    const { box, depth } = queue.shift();
    let rows;
    try {
      rows = await fetchBox(box, cfg);
    } catch (e) {
      log(`  ! ${zip}: tile fetch failed (${e.message})`);
      continue;
    }
    tiles++;

    if (rows.length >= CAP_TRIGGER && depth < MAX_DEPTH) {
      for (const q of quadrants(box)) queue.push({ box: q, depth: depth + 1 });
      await sleep(cfg.fetch.delayMsBetweenTiles || 700);
      continue;                     // discard: the quadrants will re-cover it
    }
    if (rows.length >= CAP_TRIGGER) truncated = true;  // still full at max depth

    for (const r of rows) {
      if (String(r[COL.zip]).trim() !== zip) continue;  // exact ZIP only
      const l = normalize(r);
      if (!byId.has(l.id)) byId.set(l.id, l);
    }
    if (queue.length) await sleep(cfg.fetch.delayMsBetweenTiles || 700);
  }

  if (truncated) log(`  ! ${zip}: still at row cap at max depth — may be incomplete`);
  return { listings: [...byId.values()], tiles };
}

function normalize(r) {
  const price = num(r[COL.price]);
  const sqft = num(r[COL.sqft]);
  return {
    id: (r[COL.mls] && r[COL.mls].trim()) || r[COL.url],
    address: r[COL.address],
    city: r[COL.city],
    zip: String(r[COL.zip]).trim(),
    propertyType: r[COL.propertyType],
    price,
    beds: num(r[COL.beds]),
    baths: num(r[COL.baths]),
    sqft,
    lotSize: num(r[COL.lotSize]),
    yearBuilt: num(r[COL.yearBuilt]),
    dom: num(r[COL.dom]),
    ppsf: num(r[COL.ppsf]) || (price && sqft ? Math.round(price / sqft) : null),
    hoa: num(r[COL.hoa]),
    status: r[COL.status],
    openHouse: r[COL.ohStart] || null,
    url: r[COL.url],
    location: r[COL.location],
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- rentals */

// Rentals come from a different endpoint that returns JSON, not CSV, and are
// mostly apartment COMMUNITIES with ranges (1-2bd, $1551-2751) rather than
// single units. It returns everything inside the polygon in one response —
// num_homes is ignored — so no tiling is needed.
async function fetchRentalsZip(zip, cfg) {
  const box = zipBox(zip);
  if (!box) return [];
  const qs = new URLSearchParams({
    al: '1', num_homes: '350', poly: boxToPoly(box), v: '8',
  });
  const url = `https://www.redfin.com/stingray/api/v1/search/rentals?${qs}`;

  for (let attempt = 1; attempt <= cfg.fetch.retries; attempt++) {
    try {
      const raw = await httpGet(url, cfg.fetch.timeoutMs);
      const j = JSON.parse(raw.replace(/^\{\}&&/, ''));
      const out = [];
      for (const h of (j.homes || [])) {
        const r = normalizeRental(h);
        if (r && r.zip === zip) out.push(r);
      }
      return out;
    } catch (e) {
      if (attempt < cfg.fetch.retries) await sleep(1500 * Math.pow(2, attempt - 1));
      else log(`  ! ${zip}: rental fetch failed (${e.message})`);
    }
  }
  return [];
}

function normalizeRental(h) {
  const d = h.homeData || {}, r = h.rentalExtension || {};
  const a = d.addressInfo || {};
  if (!r.rentalId && !d.propertyId) return null;
  const rentMin = r.rentPriceRange?.min ?? null;
  const rentMax = r.rentPriceRange?.max ?? null;
  return {
    kind: 'rental',
    id: r.rentalId || `p${d.propertyId}`,
    name: r.propertyName || a.formattedStreetLine || 'Rental',
    address: a.formattedStreetLine || '',
    city: a.city || '',
    zip: String(a.zip || '').trim(),
    bedMin: r.bedRange?.min ?? null,
    bedMax: r.bedRange?.max ?? null,
    bathMin: r.bathRange?.min ?? null,
    sqftMin: r.sqftRange?.min ?? null,
    sqftMax: r.sqftRange?.max ?? null,
    rentMin, rentMax,
    price: rentMin,                       // canonical field for diffing
    units: r.numAvailableUnits ?? null,
    status: String(r.status ?? ''),
    url: d.url ? `https://www.redfin.com${d.url}` : null,
  };
}

/* ------------------------------------------------------------- filtering */

// One filter function for both kinds. A filter is skipped when the listing
// lacks that field — better to show a listing than drop it over a blank field.
function passesFilters(l, f) {
  if (!f) return true;

  if (l.kind === 'rental') {
    // Bed ranges overlap-match: a 1-2bd community satisfies "1-2 bedrooms".
    if (f.minBeds != null && l.bedMax != null && l.bedMax < f.minBeds) return false;
    if (f.maxBeds != null && l.bedMin != null && l.bedMin > f.maxBeds) return false;
    if (f.minRent != null && l.rentMax != null && l.rentMax < f.minRent) return false;
    if (f.maxRent != null && l.rentMin != null && l.rentMin > f.maxRent) return false;
    if (f.minSqft != null && l.sqftMax != null && l.sqftMax < f.minSqft) return false;
    if (f.requireAvailableUnits && !(l.units > 0)) return false;
    return true;
  }

  if (f.minPrice != null && (l.price == null || l.price < f.minPrice)) return false;
  if (f.maxPrice != null && (l.price == null || l.price > f.maxPrice)) return false;
  if (f.minBeds != null && (l.beds == null || l.beds < f.minBeds)) return false;
  if (f.maxBeds != null && l.beds != null && l.beds > f.maxBeds) return false;
  if (f.minBaths != null && (l.baths == null || l.baths < f.minBaths)) return false;
  if (f.minSqft != null && l.sqft != null && l.sqft < f.minSqft) return false;
  if (f.maxSqft != null && l.sqft != null && l.sqft > f.maxSqft) return false;
  if (f.minYearBuilt != null && l.yearBuilt != null && l.yearBuilt < f.minYearBuilt) return false;
  if (f.maxYearBuilt != null && l.yearBuilt != null && l.yearBuilt > f.maxYearBuilt) return false;
  if (f.maxHoaMonthly != null && l.hoa != null && l.hoa > f.maxHoaMonthly) return false;
  if (f.maxPricePerSqft != null && l.ppsf != null && l.ppsf > f.maxPricePerSqft) return false;
  if (f.maxDaysOnMarket != null && l.dom != null && l.dom > f.maxDaysOnMarket) return false;
  if (Array.isArray(f.propertyTypes) && f.propertyTypes.length &&
      !f.propertyTypes.includes(l.propertyType)) return false;
  if (Array.isArray(f.excludeKeywords)) {
    const hay = `${l.address} ${l.location || ''}`.toLowerCase();
    for (const kw of f.excludeKeywords) {
      if (kw && hay.includes(String(kw).toLowerCase())) return false;
    }
  }
  return true;
}

/* --------------------------------------------------------------- analysis */

function median(nums) {
  const a = nums.filter(n => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

// Diff one search's current listings against that search's own prior snapshot.
function diff(current, prev, cfg) {
  const sig = cfg.signals;
  const cut = cfg.dealScoring.priceCutMinPct;
  const out = { new: [], priceCuts: [], priceIncreases: [], backOnMarket: [], statusChanges: [], gone: [] };

  for (const l of current) {
    const p = prev[l.id];
    if (!p) { if (sig.newListings) out.new.push(l); continue; }

    if (p.price != null && l.price != null && l.price !== p.price) {
      const pct = ((l.price - p.price) / p.price) * 100;
      if (Math.abs(pct) >= cut) {
        const rec = { ...l, prevPrice: p.price, changePct: pct };
        if (pct < 0 && sig.priceCuts) out.priceCuts.push(rec);
        else if (pct > 0 && sig.priceIncreases) out.priceIncreases.push(rec);
      }
    }
    if (sig.backOnMarket && p.status && l.status &&
        /pending|contingent|under contract/i.test(p.status) && /active|for sale/i.test(l.status)) {
      out.backOnMarket.push({ ...l, prevStatus: p.status });
    } else if (sig.statusChanges && p.status && l.status && p.status !== l.status) {
      out.statusChanges.push({ ...l, prevStatus: p.status });
    }
  }

  if (sig.goneFromMarket) {
    const seen = new Set(current.map(l => l.id));
    for (const id of Object.keys(prev)) if (!seen.has(id)) out.gone.push(prev[id]);
  }
  return out;
}

function scoreDeals(current, changes, cfg, enabled) {
  if (!enabled || !cfg.dealScoring.enabled) return { underMedian: [], motivated: [], medians: new Map() };

  const byZip = new Map();
  for (const l of current) {
    if (l.ppsf == null) continue;
    if (!byZip.has(l.zip)) byZip.set(l.zip, []);
    byZip.get(l.zip).push(l.ppsf);
  }
  const medians = new Map();
  for (const [zip, arr] of byZip) medians.set(zip, median(arr));

  const threshold = cfg.dealScoring.discountVsZipMedianPct;
  const underMedian = [];
  for (const l of changes.new) {
    const med = medians.get(l.zip);
    if (!med || l.ppsf == null) continue;
    const disc = ((med - l.ppsf) / med) * 100;
    if (disc >= threshold) underMedian.push({ ...l, zipMedianPpsf: med, discountPct: disc });
  }
  underMedian.sort((a, b) => b.discountPct - a.discountPct);

  const stale = cfg.dealScoring.staleDaysThreshold;
  const motivated = changes.priceCuts
    .filter(l => l.dom != null && l.dom >= stale)
    .sort((a, b) => a.changePct - b.changePct);

  return { underMedian, motivated, medians };
}

/* ---------------------------------------------------------------- render */

const fmtMoney = n => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function detailLine(l) {
  const b = [];
  if (l.kind === 'rental') {
    if (l.bedMin != null) b.push(l.bedMin === l.bedMax ? `${l.bedMin}bd` : `${l.bedMin}-${l.bedMax}bd`);
    if (l.bathMin != null) b.push(`${l.bathMin}+ba`);
    if (l.sqftMin != null) b.push(l.sqftMin === l.sqftMax
      ? `${l.sqftMin.toLocaleString('en-US')} sqft`
      : `${l.sqftMin.toLocaleString('en-US')}-${(l.sqftMax || 0).toLocaleString('en-US')} sqft`);
    if (l.units != null) b.push(`${l.units} unit${l.units === 1 ? '' : 's'} avail`);
    return b.join(' &middot; ');
  }
  if (l.beds != null) b.push(`${l.beds}bd`);
  if (l.baths != null) b.push(`${l.baths}ba`);
  if (l.sqft != null) b.push(`${l.sqft.toLocaleString('en-US')} sqft`);
  if (l.ppsf != null) b.push(`$${l.ppsf}/sqft`);
  if (l.yearBuilt != null) b.push(`built ${l.yearBuilt}`);
  if (l.dom != null) b.push(`${l.dom}d on mkt`);
  if (l.hoa != null && l.hoa > 0) b.push(`HOA ${fmtMoney(l.hoa)}/mo`);
  return b.join(' &middot; ');
}

function priceCell(l) {
  let main;
  if (l.kind === 'rental') {
    main = l.rentMin == null ? '—'
      : (l.rentMin === l.rentMax || l.rentMax == null)
        ? `${fmtMoney(l.rentMin)}/mo`
        : `${fmtMoney(l.rentMin)}–${fmtMoney(l.rentMax)}/mo`;
  } else main = fmtMoney(l.price);

  let out = `<strong>${main}</strong>`;
  if (l.prevPrice != null) {
    const arrow = l.changePct < 0 ? '&#9660;' : '&#9650;';
    const color = l.changePct < 0 ? '#1a7f37' : '#b35900';
    out += `<div style="color:${color};font-size:12px">${arrow} ${Math.abs(l.changePct).toFixed(1)}% ` +
           `from ${fmtMoney(l.prevPrice)}</div>`;
  }
  return out;
}

function tableFor(listings, cfg, opts = {}) {
  const cap = cfg.dealScoring.maxRowsPerSection;
  const rows = listings.slice(0, cap).map(l => {
    let badge = '';
    if (opts.showDiscount && l.discountPct != null) {
      badge += `<div style="font-size:12px;color:#1a7f37">${l.discountPct.toFixed(0)}% under ` +
               `ZIP median ($${l.zipMedianPpsf}/sqft)</div>`;
    }
    if (l.prevStatus) badge += `<div style="font-size:12px;color:#555">${esc(l.prevStatus)} &rarr; ${esc(l.status)}</div>`;
    if (SHOW_JEV && l.jevTags && l.jevTags.length) {
      badge += `<div style="font-size:12px;color:#6b4fbb">Jev: ${l.jevTags.map(esc).join(' &middot; ')}</div>`;
    }
    if (l.openHouse) badge += `<div style="font-size:12px;color:#0b62c4">Open house: ${esc(l.openHouse)}</div>`;
    const title = l.kind === 'rental' ? (l.name || l.address) : l.address;
    const sub = l.kind === 'rental' && l.name && l.address && l.name !== l.address ? esc(l.address) + ' &middot; ' : '';
    return `<tr>
  <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top">
    ${l.url ? `<a href="${esc(l.url)}" style="color:#0b62c4;text-decoration:none;font-weight:600">${esc(title)}</a>`
            : `<span style="font-weight:600">${esc(title)}</span>`}
    <div style="color:#666;font-size:12px">${sub}${esc(l.city)} ${esc(l.zip)}${l.location ? ' &middot; ' + esc(l.location) : ''}</div>
    <div style="color:#444;font-size:12px;margin-top:3px">${detailLine(l)}</div>
    ${badge}
  </td>
  <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;vertical-align:top;white-space:nowrap">${priceCell(l)}</td>
</tr>`;
  }).join('\n');

  const more = listings.length > cap
    ? `<div style="font-size:12px;color:#666;padding:6px 8px">+ ${listings.length - cap} more not shown</div>` : '';
  return `<table style="width:100%;border-collapse:collapse;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px">${rows}</table>${more}`;
}

function subSection(title, listings, cfg, opts) {
  if (!listings || !listings.length) return '';
  return `<h3 style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;
    margin:18px 0 4px;color:#333">${title}
    <span style="color:#999;font-weight:400">(${listings.length})</span></h3>` + tableFor(listings, cfg, opts);
}

// Each search renders as its own top-level section with its own sub-sections.
function renderSearchBlock(s, res, cfg) {
  const c = res.changes, d = res.deals;
  let body = '';
  body += subSection('&#9733; Best value &mdash; new &amp; under ZIP median', d.underMedian, cfg, { showDiscount: true });
  body += subSection('&#128293; Motivated sellers &mdash; stale &amp; reduced', d.motivated, cfg);
  body += subSection(s.type === 'rental' ? 'New rentals' : 'New listings', c.new, cfg);
  body += subSection(s.type === 'rental' ? 'Rent drops' : 'Price cuts', c.priceCuts, cfg);
  body += subSection(s.type === 'rental' ? 'Rent increases' : 'Price increases', c.priceIncreases, cfg);
  body += subSection('Back on market', c.backOnMarket, cfg);
  body += subSection('Status changes', c.statusChanges, cfg);
  body += subSection('Left the market', c.gone, cfg);

  const n = res.changeCount;
  const header = `<h2 style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:17px;
    margin:30px 0 2px;padding:8px 10px;background:#f3f4f6;border-left:4px solid #111;border-radius:3px">
    ${esc(s.name)}
    <span style="color:#777;font-weight:400;font-size:13px"> &middot; ${res.tracked} tracked &middot; ${n} update${n === 1 ? '' : 's'}</span></h2>`;

  if (!body) {
    return header + `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;
      font-size:13px;color:#888;padding:8px 10px">No changes today.</div>`;
  }
  return header + body;
}

function renderEmail(results, cfg, stats, strResults = []) {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  let body = `<div style="max-width:720px;margin:0 auto;padding:16px">
<h1 style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:20px;margin:0">
  ${esc(cfg.email.subjectPrefix)}</h1>
<div style="color:#666;font-size:13px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;margin-top:2px">
  ${date} &middot; ${stats.zipCount} ZIPs &middot; ${results.length} searches</div>`;

  // Contents strip so each section is findable at a glance.
  body += `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;
    color:#555;margin-top:10px;padding:8px 10px;background:#fafafa;border:1px solid #eee;border-radius:3px">` +
    results.map(r => `${esc(r.search.name)}: <strong>${r.changeCount}</strong>`).join(' &nbsp;|&nbsp; ') + `</div>`;

  for (const r of results) body += renderSearchBlock(r.search, r, cfg);

  // Standing cash-flow screen — its own block, deliberately after and visually
  // separate from the change-feed sections above.
  if (strResults.length) {
    body += `<div style="margin:34px 0 0;border-top:3px double #1a7f37"></div>`;
    for (const r of strResults) body += renderStrBlock(r.search, r);
  }

  // ZIP median context from the first sale search that produced medians.
  const withMed = results.find(r => r.deals.medians && r.deals.medians.size);
  if (withMed) {
    const rows = [...withMed.deals.medians.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([zip, med]) => `<tr><td style="padding:4px 10px 4px 0">${zip}</td>
        <td style="padding:4px 0;text-align:right">$${med}/sqft</td></tr>`).join('');
    body += `<h2 style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;
      margin:26px 0 6px;padding-bottom:5px;border-bottom:2px solid #111">ZIP median $/sqft (active inventory)</h2>
      <table style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;color:#333">${rows}</table>`;
  }

  body += `<div style="margin-top:28px;padding-top:10px;border-top:1px solid #ddd;color:#888;font-size:11px;
    font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
    Listing and rental data via Redfin. Tune each search in <code>~/zillow-agent/config.json</code>.</div></div>`;
  return body;
}

/* ------------------------------------------------------ STR cash-flow screen */

// Long-term rent comps by ZIP + bedroom count, built from the rental pool this
// run already fetched. A complex advertising a 1-2 bed range contributes its low
// rent to the low bed count and its high rent to the high one.
function buildRentComps(rentals) {
  const buckets = new Map();
  const add = (zip, beds, rent) => {
    if (!zip || beds == null || !rent) return;
    const k = `${zip}|${Math.round(beds)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(rent);
  };
  for (const r of rentals) {
    if (!r.zip) continue;
    const bLo = r.bedMin, bHi = r.bedMax ?? r.bedMin;
    const rLo = r.rentMin, rHi = r.rentMax ?? r.rentMin;
    if (bLo == null || rLo == null) continue;
    if (bHi === bLo) add(r.zip, bLo, (rLo + (rHi ?? rLo)) / 2);
    else { add(r.zip, bLo, rLo); add(r.zip, bHi, rHi); }
  }
  const comps = new Map();
  for (const [k, arr] of buckets) comps.set(k, { median: median(arr), n: arr.length });
  return comps;
}

// Nearest usable comp: exact ZIP+beds, else one bedroom either way, scaled.
// Returns null rather than guessing when the ZIP has too few rentals to trust.
function rentFor(comps, zip, beds, minN) {
  if (beds == null) return null;
  const b = Math.round(beds);
  for (const cand of [b, b - 1, b + 1]) {
    const c = comps.get(`${zip}|${cand}`);
    if (c && c.n >= minN && c.median) {
      const scale = cand === b ? 1 : b / cand;
      return { rent: Math.round(c.median * scale), n: c.n, beds: cand, exact: cand === b };
    }
  }
  return null;
}

// Ranks candidates on rent-to-price (the "1% rule") plus entry discount vs the
// ZIP's median $/sqft. Anything without a trustworthy rent comp is dropped, not
// guessed at.
function screenStr(matched, comps, s) {
  const cf = s.cashflow || {};
  const minN = cf.minRentComps ?? 4;

  const byZip = new Map();
  for (const l of matched) {
    if (l.ppsf == null) continue;
    if (!byZip.has(l.zip)) byZip.set(l.zip, []);
    byZip.get(l.zip).push(l.ppsf);
  }
  const medians = new Map();
  for (const [z, a] of byZip) medians.set(z, median(a));

  const unitsFor = (l) => {
    if (/Multi-Family \(2-4/.test(l.propertyType || '')) return cf.duplexUnits ?? 2;
    if (/Multi-Family \(5\+/.test(l.propertyType || '')) return cf.plexUnits ?? 5;
    return 1;
  };
  const rows = [];
  let noComp = 0;
  for (const l of matched) {
    if (!l.price) continue;
    const rawUnits = unitsFor(l);
    const unitsTrusted = l.beds != null && l.beds >= rawUnits;
    const units = unitsTrusted ? rawUnits : 1;
    const perUnitBeds = units > 1 && l.beds ? Math.max(1, Math.round(l.beds / units)) : l.beds;
    const rc = rentFor(comps, l.zip, perUnitBeds, minN);
    if (!rc) { noComp++; continue; }
    const grossRent = rc.rent * units;
    const ltrRatio = (grossRent / l.price) * 100;
    if (cf.minRentToPricePct != null && ltrRatio < cf.minRentToPricePct) continue;
    const hoa = l.hoa || 0;
    const zipMed = medians.get(l.zip);
    const disc = (zipMed && l.ppsf) ? ((zipMed - l.ppsf) / zipMed) * 100 : 0;
    // STR gross is an ASSUMPTION — long-term rent x uplift x occupancy. There is
    // no nightly-rate or occupancy feed here; see the note the email carries.
    const strGross = Math.round(grossRent * (cf.strUpliftFactor ?? 1.6) * (cf.strOccupancy ?? 0.65));
    const condRatio = (zipMed && l.ppsf) ? l.ppsf / zipMed : null;
    const floor = cf.conditionFloor ?? 0.60;
    const tier = (condRatio != null && condRatio < floor) ? 'rehab' : 'ready';
    // Cap the ratio term: beyond ~2%/mo the number reflects a bad comp or a
    // distressed asset, not a better deal, so it must not dominate the sort.
    const ratioTerm = Math.min(ltrRatio, cf.ratioScoreCap ?? 2.0) * 10;
    const score = ratioTerm + disc * (cf.entryDiscountWeight ?? 0.6) - hoa / 25;
    const flags = [];
    if (units > 1) flags.push(`modeled as ${units} units @ ${perUnitBeds}bd each`);
    if (rawUnits > 1 && !unitsTrusted) flags.push(
      `listed ${esc(l.propertyType || "multi-unit")} but only ${l.beds ?? "?"}bd — unit count unclear, modeled as ONE unit`);
    const sharedMinBeds = cf.sharedLivingMinBeds ?? 4;
    const shared = l.beds != null && l.beds >= sharedMinBeds &&
                   (l.baths == null || l.beds > l.baths);
    if (shared) flags.push(`${l.beds}bd shared-living / rent-by-room candidate`);
    if (condRatio != null && condRatio < 0.75) flags.push(`priced ${Math.round((1 - condRatio) * 100)}% below ZIP $/sqft — verify condition`);
    if (l.yearBuilt != null && l.yearBuilt < 1970) flags.push(`built ${l.yearBuilt}`);
    if (l.dom != null && l.dom >= 90) flags.push(`${l.dom}d on market`);
    rows.push({ ...l, estRent: grossRent, unitRent: rc.rent, units, rawUnits, unitsTrusted, perUnitBeds, shared, rentComps: rc.n, rentExact: rc.exact, rentBeds: rc.beds,
                ltrRatio, strGross, strRatio: (strGross / l.price) * 100,
                zipMedianPpsf: zipMed, discountPct: disc, condRatio, tier, flags, score });
  }
  rows.sort((a, b) => b.score - a.score);
  const rehab = rows.filter(r => r.tier === 'rehab');
  const ok = rows.filter(r => r.tier !== 'rehab');
  const multi = ok.filter(r => r.units > 1 || r.rawUnits > 1);
  const shared = ok.filter(r => r.units === 1 && r.rawUnits === 1 && r.shared);
  const ready = ok.filter(r => r.units === 1 && r.rawUnits === 1 && !r.shared);
  const cap = cf.maxRows ?? 12;
  const typeMix = {};
  for (const r of ok) typeMix[r.propertyType || 'Unknown'] = (typeMix[r.propertyType || 'Unknown'] || 0) + 1;
  return {
    rows: ready.slice(0, cap), total: ready.length,
    multiRows: multi.slice(0, cf.maxMultiRows ?? 8), multiTotal: multi.length,
    sharedRows: shared.slice(0, cf.maxSharedRows ?? 8), sharedTotal: shared.length,
    rehabRows: rehab.slice(0, cf.maxRehabRows ?? 6), rehabTotal: rehab.length,
    typeMix, screened: matched.length, noComp, medians };
}

function strRow(l, i) {
  const rentNote = l.rentExact ? `${l.rentComps} comps` : `${l.rentComps} comps @ ${l.rentBeds}bd, scaled`;
  const discTxt = l.discountPct >= 1
    ? `<span style="color:#1a7f37">${l.discountPct.toFixed(0)}% under ZIP ${l.zipMedianPpsf}/sqft</span>`
    : (l.zipMedianPpsf ? `<span style="color:#888">at ZIP ${l.zipMedianPpsf}/sqft</span>` : '');
  const flagTxt = (l.flags && l.flags.length)
    ? `<div style="font-size:11px;color:#b35900;margin-top:3px">&#9888; ${l.flags.map(esc).join(" &middot; ")}</div>`
    : '';
  return `<tr>
  <td style="padding:10px 6px;border-bottom:1px solid #e5e7eb;vertical-align:top;color:#999;font-size:12px">${i + 1}</td>
  <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top">
    <a href="${esc(l.url)}" style="color:#0b62c4;text-decoration:none;font-weight:600">${esc(l.address || "Undisclosed address")}</a>
    <div style="color:#666;font-size:12px">${esc(l.city || "")} ${esc(l.zip)} &middot; ${esc(l.propertyType || "")}</div>
    <div style="color:#444;font-size:12px;margin-top:3px">${detailLine(l)}</div>
    <div style="font-size:12px;margin-top:3px">${discTxt}</div>
    ${flagTxt}
  </td>
  <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;vertical-align:top;white-space:nowrap">
    <strong>${fmtMoney(l.price)}</strong>
    <div style="font-size:12px;color:#444;margin-top:3px">LTR ~${fmtMoney(l.estRent)}/mo</div>
    <div style="font-size:11px;color:#888">${rentNote}</div>
    <div style="font-size:13px;color:#1a7f37;font-weight:600;margin-top:4px">${l.ltrRatio.toFixed(2)}% rent/price</div>
    <div style="font-size:11px;color:#777">STR est ${fmtMoney(l.strGross)}/mo</div>
  </td>
</tr>`;
}

function renderStrBlock(s, res) {
  const cf = s.cashflow || {};
  const head = `<h2 style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:17px;
    margin:38px 0 2px;padding:9px 10px;background:#0f2e1d;color:#eafff2;
    border-left:4px solid #1a7f37;border-radius:3px">
    ${esc(s.name)}
    <span style="color:#9fd4b4;font-weight:400;font-size:13px"> &middot; ${res.total} rent-ready &middot; ${res.multiTotal} multi-unit &middot; ${res.sharedTotal} shared-living &middot; ${res.rehabTotal} rehab</span></h2>`;

  if (!res.rows.length && !res.multiRows?.length && !res.sharedRows?.length && !res.rehabRows?.length) {
    return head + `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;
      font-size:13px;color:#888;padding:8px 10px">No candidates cleared the cash-flow screen today.</div>`;
  }

  const rows = res.rows.map(strRow).join('\n');


  const assumptions = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:11px;
    color:#7a5c00;background:#fff8e1;border:1px solid #ffe08a;border-radius:3px;padding:8px 10px;margin-top:10px">
    <strong>How to read this.</strong> "LTR" is the median asking rent for that ZIP and bedroom count from
    today's live rental listings — it is a <em>long-term</em> rent, the only rent data this feed carries.
    "rent/price" is monthly rent over purchase price (1.00% = the 1% rule).
    <strong>"STR est" is an assumption, not data</strong>: long-term rent &times; ${(cf.strUpliftFactor ?? 1.6)} uplift
    &times; ${Math.round((cf.strOccupancy ?? 0.65) * 100)}% occupancy. There is no nightly-rate or occupancy
    feed here — verify against AirDNA or comparable listings before underwriting.
    Figures are gross: taxes, insurance, management, furnishing and vacancy are not deducted.
    <strong>Check STR legality per address</strong> — City of Atlanta requires a short-term rental licence and
    limits permits to a primary residence plus one additional unit, which constrains an LLC holding several;
    county and HOA rules differ.</div>`;

  const tbl = (r) => `<table style="width:100%;border-collapse:collapse;
    font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px">${r}</table>`;

  // Rehab tier: deep-discount stock where the rent comp assumes a condition the
  // property does not have. Shown, but never mixed into the rent-ready ranking.
  let rehab = '';
  if (res.rehabRows && res.rehabRows.length) {
    rehab = `<h3 style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;
      margin:22px 0 4px;color:#b35900">&#128736; Value-add / rehab required
      <span style="color:#999;font-weight:400"> &middot; ${res.rehabTotal} found, showing ${res.rehabRows.length}</span></h3>
      <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:11px;color:#777;margin-bottom:6px">
      Priced under ${Math.round((s.cashflow?.conditionFloor ?? 0.6) * 100)}% of their ZIP median $/sqft. The rent figures below
      assume a renovated, rentable property &mdash; treat them as <em>post-rehab</em>, not as-is.</div>`
      + tbl(res.rehabRows.map(strRow).join('\n'));
  }

  const sub = (icon, title, note, rws, shown, tot, color) => rws && rws.length
    ? `<h3 style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;
        margin:22px 0 4px;color:${color}">${icon} ${title}
        <span style="color:#999;font-weight:400"> &middot; ${tot} found, showing ${shown}</span></h3>
        ${note ? `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:11px;color:#777;margin-bottom:6px">${note}</div>` : ''}`
      + tbl(rws.map(strRow).join('\n'))
    : '';

  const multi = sub("&#127968;", "Duplex &amp; multi-unit",
    "Redfin has no duplex type &mdash; these are its Multi-Family classes. Rent is modeled per unit and summed, " +
    "so verify the actual unit count and whether all units are vacant or tenanted.",
    res.multiRows, res.multiRows?.length, res.multiTotal, '#0b62c4');

  const sharedSec = sub("&#128101;", "Shared living / rent-by-room",
    "4+ bedrooms with more bedrooms than baths &mdash; the rent-by-room shape. Rent shown is a whole-house " +
    "comp, which usually <em>understates</em> per-room income and ignores the higher management load.",
    res.sharedRows, res.sharedRows?.length, res.sharedTotal, '#6b3fa0');

  const readyHead = `<h3 style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;
    margin:14px 0 4px;color:#1a7f37">&#10003; Rent-ready candidates
    <span style="color:#999;font-weight:400"> &middot; ${res.total} found, showing ${res.rows.length}</span></h3>`;

  return head + readyHead + tbl(rows) + multi + sharedSec + rehab + assumptions;
}

/* ------------------------------------------------------------------ main */

// Older configs had a single top-level buyBox; treat that as one sale search.
function loadSearches(cfg) {
  if (Array.isArray(cfg.searches) && cfg.searches.length) {
    return cfg.searches.filter(s => s.enabled !== false);
  }
  return [{ id: 'primary', name: 'Primary buy box', type: 'sale', filters: cfg.buyBox }];
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  if (ARGS.has('--reset')) {
    const saved = backupState();
    try { fs.unlinkSync(STATE_PATH); } catch {}
    log(`state reset${saved ? ` (previous state kept in ${path.basename(BACKUP_PATH)})` : ''}`);
    return;
  }

  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
  const firstRun = !state.lastRun;
  // Migrate a pre-searches flat state into the primary search's bucket.
  if (state.listings && !state.searches) state = { lastRun: state.lastRun, searches: { primary: state.listings } };
  state.searches = state.searches || {};

  const allSearches = loadSearches(cfg);
  // Rank-mode searches (the STR screen) are a standing ranked list, not a change
  // feed: they never diff, never touch state, and render in their own block.
  const searches = allSearches.filter(x => x.mode !== 'rank');
  const rankSearches = allSearches.filter(x => x.mode === 'rank');
  const needSale = allSearches.some(s => s.type !== 'rental');
  const needRental = allSearches.some(s => s.type === 'rental');
  const allZips = cfg.markets.flatMap(m => m.zips);
  log(`fetching ${allZips.length} ZIPs · ${allSearches.length} searches` +
      ` (${needSale ? 'sale' : ''}${needSale && needRental ? '+' : ''}${needRental ? 'rental' : ''})`);

  // Fetch each ZIP once and share the pool across every search of that kind.
  const salePool = [], rentPool = [];
  let totalTiles = 0;
  for (const zip of allZips) {
    let sN = 0, rN = 0;
    if (needSale) {
      const { listings, tiles } = await fetchZip(zip, cfg);
      totalTiles += tiles; sN = listings.length;
      salePool.push(...listings);
    }
    if (needRental) {
      if (needSale) await sleep(cfg.fetch.delayMsBetweenTiles || 700);
      const r = await fetchRentalsZip(zip, cfg);
      rN = r.length; rentPool.push(...r);
    }
    log(`  ${zip}: ${sN} for-sale, ${rN} rental`);
    if (zip !== allZips[allZips.length - 1]) await sleep(cfg.fetch.delayMsBetweenZips);
  }

  const dedupe = arr => { const s = new Set(); return arr.filter(l => s.has(l.id) ? false : (s.add(l.id), true)); };
  const sale = dedupe(salePool), rent = dedupe(rentPool);
  log(`pool: ${sale.length} unique for-sale, ${rent.length} unique rental (${totalTiles} tiles)`);

  const results = [];
  for (const s of searches) {
    const pool = s.type === 'rental' ? rent : sale;
    const matched = pool.filter(l => passesFilters(l, s.filters));
    const prev = state.searches[s.id] || {};
    const changes = diff(matched, prev, cfg);
    const deals = scoreDeals(matched, changes, cfg, s.type !== 'rental' && s.dealScoring !== false);
    const changeCount = changes.new.length + changes.priceCuts.length + changes.priceIncreases.length +
                        changes.backOnMarket.length + changes.statusChanges.length + changes.gone.length;
    results.push({ search: s, matched, changes, deals, changeCount, tracked: matched.length });
    log(`  [${s.name}] ${matched.length} tracked · ${changes.new.length} new, ` +
        `${changes.priceCuts.length} cuts, ${changes.priceIncreases.length} up, ${deals.underMedian.length} value`);
  }

  // Standing cash-flow screen — ranked, no diff, no state.
  const rentComps = buildRentComps(rent);
  const strResults = [];
  for (const s of rankSearches) {
    const matched = sale.filter(l => passesFilters(l, s.filters));
    const res = screenStr(matched, rentComps, s);
    strResults.push({ search: s, ...res });
    log(`  [${s.name}] ${matched.length} in price band · ${res.total} rent-ready, ${res.multiTotal} multi-unit, ` +
        `${res.sharedTotal} shared-living, ${res.rehabTotal} rehab · types: ` +
        Object.entries(res.typeMix).map(([k, v]) => `${k}:${v}`).join(', ') +
        (res.noComp ? ` · ${res.noComp} skipped (no rent comp)` : ''));
  }

  // Tag the listings the email leads with, in its own order, so the per-run cap
  // spends on what gets read first. Tags are shadow-only (see jev-tags.js).
  if (cfg.jev && cfg.jev.enabled && !firstRun) {
    const order = [];
    for (const r of results) {
      if (r.search.type === 'rental') continue;
      order.push(...r.deals.underMedian, ...r.deals.motivated, ...r.changes.new,
                 ...r.changes.priceCuts, ...r.changes.backOnMarket);
    }
    try { await tagListings(order, cfg, log); } catch (e) { log(`jev: tagging error ${e.message}`); }
    SHOW_JEV = DRY_RUN || !!cfg.jev.showInEmail;
  }

  // Partial-fetch guard. fetchZip swallows tile errors, so a Redfin block or outage
  // returns empty ZIPs instead of failing. Saving that would wipe the diff baseline
  // and tomorrow every listing would read as "new". If this run tracks far fewer
  // listings than the last one, keep the old state and exit non-zero: the watchdog
  // (~/market-lab/ops/watchdog.py) re-runs it and alerts if it keeps failing.
  const prevTracked = Object.values(state.searches || {}).reduce((a, b) => a + Object.keys(b || {}).length, 0);
  const nowTracked = results.reduce((a, r) => a + r.matched.length, 0);
  const minFrac = (cfg.fetch && cfg.fetch.minTrackedFraction) || 0.6;
  if (!firstRun && prevTracked > 100 && nowTracked < minFrac * prevTracked && !ARGS.has('--force')) {
    log(`ABORT: tracked ${nowTracked} listings vs ${prevTracked} last run (< ${Math.round(minFrac * 100)}%). ` +
        `Likely a partial Redfin fetch; state NOT saved, no email. --force overrides.`);
    process.exitCode = 3;
    return;
  }

  const totalChanges = results.reduce((a, r) => a + r.changeCount, 0);
  const stats = { zipCount: allZips.length };
  const html = renderEmail(results, cfg, stats, strResults);

  if (DRY_RUN) {
    const outPath = path.join(DIR, 'preview.html');
    fs.writeFileSync(outPath, html);
    log(`dry run — preview written to ${outPath} (no email, state not saved)`);
    return;
  }

  if (!NO_EMAIL) {
    const strRows = strResults.reduce((a, r) => a + r.rows.length, 0);
    if (totalChanges === 0 && strRows === 0 && !cfg.email.sendWhenNothingNew) {
      log('nothing new — skipping email');
    } else {
      const tag = firstRun ? 'baseline'
        : results.filter(r => r.changeCount).map(r => `${r.search.shortName || r.search.name} ${r.changeCount}`).join(', ')
          || 'update';
      const strTag = strResults.filter(r => r.rows.length)
        .map(r => `${r.search.shortName || 'STR'} ${r.total}`).join(', ');
      const subject = `${cfg.email.subjectPrefix} — ${tag}${strTag ? ` | ${strTag}` : ''}`;
      // A network blip must not cost the day's digest: retry with pauses, and
      // if every try fails keep the old state so tomorrow re-reports today's
      // changes instead of treating them as already seen.
      let sent = false;
      for (let n = 1; n <= 3 && !sent; n++) {
        try {
          execFileSync(process.execPath, [path.join(DIR, 'send-email.js'), subject, html, '--html'], { stdio: 'inherit' });
          log(`email sent: ${subject}`);
          sent = true;
        } catch (e) {
          log(`EMAIL FAILED (try ${n}/3): ${e.message}`);
          if (n < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000 * n);
        }
      }
      if (!sent) {
        log('state NOT saved — changes will be reported again next run');
        process.exitCode = 1;
        return;
      }
    }
  }

  const newState = { lastRun: new Date().toISOString(), searches: {} };
  for (const r of results) {
    const bucket = {};
    for (const l of r.matched) {
      bucket[l.id] = { price: l.price, status: l.status, dom: l.dom ?? null,
                       address: l.address || l.name, zip: l.zip, url: l.url };
    }
    newState.searches[r.search.id] = bucket;
  }
  const saved = backupState();
  fs.writeFileSync(STATE_PATH, JSON.stringify(newState));
  log(`state saved (${results.map(r => `${r.search.id}:${r.matched.length}`).join(', ')})` +
      `${saved ? ` · previous kept in ${path.basename(BACKUP_PATH)}` : ''}`);
}

main().catch(e => { log(`FATAL: ${e.stack || e.message}`); process.exit(1); });
