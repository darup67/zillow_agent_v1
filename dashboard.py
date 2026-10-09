#!/usr/bin/env python3
"""Zillow digest tracker dashboard (read-only). http://localhost:8793 on this Mac; from the phone only with the password (user "jev").
Password: Keychain zillow-dashboard-pass, else the Jev Majors dashboard password (same owner, same login). It only reads the agent's own files
(digests/*.json, history.jsonl, state.json, the log); it never fetches listings and never touches the agent's state or email."""
import base64, glob, json, os, re, secrets, subprocess, sys, time, statistics
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dashauth
PORT, APP_NAME = 8793, "Zillow Digest"
CFG = json.load(open(os.path.join(HERE, "config.json")))
ZIP_MARKET = {z: m["name"] for m in CFG["markets"] for z in m["zips"]}
MARKETS = [m["name"] for m in CFG["markets"]]


def jl(path):
    out = []
    try:
        for line in open(path):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    except OSError:
        pass
    return out


def digest_days():
    return sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(HERE, "digests", "20??-??-??.json")))


def load_digest(day=None):
    days = digest_days()
    day = day if day in days else (days[-1] if days else None)
    if not day:
        return None, day
    try:
        return json.load(open(os.path.join(HERE, "digests", f"{day}.json"))), day
    except (OSError, ValueError):
        return None, day


def run_status():
    last_run = sent = subject = problem = None
    try:
        lines = open(os.path.join(HERE, "zillow-agent.log"), errors="ignore").read().splitlines()[-4000:]
    except OSError:
        lines = []
    for l in lines:
        m = re.match(r"\[(\S+)\] (.*)", l)
        if not m:
            continue
        ts, msg = m.groups()
        if msg.startswith("fetching"):
            last_run, problem = ts, None
        elif msg.startswith("email sent"):
            sent, subject = ts, msg[len("email sent: "):]
        elif any(k in msg for k in ("ABORT", "FATAL", "EMAIL FAILED", "state NOT saved")):
            problem = msg[:160]
        elif msg.startswith("nothing new"):
            sent, subject = ts, "nothing new — no email sent"
    return {"last_run": last_run, "email_sent": sent, "subject": subject, "problem": problem}


def zip_table():
    try:
        st = json.load(open(os.path.join(HERE, "state.json")))
    except (OSError, ValueError):
        return [], {}
    prim = (st.get("searches") or {}).get("primary") or {}
    by = {}
    for l in prim.values():
        z = l.get("zip")
        if z:
            by.setdefault(z, []).append(l)
    rows = []
    for z, ls in by.items():
        prices = [x["price"] for x in ls if x.get("price")]
        doms = [x["dom"] for x in ls if x.get("dom") is not None]
        rows.append({"zip": z, "market": ZIP_MARKET.get(z, ""), "tracked": len(ls), "median_price": statistics.median(prices) if prices else None, "median_dom": statistics.median(doms) if doms else None,
                     "stale": sum(1 for d in doms if d >= 90)})
    rows.sort(key=lambda r: -r["tracked"])
    prices = [x["price"] for x in prim.values() if x.get("price")]
    doms = [x["dom"] for x in prim.values() if x.get("dom") is not None]
    return rows, {"tracked": len(prim), "median_price": statistics.median(prices) if prices else None, "median_dom": statistics.median(doms) if doms else None, "stale90": sum(1 for d in doms if d >= 90)}


def tag_items(items):
    for it in items:
        it["market"] = ZIP_MARKET.get(str(it.get("zip")), "")
    return items


