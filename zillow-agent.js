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

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
const ZIPS_PATH = path.join(DIR, 'zips.tsv');
const LOG_PATH = path.join(DIR, 'zillow-agent.log');

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has('--dry-run');
const NO_EMAIL = ARGS.has('--no-email') || DRY_RUN;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
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

/* ------------------------------------------------------------- filtering */

function passesBuyBox(l, bb) {
  if (bb.minPrice != null && (l.price == null || l.price < bb.minPrice)) return false;
  if (bb.maxPrice != null && (l.price == null || l.price > bb.maxPrice)) return false;
  if (bb.minBeds != null && (l.beds == null || l.beds < bb.minBeds)) return false;
  if (bb.minBaths != null && (l.baths == null || l.baths < bb.minBaths)) return false;
  if (bb.minSqft != null && l.sqft != null && l.sqft < bb.minSqft) return false;
  if (bb.maxSqft != null && l.sqft != null && l.sqft > bb.maxSqft) return false;
  if (bb.minYearBuilt != null && l.yearBuilt != null && l.yearBuilt < bb.minYearBuilt) return false;
  if (bb.maxYearBuilt != null && l.yearBuilt != null && l.yearBuilt > bb.maxYearBuilt) return false;
  if (bb.maxHoaMonthly != null && l.hoa != null && l.hoa > bb.maxHoaMonthly) return false;
  if (bb.maxPricePerSqft != null && l.ppsf != null && l.ppsf > bb.maxPricePerSqft) return false;
  if (bb.maxDaysOnMarket != null && l.dom != null && l.dom > bb.maxDaysOnMarket) return false;
  if (Array.isArray(bb.propertyTypes) && bb.propertyTypes.length &&
      !bb.propertyTypes.includes(l.propertyType)) return false;
  if (Array.isArray(bb.excludeKeywords)) {
    const hay = `${l.address} ${l.location || ''}`.toLowerCase();
    for (const kw of bb.excludeKeywords) {
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

function diff(current, state, cfg) {
  const prev = state.listings || {};
  const sig = cfg.signals;
  const cut = cfg.dealScoring.priceCutMinPct;

  const out = { new: [], priceCuts: [], priceIncreases: [], backOnMarket: [], statusChanges: [], gone: [] };

  for (const l of current) {
    const p = prev[l.id];
    if (!p) {
      // Genuinely new to us. On a first-ever run everything lands here.
      if (sig.newListings) out.new.push(l);
      continue;
    }
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
    for (const id of Object.keys(prev)) {
      if (!seen.has(id)) out.gone.push(prev[id]);
    }
  }
  return out;
}

// Deal flags: cheap vs ZIP median $/sqft, and stale-but-reduced (motivated seller).
function scoreDeals(current, changes, cfg) {
  if (!cfg.dealScoring.enabled) return { underMedian: [], motivated: [] };

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
  const bits = [];
  if (l.beds != null) bits.push(`${l.beds}bd`);
  if (l.baths != null) bits.push(`${l.baths}ba`);
  if (l.sqft != null) bits.push(`${l.sqft.toLocaleString('en-US')} sqft`);
  if (l.ppsf != null) bits.push(`$${l.ppsf}/sqft`);
  if (l.yearBuilt != null) bits.push(`built ${l.yearBuilt}`);
  if (l.dom != null) bits.push(`${l.dom}d on mkt`);
  if (l.hoa != null && l.hoa > 0) bits.push(`HOA ${fmtMoney(l.hoa)}/mo`);
  return bits.join(' &middot; ');
}

function tableFor(listings, cfg, opts = {}) {
  const rows = listings.slice(0, cfg.dealScoring.maxRowsPerSection).map(l => {
    let priceCell = `<strong>${fmtMoney(l.price)}</strong>`;
    if (l.prevPrice != null) {
      const arrow = l.changePct < 0 ? '&#9660;' : '&#9650;';
      const color = l.changePct < 0 ? '#1a7f37' : '#b35900';
      priceCell = `<strong>${fmtMoney(l.price)}</strong>` +
        `<div style="color:${color};font-size:12px">${arrow} ${Math.abs(l.changePct).toFixed(1)}% ` +
        `from ${fmtMoney(l.prevPrice)}</div>`;
    }
    let badge = '';
    if (opts.showDiscount && l.discountPct != null) {
      badge = `<div style="font-size:12px;color:#1a7f37">${l.discountPct.toFixed(0)}% under ` +
              `ZIP median ($${l.zipMedianPpsf}/sqft)</div>`;
    }
    if (l.prevStatus) {
      badge += `<div style="font-size:12px;color:#555">${esc(l.prevStatus)} &rarr; ${esc(l.status)}</div>`;
    }
    if (l.openHouse) {
      badge += `<div style="font-size:12px;color:#0b62c4">Open house: ${esc(l.openHouse)}</div>`;
    }
    return `<tr>
  <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top">
    <a href="${esc(l.url)}" style="color:#0b62c4;text-decoration:none;font-weight:600">${esc(l.address)}</a>
    <div style="color:#666;font-size:12px">${esc(l.city)} ${esc(l.zip)}${l.location ? ' &middot; ' + esc(l.location) : ''}</div>
    <div style="color:#444;font-size:12px;margin-top:3px">${detailLine(l)}</div>
    ${badge}
  </td>
  <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;vertical-align:top;white-space:nowrap">${priceCell}</td>
</tr>`;
  }).join('\n');

  const more = listings.length > cfg.dealScoring.maxRowsPerSection
    ? `<div style="font-size:12px;color:#666;padding:6px 8px">+ ${listings.length - cfg.dealScoring.maxRowsPerSection} more not shown</div>`
    : '';
  return `<table style="width:100%;border-collapse:collapse;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px">${rows}</table>${more}`;
}

function section(title, listings, cfg, opts) {
  if (!listings || !listings.length) return '';
  return `<h2 style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;
    margin:26px 0 6px;padding-bottom:5px;border-bottom:2px solid #111">${title}
    <span style="color:#888;font-weight:400">(${listings.length})</span></h2>` + tableFor(listings, cfg, opts);
}

function renderEmail(changes, deals, cfg, stats) {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  let body = `<div style="max-width:720px;margin:0 auto;padding:16px">
<h1 style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:20px;margin:0">
  ${esc(cfg.email.subjectPrefix)}</h1>
<div style="color:#666;font-size:13px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;margin-top:2px">
  ${date} &middot; ${stats.zipCount} ZIPs &middot; ${stats.totalTracked} active listings in your buy box</div>`;

  body += section('&#9733; Best value &mdash; new &amp; under ZIP median', deals.underMedian, cfg, { showDiscount: true });
  body += section('&#128293; Motivated sellers &mdash; stale &amp; reduced', deals.motivated, cfg);
  body += section('New listings', changes.new, cfg);
  body += section('Price cuts', changes.priceCuts, cfg);
  body += section('Price increases', changes.priceIncreases, cfg);
  body += section('Back on market', changes.backOnMarket, cfg);
  body += section('Status changes', changes.statusChanges, cfg);
  body += section('Left the market', changes.gone, cfg);

  // Per-ZIP median $/sqft context table
  if (deals.medians && deals.medians.size) {
    const rows = [...deals.medians.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([zip, med]) => `<tr><td style="padding:4px 10px 4px 0">${zip}</td>
        <td style="padding:4px 0;text-align:right">$${med}/sqft</td></tr>`).join('');
    body += `<h2 style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;
      margin:26px 0 6px;padding-bottom:5px;border-bottom:2px solid #111">ZIP median $/sqft (active inventory)</h2>
      <table style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;color:#333">${rows}</table>`;
  }

  body += `<div style="margin-top:28px;padding-top:10px;border-top:1px solid #ddd;color:#888;font-size:11px;
    font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
    Listing data via Redfin. Tune your filters in <code>~/zillow-agent/config.json</code>.</div></div>`;
  return body;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  if (ARGS.has('--reset')) {
    try { fs.unlinkSync(STATE_PATH); } catch {}
    log('state reset');
    return;
  }

  let state = { listings: {}, lastRun: null };
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
  const firstRun = !state.lastRun;

  const allZips = cfg.markets.flatMap(m => m.zips);
  log(`fetching ${allZips.length} ZIPs...`);

  const current = [];
  let rawCount = 0, totalTiles = 0;
  for (const zip of allZips) {
    const { listings, tiles } = await fetchZip(zip, cfg);
    rawCount += listings.length;
    totalTiles += tiles;
    const kept = listings.filter(l => passesBuyBox(l, cfg.buyBox));
    log(`  ${zip}: ${listings.length} active -> ${kept.length} in buy box (${tiles} tile${tiles === 1 ? "" : "s"})`);
    current.push(...kept);
    if (zip !== allZips[allZips.length - 1]) await sleep(cfg.fetch.delayMsBetweenZips);
  }

  // Dedupe (bbox overlap between neighboring ZIPs can surface the same home twice)
  const seen = new Set();
  const unique = current.filter(l => (seen.has(l.id) ? false : (seen.add(l.id), true)));
  log(`total: ${rawCount} active, ${unique.length} unique in buy box (${totalTiles} tiles fetched)`);

  const changes = diff(unique, state, cfg);
  const deals = scoreDeals(unique, changes, cfg);

  const changeCount = changes.new.length + changes.priceCuts.length + changes.priceIncreases.length +
                      changes.backOnMarket.length + changes.statusChanges.length + changes.gone.length;
  log(`changes: ${changes.new.length} new, ${changes.priceCuts.length} cuts, ` +
      `${changes.priceIncreases.length} increases, ${changes.backOnMarket.length} back on market, ` +
      `${changes.statusChanges.length} status, ${deals.underMedian.length} value picks`);

  const stats = { zipCount: allZips.length, totalTracked: unique.length };
  const html = renderEmail(changes, deals, cfg, stats);

  if (DRY_RUN) {
    const outPath = path.join(DIR, 'preview.html');
    fs.writeFileSync(outPath, html);
    log(`dry run — preview written to ${outPath} (no email, state not saved)`);
    return;
  }

  if (!NO_EMAIL) {
    if (changeCount === 0 && !cfg.email.sendWhenNothingNew) {
      log('nothing new — skipping email');
    } else {
      const tag = firstRun ? 'baseline' :
        [changes.new.length && `${changes.new.length} new`,
         changes.priceCuts.length && `${changes.priceCuts.length} cuts`,
         deals.underMedian.length && `${deals.underMedian.length} value`]
          .filter(Boolean).join(', ') || 'update';
      const subject = `${cfg.email.subjectPrefix} — ${tag}`;
      try {
        execFileSync(process.execPath, [path.join(DIR, 'send-email.js'), subject, html, '--html'],
          { stdio: 'inherit' });
        log(`email sent: ${subject}`);
      } catch (e) {
        log(`EMAIL FAILED: ${e.message}`);
        process.exitCode = 1;
      }
    }
  }

  const newState = { lastRun: new Date().toISOString(), listings: {} };
  for (const l of unique) {
    newState.listings[l.id] = { price: l.price, status: l.status, dom: l.dom, address: l.address, zip: l.zip, url: l.url };
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(newState));
  log(`state saved (${unique.length} listings)`);
}

main().catch(e => { log(`FATAL: ${e.stack || e.message}`); process.exit(1); });
