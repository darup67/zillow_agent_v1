"""Login page + cookie auth for the Jev dashboards (stdlib only). iOS home-screen web apps cannot show the browser's Basic-auth popup,
so a request without a valid cookie (or Basic credentials) gets this form instead. The cookie is an HMAC of the password: the password
itself never sits in the cookie, and changing the password logs every device out."""
import hashlib, hmac, secrets, time
from urllib.parse import parse_qs

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="{name}"><meta name="theme-color" content="#0a0c10">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest"><title>{name}</title>
<style>html,body{{margin:0;height:100%;background:#0a0c10;color:#e8edf5;font:16px -apple-system,system-ui,sans-serif}}
form{{max-width:320px;margin:0 auto;padding:22vh 24px 0;text-align:center}}img{{width:84px;height:84px;border-radius:19px}}h1{{font-size:20px;margin:14px 0 22px}}
input{{width:100%;box-sizing:border-box;font-size:17px;padding:13px;border-radius:11px;border:1px solid #2b3445;background:#141b27;color:#fff;margin-bottom:12px}}
button{{width:100%;font-size:17px;font-weight:600;padding:13px;border-radius:11px;border:0;background:#3b82f6;color:#fff}}.e{{color:#ff6b6b;min-height:22px;font-size:14px}}</style></head>
<body><form method="post" action="/login"><img src="/apple-touch-icon.png" alt=""><h1>{name}</h1><div class="e">{msg}</div>
<input type="password" name="pw" placeholder="Password" autocomplete="current-password" autofocus required><button>Sign in</button></form></body></html>"""


def token(password, port):
    return hmac.new(password.encode(), f"jev-dash:{port}".encode(), hashlib.sha256).hexdigest()


def cookie_name(port):
    return f"jev_auth_{port}"


def cookie_ok(headers, password, port):
    for part in (headers.get("Cookie") or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == cookie_name(port) and hmac.compare_digest(v, token(password, port)):
            return True
    return False


def send_login(handler, name, msg="", status=200):
    body = PAGE.format(name=name, msg=msg).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def handle_login(handler, password, name):
    """POST /login. Correct password -> cookie (90 days) and redirect to the dashboard."""
    port = handler.server.server_address[1]
    n = min(int(handler.headers.get("Content-Length") or 0), 2000)
    pw = (parse_qs(handler.rfile.read(n).decode(errors="ignore")).get("pw") or [""])[0]
    if password and secrets.compare_digest(pw.strip(), password):
        handler.send_response(303)
        handler.send_header("Set-Cookie", f"{cookie_name(port)}={token(password, port)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000")
        handler.send_header("Location", "/")
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return
    time.sleep(1)
    send_login(handler, name, "Wrong password", 401)


def _clean(o):
    if isinstance(o, float) and (o != o or o in (float("inf"), float("-inf"))):
        return None
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    return o


def safe_json(obj):
    """json.dumps that turns Infinity/NaN (e.g. a profit factor with no losing trade yet) into null: browsers reject them and the whole page goes blank."""
    import json
    return json.dumps(_clean(obj), default=str)


def with_kit(body):
    """Inject the shared dashboard kit (freshness chip, click-a-number provenance, change flashes; ~/jev-client/dashkit.js) into an HTML page. Returns the page unchanged if the kit is missing."""
    import os
    p = os.path.expanduser("~/jev-client/dashkit.js")
    try:
        kit = open(p).read()
    except OSError:
        return body
    raw = body.decode() if isinstance(body, bytes) else body
    tag = "<script>" + kit.replace("</script>", "<\\/script>") + "</script>"
    out = raw.replace("</body>", tag + "</body>", 1) if "</body>" in raw else raw + tag
    return out.encode() if isinstance(body, bytes) else out


# ---- trade list + timeline (served as /trades and /trade?id=; used by the dashboard kit's TRADES panel)
def _jl(s):
    import json
    try:
        return json.loads(s) if isinstance(s, str) and s else (s or {})
    except ValueError:
        return {}


def trades_list(db_path, sym_col, limit=60):
    import os, sqlite3
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
    out = []
    for oid, created, status, sym, side, pnl, upd, close in db.execute(f"SELECT id, created, status, {sym_col}, {'side' if sym_col != 'ticker' else 'NULL'}, pnl_usd, updated, close FROM orders WHERE status LIKE '%closed' ORDER BY updated DESC LIMIT ?", (limit,)):
        c = _jl(close)
        out.append({"id": oid, "t": created, "closed": upd, "sym": sym, "side": side, "pnl": pnl, "rule": (c.get("rule") or "")[:70], "held": c.get("held_minutes")})
    return out


def trade_detail(db_path, oid):
    """A plain-language timeline of one trade, built from what the desk stored at entry (Jev's answers, trigger, chart), its fill and its exit."""
    import datetime as dt, sqlite3
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
    cols = [r[1] for r in db.execute("PRAGMA table_info(orders)")]
    row = db.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
    if not row:
        return None
    o = dict(zip(cols, row))
    body, fill, close = _jl(o.get("body")), _jl(o.get("fill")), _jl(o.get("close"))
    od = body.get("order") if isinstance(body.get("order"), dict) else body
    ts = lambda t: dt.datetime.fromtimestamp(t).strftime("%a %-I:%M:%S %p") if t else ""
    sym = o.get("symbol") or o.get("coin") or o.get("ticker")
    side = o.get("side") or "long"
    steps = []
    sig = []
    for k, label in (("trigger", "trigger"), ("tf", "chart (minutes)"), ("scalp_mode", "session"), ("setup", "setup"), ("regime", "market regime"), ("quality", "Jev's quality score"), ("lane", "lane"), ("confidence", "pick confidence")):
        if od.get(k) not in (None, ""):
            sig.append(f"{label}: {od[k]}")
    why = od.get("why") if isinstance(od.get("why"), dict) else {}
    for k, v in why.items():
        if isinstance(v, dict):
            if "choice" in v:
                sig.append(f"Jev {k.replace('_', ' ')}: {v['choice']}" + (f" ({v['confidence']:.2f} confidence)" if isinstance(v.get("confidence"), (int, float)) else ""))
            elif "score" in v:
                sig.append(f"Jev {k.replace('_', ' ')}: {v['score']:.1f}")
            elif "noul" in v:
                sig.append(f"Jev {k.replace('_', ' ')}: {v['noul']:.2f}")
    feat = od.get("feat") if isinstance(od.get("feat"), dict) else {}
    if feat:
        sig.append("at entry: " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in list(feat.items())[:8] if isinstance(v, (int, float))))
    steps.append({"title": "Signal", "time": ts(o.get("created")), "lines": sig or ["(no stored signal details for this older trade)"]})
    ent = []
    for k, label in (("entry", "entry price"), ("qty", "contracts"), ("stop", "stop"), ("target", "target"), ("risk_usd", "money at risk"), ("filled_usd", "filled (USD)"), ("margin", "margin"), ("lev", "leverage"), ("liq", "liquidation price")):
        if fill.get(k) is not None:
            ent.append(f"{label}: {fill[k]:,.4f}".rstrip("0").rstrip(".") if isinstance(fill[k], float) else f"{label}: {fill[k]}")
    if o.get("ticket_usd"):
        ent.append(f"ticket: ${o['ticket_usd']:,.2f}")
    steps.append({"title": "Entry", "time": ts(o.get("created")), "lines": ent or ["(no fill details)"]})
    mid = []
    for k, label in (("peak_r", "best moment (R)"), ("trough_r", "worst moment (R)"), ("peak_roe", "best return on margin"), ("trough_roe", "worst return on margin"), ("peak_pct", "best return"), ("trough_pct", "worst return"), ("held_minutes", "held (minutes)")):
        if close.get(k) is not None:
            v = close[k]
            mid.append(f"{label}: {v:+.2f}" if isinstance(v, float) else f"{label}: {v}")
    steps.append({"title": "While open", "time": "", "lines": mid or ["(not recorded)"]})
    ex = []
    if close.get("rule"):
        ex.append(f"exit reason: {close['rule']}")
    for k, label in (("exit_price", "exit price"), ("r", "result (R)"), ("roe", "return on margin")):
        if close.get(k) is not None:
            ex.append(f"{label}: {close[k]:+.3f}" if k != "exit_price" else f"{label}: {close[k]:,.4f}")
    ex.append(f"profit/loss: ${o.get('pnl_usd') or 0:+,.2f}")
    steps.append({"title": "Exit", "time": ts(o.get("updated")), "lines": ex})
    return {"id": oid, "sym": sym, "side": side, "status": o.get("status"), "pnl": o.get("pnl_usd"), "steps": steps}
