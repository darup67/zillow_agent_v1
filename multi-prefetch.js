#!/usr/bin/env node
'use strict';
// Hourly, low-rate prefetch of listing remarks for the duplex/triplex section. The daily scrape trips Redfin's page throttle (HTTP 202/403),
// so the remarks are read here, on their own, a few pages at a time, newest listings first. Stops at the first sign of throttling.
// Reads multi-pool.json (written by the daily run), writes multi-cache.json. Never emails, never touches digest state.
const fs = require('fs');
const { fetchAndClassify, needsFetch, loadCache, CACHE_PATH, POOL_PATH } = require('./multi');
const MAX = 15, GAP_MS = 3500;
(async () => {
  let pool;
  try { pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8')).listings; } catch { console.log('no multi-pool.json yet'); return; }
  const cache = loadCache();
  const todo = pool.filter(l => needsFetch(cache[l.id])).slice(0, MAX);
  let ok = 0, fail = 0, streak = 0;
  for (const l of todo) {
    const r = await fetchAndClassify(l, cache, GAP_MS);
    if (r === 'fail') { fail++; if (++streak >= 2) break; } else { ok++; streak = 0; }
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  }
  const left = pool.filter(l => needsFetch(cache[l.id])).length;
  console.log(`${new Date().toISOString()} multi-prefetch: ${ok} read, ${fail} failed, ${left} of ${pool.length} still unread`);
})();
