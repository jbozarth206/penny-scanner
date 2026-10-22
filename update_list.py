#!/usr/bin/env python3
"""
Refresh penny-list.json for the Penny Scanner app.

USAGE (run weekly, e.g. Monday morning):
    cd /workspace/penny-scanner
    python3 update_list.py                 # fetch live sources, rewrite penny-list.json
    python3 update_list.py --no-upc-check  # skip per-item Penny Recon page fetches (faster)
    python3 update_list.py --report-week 2026-10-12   # also pull that Penny Recon weekly receipts page
    python3 update_list.py --days 30       # keep items last seen within N days (default 30)

SOURCES (all public pages, no login):
  1. PennyCentral  https://www.pennycentral.com/penny-list
     The page embeds its item data (Next.js RSC payload) incl. sku, name, brand,
     upc, internetNumber, retailPrice, firstReportedAt, lastSeenAt, locations{state:count}.
  2. Penny Recon   https://www.pennyrecon.com/
     Each <article class="card" data-sku=...> carries sku, name, retail, reports,
     last-seen (epoch ms), states.  Item pages https://www.pennyrecon.com/item/<sku>/
     carry a JSON-LD "gtin12" (the package UPC) which we use to cross-check UPCs.
  3. Penny Recon weekly report  https://www.pennyrecon.com/reports/<monday>/
     "Receipts we checked" = items confirmed by a real register receipt.

UPC POLICY: a UPC is only stored if a source publishes it for that exact SKU.
  upc_verified = true  -> PennyCentral and Penny Recon publish the SAME UPC.
  upc_verified = false -> only one source publishes it (still shown, flagged "single source").
  Conflicting UPCs -> both kept in upc_alt, upc_verified=false.  Never invent a UPC.

MANUAL STEP (optional): put hand edits in manual_overrides.json, e.g.
  {"1008625777": {"notes": "Seen at Clermont #6375 on 10/25"},
   "add": [{"sku": "123456", "name": "...", "retail": 9.97, "reports": 1, "states": {"FL": 1},
            "last_seen": "2026-10-25", "sources": [{"name": "Facebook group", "url": "..."}]}]}
These are merged last.  If a source changes its HTML and parsing breaks, the script
exits without overwriting penny-list.json; save the page into raw/ and fix the parser,
or add items by hand via manual_overrides.json.
"""
import argparse, datetime as dt, html, json, os, re, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "penny-list.json")
RAW = os.path.join(HERE, "raw")
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"
PC_URL = "https://www.pennycentral.com/penny-list"
PR_URL = "https://www.pennyrecon.com/"


def fetch(url, cache_name=None, offline=False):
    path = os.path.join(RAW, cache_name) if cache_name else None
    if offline and path and os.path.exists(path):
        return open(path, encoding="utf-8").read()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode("utf-8", "replace")
    if path:
        os.makedirs(RAW, exist_ok=True)
        open(path, "w", encoding="utf-8").write(body)
    return body


def digits(s):
    return re.sub(r"\D", "", s or "")


def sku_display(sku):
    s = digits(sku)
    if len(s) == 10:
        return f"{s[:4]}-{s[4:7]}-{s[7:]}"
    if len(s) == 6:
        return f"{s[:3]}-{s[3:]}"
    return s


def gtin_key(code):
    """Normalise a UPC/EAN to 14 digits so 12/13/14-digit forms compare equal."""
    d = digits(code)
    return d.zfill(14) if 8 <= len(d) <= 14 else d


def iso_date(v):
    if not v:
        return None
    if isinstance(v, (int, float)):
        return dt.datetime.fromtimestamp(v / 1000, dt.timezone.utc).date().isoformat()
    return str(v)[:10]


# ---------------- PennyCentral ----------------
def parse_pennycentral(page):
    chunks = re.findall(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)</script>', page, re.S)
    blob = "".join(json.loads('"' + c + '"') for c in chunks)
    dec, items = json.JSONDecoder(), {}
    for m in re.finditer(r'\{"id":"\d+","sku":"\d+"', blob):
        try:
            o, _ = dec.raw_decode(blob, m.start())
        except ValueError:
            continue
        if o.get("price") not in (0.01, "0.01", None):
            continue
        items.setdefault(digits(o["sku"]), o)
    return items


