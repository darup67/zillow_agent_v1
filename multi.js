'use strict';
/**
 * Duplex / triplex screen. A standing section (like the STR screen), not a change feed.
 *
 * Redfin's CSV has no unit count and no remarks, so every candidate's listing page is fetched once (cached 60 days in
 * multi-cache.json) and the REMARKS decide two things:
 *   1. units: duplex / triplex are kept; four-plexes and listings that never state a unit count are NOT shown (counted instead).
 *   2. condition: listings whose remarks describe heavy repairs, fire/water/structural/foundation damage, teardown, condemned or
 *      dilapidated property are dropped. Jev (via ~/jev-client) double-checks the remarks with the condition + problem questions.
 * Light cosmetic work ("needs updating", "TLC") is not excluded, only flagged.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getPage, remarksFrom, QUESTIONS } = require('./jev-tags');

const DIR = __dirname;
const CACHE_PATH = path.join(DIR, 'multi-cache.json');
const STATE_PATH = path.join(DIR, 'multi-state.json');
const CACHE_DAYS = 60;
let jev = null;
try { jev = require(path.join(os.homedir(), 'jev-client', 'jev.js')); } catch {}

const FOUR = /\b(four[- ]?plex|4[- ]?plex|quad[- ]?plex|quadruplex|quad[- ]?unit|4[- ]units?|four[- ]units?|four separate (?:units|apartments)|4 separate (?:units|apartments)|4 apartments?|four apartments?)\b/i;
const THREE = /\b(tri[- ]?plex|3[- ]?plex|three[- ]?plex|3[- ]units?|three[- ]units?|three separate (?:units|apartments|dwellings)|3 separate (?:units|apartments)|3 apartments?|three apartments?|3 unit)\b/i;
const TWO = /\b(du[- ]?plex|2[- ]?plex|two[- ]?plex|2[- ]units?|two[- ]units?|two separate (?:units|apartments|dwellings|homes)|2 separate (?:units|apartments)|2 apartments?|two apartments?|2 unit)\b/i;

// Heavy-repair language. Each hit is checked for a negation just before it ("no structural issues").
const BAD = [
  /fire[- ]damage[d]?|fire[- ]damaged|fire loss|burn(?:ed|t)[- ]out|smoke damage/i,
  /needs? (?:a )?(?:gut|full|total|complete|major|extensive|significant|substantial|lots of|a lot of|heavy)\b/i,
  /(?:total|full|complete|major|extensive|heavy|significant|substantial)[- ](?:rehab|renovation|repairs?|restoration|rebuild)/i,
  /(?:gut|full|total|major) rehab/i,
  /structural (?:damage|issues?|problems?|concerns?|repairs?)/i,
  /foundation (?:issues?|problems?|damage|repairs?|cracks?|settling)/i,
  /condemned|uninhabitable|not (?:habitable|livable|inhabitable|safe)|unlivable|red[- ]?tagged/i,
  /tear[- ]?down|to be demolished|demolition|scrape[- ]?off/i,
  /dilapidated|derelict|boarded[- ]up|boarded|abandoned|collapsed|sinkhole/i,
  /water damage[d]?|flood damage[d]?|\bmold\b|\bmildew\b|roof (?:leaks?|damage|is gone|needs? (?:to be )?replac)/i,
  /squatters?|vandali[sz]ed|stripped of|no (?:utilities|plumbing|electric)/i,
  /handyman special|fixer[- ]?upper|investor special|bring your (?:own )?contractor|contractor special|cash only|sold as[- ]is.{0,60}(?:repairs|rehab|renovation|gut)/i,
];
const NEG = /\b(?:no|not|without|free of|zero|never|nothing|none|isn'?t|hasn'?t|doesn'?t|don'?t)\W+(?:\w+\W+){0,3}$/i;

// 2026-10-21 (found by a zero-shot pass over "units unknown" remarks): "4 bedrooms on each side" = duplex, and a count a few words before "units"
// ("four currently occupied residential units", "4 renovated 1 BR/1 Bath units"). Bedrooms are never counted: "bed"/"br" right after the number is skipped.
const SIDE = /\b(?:on |for )?(?:each|both|either|per) sides?\b|\bside[- ]by[- ]side\b|\bup(?:stairs)? and down(?:stairs)? units?\b/i;
const NUM = { two: 2, three: 3, four: 4, five: 5, six: 6, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 };
const NUNITS = /\b(two|three|four|five|six|[2-6])\s+(?!(?:bed|br\b|bd\b|bath|ba\b|car|story|stories|acre|sq))(?:[\w/-]+\s+){0,4}?(?:residential |rental |separate |occupied |leased )?units\b/i;
function unitsFrom(t) {
  const hits = [[FOUR, 4], [THREE, 3], [TWO, 2]].map(([re, n]) => { const m = re.exec(t); return m ? [m.index, n] : null; }).filter(Boolean);
  const nu = NUNITS.exec(t);
  if (nu) hits.push([nu.index, Math.min(NUM[nu[1].toLowerCase()], 4)]);
  if (!hits.length && SIDE.test(t)) return 2;
  if (!hits.length) return null;
  hits.sort((a, b) => a[0] - b[0]);
  return hits[0][1];                                           // the earliest mention wins ("duplex ... could convert to a triplex" is a duplex)
}

function badIn(t) {
  const found = [];
  for (const re of BAD) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(t))) {
      const before = t.slice(Math.max(0, m.index - 40), m.index);
      if (NEG.test(before)) continue;
      found.push(m[0].toLowerCase().trim());
      break;
    }
  }
  return found;
}

function load(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }

const POOL_PATH = path.join(DIR, 'multi-pool.json');

function needsFetch(hit) { return !hit || (hit.noRemarks && Date.now() - hit.at > 3 * 86400e3); }

// Fetch one listing page, classify its remarks, store in `cache`. Returns 'fail' | 'noremarks' | 'ok' | 'asked'. The caller saves the cache.
async function fetchAndClassify(l, cache, delay = 900) {
  let remarks = null;
  try { remarks = remarksFrom(await getPage(l.url)); }
  catch (e) { return 'fail'; }
  await new Promise(r => setTimeout(r, delay));
  if (!remarks) { cache[l.id] = { at: Date.now(), noRemarks: true }; return 'noremarks'; }
  const entry = { at: Date.now(), units: unitsFrom(remarks), bad: badIn(remarks), remarks: remarks.slice(0, 1200) };
  let asked = false;
  if (!entry.bad.length && entry.units && entry.units < 4 && jev && jev.apiKey && jev.apiKey()) {
    try {
      const res = await jev.ask({ property_type: l.propertyType || 'unknown', remarks }, { condition: QUESTIONS.condition, problem: QUESTIONS.problem }, { caller: 'zillow' });
      if (res && res.answers) {
        asked = true;
        const c = res.answers.condition, p = res.answers.problem;
        entry.jevCond = c && c.confidence >= 0.6 ? Math.round(c.score) : null;
        entry.jevProblem = p ? p.noul : null;
      }
    } catch {}
  }
  cache[l.id] = entry;
  return asked ? 'asked' : 'ok';
}

function loadCache() {
  const cache = load(CACHE_PATH, {});
  const cutoff = Date.now() - CACHE_DAYS * 86400e3;
  for (const id of Object.keys(cache)) if (cache[id].at < cutoff) delete cache[id];
  return cache;
}

async function screenMulti(matched, s, cfg, log, helpers, opts = {}) {
  const mc = s.multi || {};
  const keep = new Set(mc.units || [2, 3]);
  const maxFetch = mc.maxFetch ?? 80, delay = mc.delayMs ?? 900;
  const cache = loadCache();

  const cand = matched.filter(l => l.price && l.url).sort((a, b) => (a.dom ?? 999) - (b.dom ?? 999));
  try { fs.writeFileSync(POOL_PATH, JSON.stringify({ t: Date.now(), listings: cand.map(l => ({ id: l.id, url: l.url, address: l.address, price: l.price, propertyType: l.propertyType, dom: l.dom })) })); } catch {}
  let fetched = 0, failed = 0, asked = 0, streak = 0;
  for (const l of cand) {
    if (!needsFetch(cache[l.id])) continue;
    if (fetched >= maxFetch || streak >= 3) continue;           // Redfin answers HTTP 202/403 when it throttles page fetches: stop instead of hammering
    fetched++;
    const r = await fetchAndClassify(l, cache, delay);
    if (r === 'fail') { failed++; streak++; } else { streak = 0; if (r === 'asked') asked++; }
  }
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache)); } catch {}

  const state = load(STATE_PATH, null);
  const first = !state;
  const prev = (state && state.listings) || {};
  const rows = [], out = { fourPlus: 0, unitsUnknown: 0, heavyRepair: 0, noRemarks: 0, otherUnits: 0 };
  const now = Date.now();
  for (const l of cand) {
    const c = cache[l.id];
    if (!c || c.noRemarks) { out.noRemarks++; continue; }
    if (c.bad && c.bad.length) { out.heavyRepair++; continue; }
    if (c.jevCond != null && c.jevCond >= 3) { out.heavyRepair++; continue; }
    if (c.jevProblem != null && c.jevProblem >= 0.6) { out.heavyRepair++; continue; }
    if (!c.units) { out.unitsUnknown++; continue; }
    if (c.units >= 4) { out.fourPlus++; continue; }
    if (!keep.has(c.units)) { out.otherUnits++; continue; }
    const p = prev[l.id];
    const flags = [];
    if (c.jevCond === 2) flags.push('remarks say it needs work (cosmetic/moderate): verify');
    if (c.jevProblem != null && c.jevProblem >= 0.35) flags.push('remarks may mention a physical problem: read them');
    if (l.yearBuilt != null && l.yearBuilt < 1950) flags.push(`built ${l.yearBuilt}`);
    if (l.dom != null && l.dom >= 120) flags.push(`${l.dom}d on market`);
    const perUnit = l.price / c.units;
    const rent = helpers && helpers.rentPerUnit ? helpers.rentPerUnit(l, c.units) : null;
    const gross = rent ? rent * c.units : null;
    rows.push({ ...l, units: c.units, perUnit, estRent: gross, unitRent: rent, ltrRatio: gross ? gross / l.price * 100 : null,
                isNew: !first && !p, prevPrice: p && p.price !== l.price ? p.price : null,
                changePct: p && p.price && p.price !== l.price ? (l.price - p.price) / p.price * 100 : null,
                verified: !!(c.jevCond != null), flags });
  }
  rows.sort((a, b) => (b.isNew - a.isNew) || ((b.ltrRatio ?? -1) - (a.ltrRatio ?? -1)) || (a.price - b.price));
  if (!opts.dry) {
    const next = {};
    for (const l of cand) next[l.id] = { price: l.price };
    try { fs.writeFileSync(STATE_PATH, JSON.stringify({ t: now, listings: next })); } catch {}
  }
  log(`  [${s.name}] ${cand.length} multi-family · ${rows.length} duplex/triplex shown · dropped: ${out.heavyRepair} heavy repair, ${out.fourPlus} 4-plex, ` +
      `${out.unitsUnknown} unit count not stated, ${out.noRemarks} no remarks yet · pages ${fetched} (${failed} failed), jev ${asked}`);
  return { rows, total: rows.length, candidates: cand.length, excluded: out, newCount: rows.filter(r => r.isNew).length, cutCount: rows.filter(r => r.prevPrice && r.changePct < 0).length };
}

module.exports = { screenMulti, unitsFrom, badIn, fetchAndClassify, needsFetch, loadCache, CACHE_PATH, POOL_PATH };
