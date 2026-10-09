#!/usr/bin/env python3
"""One-off seed for the dashboard (2026-10-09): rebuilds per-day history from zillow-agent.log and reconstructs today's digest from state.backup.json vs state.json.
Safe to re-run; it only rewrites digests/history.jsonl and, if missing, today's digest file."""
import json, os, re, datetime as dt
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__)); D = os.path.join(HERE, "digests")
NAMES = {"Primary buy box — houses 2005+": "primary", "Condos & townhomes, 1–2 bedroom": "condos-small", "Rentals, 1–2 bedroom": "rentals", "STR / rental investment — under $300k": "str-cashflow"}
runs = {}
cur = None
for line in open(os.path.join(HERE, "zillow-agent.log"), errors="ignore"):
    m = re.match(r"\[(\S+)\] (.*)", line.rstrip())
    if not m: continue
    ts, msg = m.groups()
    t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    day = t.astimezone(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
    if msg.startswith("fetching"):
        cur = {"day": day, "t": t.isoformat(), "searches": [], "str": [], "pool": {}, "sent": False}
    if cur is None: continue
    pm = re.match(r"pool: (\d+) unique for-sale, (\d+) unique rental", msg)
    if pm: cur["pool"] = {"sale": int(pm[1]), "rental": int(pm[2])}
    sm = re.match(r"\[(.+?)\] (\d+) tracked · (\d+) new, (\d+) cuts, (\d+) up, (\d+) value", msg.strip())
    if sm and sm[1] in NAMES:
        cur["searches"].append({"id": NAMES[sm[1]], "tracked": int(sm[2]), "new": int(sm[3]), "priceCuts": int(sm[4]), "priceIncreases": int(sm[5]), "value": int(sm[6])})
    tm = re.match(r"\[(.+?)\] (\d+) in price band · (\d+) rent-ready", msg.strip())
    if tm and tm[1] in NAMES:
        cur["str"].append({"id": NAMES[tm[1]], "screened": int(tm[2]), "total": int(tm[3])})
    if msg.startswith("email sent"):
        cur["sent"] = True
    if msg.startswith("state saved") and cur["searches"]:
        runs[cur["day"]] = cur          # one finished run per day (the last wins)
        cur = None
with open(os.path.join(D, "history.jsonl"), "w") as f:
    for day in sorted(runs):
        r = runs[day]; f.write(json.dumps({k: r[k] for k in ("day", "t", "pool", "searches", "str")}) + "\n")
print("history days:", len(runs))
# today's digest, reconstructed from the state files
cfg = json.load(open(os.path.join(HERE, "config.json"))); cut = cfg["dealScoring"]["priceCutMinPct"]
st, bk = json.load(open(os.path.join(HERE, "state.json"))), json.load(open(os.path.join(HERE, "state.backup.json")))
day = dt.datetime.fromisoformat(st["lastRun"].replace("Z", "+00:00")).astimezone(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
out = os.path.join(D, f"{day}.json")
if not os.path.exists(out):
    cfgs = {s["id"]: s for s in cfg["searches"]}
    searches = []
    for sid, cur_b in st["searches"].items():
        prev = bk["searches"].get(sid, {}); s = cfgs.get(sid, {})
        new, cuts, ups = [], [], []
        for i, l in cur_b.items():
            it = {"id": i, **{k: l.get(k) for k in ("address", "zip", "price", "dom", "status", "url") if l.get(k) is not None}}
            p = prev.get(i)
            if not p: new.append(it); continue
            if p.get("price") and l.get("price") and l["price"] != p["price"]:
                pct = (l["price"] - p["price"]) / p["price"] * 100
                if abs(pct) >= cut: (cuts if pct < 0 else ups).append({**it, "prevPrice": p["price"], "changePct": pct})
        cuts.sort(key=lambda x: x["changePct"])
        searches.append({"id": sid, "name": s.get("name", sid), "type": s.get("type", "sale"), "tracked": len(cur_b), "counts": {"new": len(new), "priceCuts": len(cuts), "priceIncreases": len(ups), "backOnMarket": 0, "gone": len([1 for i in prev if i not in cur_b]), "value": 0, "motivated": 0},
                         "new": new[:80], "priceCuts": cuts[:80], "priceIncreases": ups[:30], "backOnMarket": [], "underMedian": [], "motivated": []})
    json.dump({"t": st["lastRun"], "reconstructed": True, "searches": searches, "str": []}, open(out, "w"))
    print("reconstructed", out, [(s["id"], s["counts"]["new"], s["counts"]["priceCuts"]) for s in searches])
