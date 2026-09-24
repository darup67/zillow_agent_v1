'use strict';
/**
 * Jev tags for listings: condition, investor pitch, disclosed problems,
 * distressed sale, tenant in place. Read from the listing's own remarks.
 *
 * The gis-csv feed has no remarks, so each tagged listing costs one listing-page
 * fetch (~1.2 MB); the remarks are in its RealEstateListing JSON-LD block.
 * Tags are cached by listing id in jev-cache.json, so a listing is fetched and
 * asked about once, and every answer is appended to jev-tags.jsonl with the
 * remarks it was based on, for review.
 *
 * Shadow mode: tags show in --dry-run's preview.html; the email shows them only
 * when config.jev.showInEmail is true. Nothing here filters or reorders listings.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const DIR = __dirname;
const CACHE_PATH = path.join(DIR, 'jev-cache.json');
const LOG_PATH = path.join(DIR, 'jev-tags.jsonl');
const CACHE_DAYS = 60;

let jev = null;
try { jev = require(path.join(os.homedir(), 'jev-client', 'jev.js')); } catch {}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Jev reads literally (see its jaggedness notes), so each question names the
// field it reads and spells out the boundary cases. Numbers stay in code.
const QUESTIONS = {
  condition: {
    type: 'score',
    instructions: 'Based only on `remarks`, what condition is this home in?',
    criteria: [
      'Renovated or new: remarks describe new construction, a recent renovation, or move-in ready condition',
      'Maintained: livable as-is, possibly dated, and the remarks do not say work is needed',
      'Needs work: remarks say the home needs updating, repairs or TLC, or is sold as-is',
      'Major rehab: remarks describe a gut job, teardown, fire or water damage, or a home that is not livable',
    ],
  },
  investor: {
    type: 'noul',
    instructions: 'Do the `remarks` pitch this home to investors or cash buyers, for example ' +
      '"investor special", "cash only", "bring your contractor", or "great flip or rental"?',
  },
  problem: {
    type: 'noul',
    instructions: 'Do the `remarks` disclose a physical problem with the property, such as foundation, ' +
      'structural, roof, water, flood, fire, mold or septic issues?',
  },
  distressed: {
    type: 'noul',
    instructions: 'Do the `remarks` say this is a foreclosure, bank-owned (REO), short sale, auction, or estate sale?',
  },
  tenant: {
    type: 'noul',
    instructions: 'Do the `remarks` say the home is currently rented or tenant-occupied, or is sold with a lease in place?',
  },
};

const CONDITION = ['renovated', 'maintained', 'needs work', 'major rehab'];

function getPage(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function remarksFrom(html) {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      for (const o of [].concat(JSON.parse(m[1]))) {
        const t = [].concat(o['@type'] || []);
        if (t.includes('RealEstateListing') && o.description) return String(o.description);
      }
    } catch {}
  }
  return null;
}

// Turn Jev's answers into short labels. Thresholds are deliberately strict for
// the shadow period; loosen them after reviewing jev-tags.jsonl.
function labels(a) {
  const out = [];
  const c = a.condition;
  if (c && c.confidence >= 0.6) out.push(CONDITION[Math.round(c.score)]);
  if (a.distressed?.noul >= 0.7) out.push('distressed sale');
  if (a.investor?.noul >= 0.7) out.push('investor pitch');
  if (a.problem?.noul >= 0.7) out.push('discloses a problem');
  if (a.tenant?.noul >= 0.7) out.push('tenant in place');
  return out;
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}

/**
 * Tag up to maxPerRun listings, in the order given (callers pass the email's
 * priority order). Sets l.jevTags on every listing that has a cached or new
 * answer. Never throws: a failure leaves that listing untagged.
 */
async function tagListings(listings, cfg, log) {
  const jc = cfg.jev || {};
  if (!jc.enabled) return;
  if (!jev) { log('jev: ~/jev-client/jev.js not found, skipping tags'); return; }
  if (!jev.apiKey()) { log('jev: no API key in Keychain (service typesafe-jev), skipping tags'); return; }

  const cache = loadCache();
  const cutoff = Date.now() - CACHE_DAYS * 86400e3;
  for (const id of Object.keys(cache)) if (cache[id].at < cutoff) delete cache[id];

  let fetched = 0, asked = 0, noRemarks = 0, failed = 0;
  for (const l of listings) {
    if (cache[l.id]) { l.jevTags = cache[l.id].tags; continue; }
    if (fetched >= (jc.maxPerRun ?? 40) || !l.url) continue;
    fetched++;
    let remarks;
    try {
      remarks = remarksFrom(await getPage(l.url));
    } catch (e) {
      failed++;
      continue;
    }
    await new Promise(r => setTimeout(r, jc.delayMs ?? 1000));
    if (!remarks) { noRemarks++; continue; }

    const res = await jev.ask({ property_type: l.propertyType || 'unknown', remarks }, QUESTIONS, { caller: 'zillow' });
    if (!res) { failed++; continue; }
    asked++;
    const tags = labels(res.answers);
    l.jevTags = tags;
    cache[l.id] = { at: Date.now(), tags };
    try {
      fs.appendFileSync(LOG_PATH, JSON.stringify({
        t: new Date().toISOString(), id: l.id, address: l.address, zip: l.zip, url: l.url,
        price: l.price, model: res.model, tags, answers: res.answers, remarks,
      }) + '\n');
    } catch {}
  }
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache)); } catch {}
  log(`jev: ${asked} tagged, ${noRemarks} without remarks, ${failed} failed ` +
      `(${fetched} pages fetched, cap ${jc.maxPerRun ?? 40})`);
}

module.exports = { tagListings, remarksFrom, labels, QUESTIONS };