# ---------------- Penny Recon ----------------
CARD_RE = re.compile(r'<article class="card ([^"]*)" data-sku="(\d+)"(.*?)</article>', re.S)


def parse_pennyrecon(page):
    items = {}
    for m in CARD_RE.finditer(page):
        cls, sku, body = m.group(1), m.group(2), m.group(3)
        attr = lambda n: (re.search(n + r'="([^"]*)"', body) or [None, None])[1]
        name = re.search(r"<h3>(?:<a [^>]*>)?(.*?)(?:</a>)?</h3>", body, re.S)
        brand = re.search(r'<p class="brand-line">(.*?)</p>', body, re.S)
        detail = attr("data-detail")
        states = {}
        if detail:
            try:
                states = {k: v.get("n", 0) for k, v in json.loads(html.unescape(detail)).items()}
            except ValueError:
                pass
        if not states and attr("data-states"):
            states = {s: 1 for s in attr("data-states").split(",") if s}
        last = attr("data-last")
        first = attr("data-first")
        items[sku] = {
            "tier": cls.replace("tier-", ""),
            "name": html.unescape(name.group(1).strip()) if name else "",
            "brand": html.unescape(brand.group(1).strip()) if brand else "",
            "retail": float(attr("data-retail")) if attr("data-retail") else None,
            "reports": int(attr("data-reports") or 0),
            "last_ms": int(last) if last else None,
            "first_ms": int(first) if first else None,
            "states": states,
        }
    return items


def pennyrecon_upc(sku, offline=False):
    try:
        page = fetch(f"https://www.pennyrecon.com/item/{sku}/", f"pr_item_{sku}.html", offline)
    except Exception:
        return None
    m = re.search(r'"gtin1[234]"\s*:\s*"(\d+)"', page)
    return m.group(1) if m else None