def api(day=None):
    now = time.time()
    dg, day = load_digest(day)
    if dg:
        for s in dg["searches"]:
            for k in ("new", "priceCuts", "priceIncreases", "backOnMarket", "underMedian", "motivated"):
                tag_items(s.get(k, []))
        for s in dg.get("str", []):
            for k in ("rows", "multiRows", "sharedRows", "rehabRows"):
                tag_items(s.get(k, []))
    hist = jl(os.path.join(HERE, "digests", "history.jsonl"))[-45:]
    zr, pulse = zip_table()
    return {"now": now, "day": day, "days": digest_days(), "digest": dg, "history": hist, "zips": zr[:40], "pulse": pulse, "run": run_status(), "markets": MARKETS,
            "hb_age": 0, "cycle_minutes": 24 * 60, "why": "daily digest at 7:30 AM ET"}


def password():
    if os.environ.get("DASH_PASSWORD"):
        return os.environ["DASH_PASSWORD"]
    for svc in ("zillow-dashboard-pass", "jev-majors-dashboard-pass"):
        r = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", svc, "-w"], capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    return ""


PASSWORD = ""
ICONS = {"/apple-touch-icon.png": "apple-touch-icon.png", "/apple-touch-icon-precomposed.png": "apple-touch-icon.png", "/favicon.ico": "apple-touch-icon.png", "/icon-512.png": "icon-512.png", "/manifest.webmanifest": None}


class H(BaseHTTPRequestHandler):
    def _authed(self):
        if self.client_address[0] in ("127.0.0.1", "::1"):
            return True
        if PASSWORD and dashauth.cookie_ok(self.headers, PASSWORD, self.server.server_address[1]):
            return True
        got = self.headers.get("Authorization", "")
        if PASSWORD and got.startswith("Basic "):
            try:
                user, _, pw = base64.b64decode(got[6:]).decode().partition(":")
                if user == "jev" and secrets.compare_digest(pw, PASSWORD):
                    return True
            except Exception:
                pass
        if PASSWORD and "text/html" in (self.headers.get("Accept") or ""):
            dashauth.send_login(self, APP_NAME)
            return False
        time.sleep(1)
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Zillow Digest"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def do_POST(self):
        if self.path.split("?")[0] == "/login" and PASSWORD:
            return dashauth.handle_login(self, PASSWORD, APP_NAME)
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ICONS:
            body = json.dumps({"name": APP_NAME, "short_name": "Zillow", "display": "standalone", "background_color": "#0e1512", "theme_color": "#0e1512", "start_url": "/",
                               "icons": [{"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"}]}).encode() if ICONS[path] is None else open(os.path.join(HERE, "assets", ICONS[path]), "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "application/manifest+json" if path.endswith("webmanifest") else "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(body)
            return
        if not self._authed():
            return
        u = urlparse(self.path)
        if u.path == "/api":
            body, ctype = dashauth.safe_json(api(parse_qs(u.query).get("day", [None])[0])).encode(), "application/json"
        else:
            body, ctype = dashauth.with_kit(open(os.path.join(HERE, "dashboard.html"), "rb").read()), "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def set_password():
    import getpass
    pw = getpass.getpass("New Zillow dashboard password (hidden, 10+ characters): ").strip()
    if len(pw) < 10 or getpass.getpass("Type it again: ").strip() != pw:
        sys.exit("too short or did not match; nothing changed")
    subprocess.run(["/usr/bin/security", "delete-generic-password", "-s", "zillow-dashboard-pass"], capture_output=True)
    r = subprocess.run(["/usr/bin/security", "add-generic-password", "-a", "zillow", "-s", "zillow-dashboard-pass", "-w", pw], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"Keychain write failed: {r.stderr.strip()}")
    print("Saved. Restart:  launchctl kickstart -k gui/$(id -u)/com.dhruv.zillowdash")


if __name__ == "__main__":
    if "--set-password" in sys.argv:
        set_password()
        sys.exit(0)
    PASSWORD = password()
    host = "0.0.0.0" if PASSWORD else "127.0.0.1"
    print(f"zillow digest dashboard on http://{host}:{PORT} ({'password required from other devices' if PASSWORD else 'this Mac only'})", flush=True)
    ThreadingHTTPServer((host, int(os.environ.get("DASH_PORT", PORT))), H).serve_forever()