def parse_receipts(page):
    sec = page.split("Receipts we checked", 1)
    if len(sec) < 2:
        return {}
    sec = sec[1].split("New finds by department", 1)[0]
    text = html.unescape(re.sub(r"<[^>]+>", "\n", sec))
    out = {}
    for m in re.finditer(r"([^\n]+?)\s*·\s*SKU\s*([\d-]+)", text):
        out[digits(m.group(2))] = m.group(1).strip()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--report-week", action="append", default=[], help="Penny Recon weekly report date (Monday, YYYY-MM-DD)")
    ap.add_argument("--no-upc-check", action="store_true")
    ap.add_argument("--offline", action="store_true", help="use cached pages in raw/ when present")
    a = ap.parse_args()

    today = dt.date.today()
    cutoff = today - dt.timedelta(days=a.days)
    pc = parse_pennycentral(fetch(PC_URL, "pc.html", a.offline))
    pr = parse_pennyrecon(fetch(PR_URL, "pr.html", a.offline))
    if len(pc) < 5 and len(pr) < 5:
        sys.exit("Parsing failed (site layout changed?). penny-list.json NOT overwritten.")

    receipts, weeks_ok = {}, []
    for wk in a.report_week:
        url = f"https://www.pennyrecon.com/reports/{wk}/"
        try:
            page = fetch(url, f"pr_report_{wk}.html", a.offline)
        except Exception as e:
            print(f"WARN: weekly report {url} not available ({e}); skipped")
            continue
        weeks_ok.append(wk)
        for sku, nm in parse_receipts(page).items():
            receipts[sku] = {"name": nm, "url": url, "week": wk}

    merged = {}
    for sku, o in pc.items():
        if iso_date(o.get("lastSeenAt")) and iso_date(o["lastSeenAt"]) < cutoff.isoformat():
            continue
        merged[sku] = {
            "sku": sku, "sku_display": sku_display(sku), "name": o.get("name", ""),
            "brand": o.get("brand", ""), "model": o.get("modelNumber") or None,
            "retail": o.get("retailPrice"), "internet_number": o.get("internetNumber") or None,
            "reports": sum((o.get("locations") or {}).values()),
            "states": dict(o.get("locations") or {}),
            "first_reported": iso_date(o.get("firstReportedAt")),
            "last_seen": iso_date(o.get("lastSeenAt")),
            "upc_candidates": {"PennyCentral": o.get("upc")} if o.get("upc") else {},
            "image": o.get("imageUrl") or None,
            "sources": [{"name": "PennyCentral", "url": PC_URL}],
        }
    for sku, o in pr.items():
        last = iso_date(o["last_ms"])
        if not last or last < cutoff.isoformat():
            continue
        it = merged.get(sku)
        if not it:
            it = merged[sku] = {
                "sku": sku, "sku_display": sku_display(sku), "name": o["name"], "brand": o["brand"],
                "model": None, "retail": o["retail"], "internet_number": None, "reports": 0, "states": {},
                "first_reported": iso_date(o["first_ms"]), "last_seen": last,
                "upc_candidates": {}, "image": None, "sources": []}
        it["sources"].append({"name": "Penny Recon", "url": f"https://www.pennyrecon.com/item/{sku}/"})
        it["reports"] = max(it["reports"], o["reports"])
        for st, n in o["states"].items():
            it["states"][st] = max(it["states"].get(st, 0), n)
        it["last_seen"] = max(filter(None, [it["last_seen"], last]))
        if it["retail"] is None:
            it["retail"] = o["retail"]
    for sku, r in receipts.items():
        it = merged.get(sku)
        if not it:
            it = merged[sku] = {
                "sku": sku, "sku_display": sku_display(sku), "name": r["name"], "brand": "", "model": None,
                "retail": None, "internet_number": None, "reports": 0, "states": {},
                "first_reported": None, "last_seen": None, "upc_candidates": {}, "image": None, "sources": []}
        it["receipt_verified"] = {"week_of": r["week"], "url": r["url"]}
        it["sources"].append({"name": f"Penny Recon receipts (week of {r['week']})", "url": r["url"]})

    if not a.no_upc_check:
        for sku, it in merged.items():
            if any(s["name"] == "Penny Recon" for s in it["sources"]) or not it["upc_candidates"]:
                u = pennyrecon_upc(sku, a.offline)
                if u:
                    it["upc_candidates"]["Penny Recon"] = u
                time.sleep(0.4)

    items = []
    for it in merged.values():
        cands = it.pop("upc_candidates")
        keys = {gtin_key(v): v for v in cands.values()}
        it["upc"] = next(iter(cands.values())) if cands else None
        it["upc_sources"] = sorted(cands)
        it["upc_verified"] = len(cands) >= 2 and len(keys) == 1
        it["upc_alt"] = [v for k, v in keys.items() if k != gtin_key(it["upc"])] if len(keys) > 1 else []
        it["florida_reports"] = it["states"].get("FL", 0)
        it["state_count"] = len(it["states"])
        it.setdefault("receipt_verified", None)
        it["notes"] = ""
        items.append(it)

    ov_path = os.path.join(HERE, "manual_overrides.json")
    if os.path.exists(ov_path):
        ov = json.load(open(ov_path))
        for add in ov.pop("add", []):
            add["sku"] = digits(add["sku"]); add.setdefault("sku_display", sku_display(add["sku"]))
            items.append(add)
        for it in items:
            it.update(ov.get(it["sku"], {}))

    items.sort(key=lambda i: (-(i.get("reports") or 0), i["sku"]))
    data = {
        "schema": 1,
        "updated": today.isoformat(),
        "window_days": a.days,
        "home_store": {"name": "Home Depot Clermont", "number": "6375", "state": "FL"},
        "sources": [
            {"name": "PennyCentral", "url": PC_URL},
            {"name": "Penny Recon", "url": PR_URL},
        ] + [{"name": f"Penny Recon weekly report {w}", "url": f"https://www.pennyrecon.com/reports/{w}/"} for w in weeks_ok],
        "disclaimer": "Crowdsourced reports, not Home Depot's register. The real price only shows when the item is scanned at checkout, and stores are not required to sell penny items.",
        "items": items,
    }
    json.dump(data, open(OUT, "w"), indent=1, ensure_ascii=False)
    v = sum(i.get("upc_verified") for i in items); u = sum(bool(i.get("upc")) for i in items)
    print(f"Wrote {OUT}: {len(items)} items, {u} with UPC ({v} cross-verified), "
          f"{sum(1 for i in items if i.get('florida_reports'))} with Florida reports.")


if __name__ == "__main__":
    main()
