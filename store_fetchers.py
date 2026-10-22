#!/usr/bin/env python3
"""
Per-store fetchers for the Penny Scanner (Dollar General, Lowe's, Walmart).
Each fetch_* function returns {"items": [...], "sources": [...], "as_of": "YYYY-MM-DD", "note": "..."}
or raises FetchError when a source can't be fetched/parsed. update_list.py catches the error and keeps
that store's previous items, so a broken scrape never wipes good data.

POLICY: nothing is invented. A UPC / SKU / item number / price is stored only if the source prints it.
Every item carries a date (report date, list date or page publish date) and its source URL(s).
"""
import datetime as dt, html, json, os, re, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


class FetchError(Exception):
    pass


def fetch(url, cache_name=None, offline=False):
    path = os.path.join(RAW, cache_name) if cache_name else None
    if offline and path and os.path.exists(path):
        return open(path, encoding="utf-8").read()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            if r.status != 200:
                raise FetchError(f"{url}: HTTP {r.status}")
            body = r.read().decode("utf-8", "replace")
    except FetchError:
        raise
    except Exception as e:
        raise FetchError(f"{url}: {e}")
    if path:
        os.makedirs(RAW, exist_ok=True)
        open(path, "w", encoding="utf-8").write(body)
    return body


def digits(s):
    return re.sub(r"\D", "", s or "")


def gtin_key(code):
    d = digits(code)
    return d.zfill(14) if 8 <= len(d) <= 14 else d


def text(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def norm_name(s):
    return re.sub(r"[^a-z0-9]", "", text(s).lower().replace("’", "'"))


MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                       "september", "october", "november", "december"], 1)}


def parse_long_date(s):
    m = re.search(r"([A-Z][a-z]+)\.? (\d{1,2}),? (\d{4})", s or "")
    if not m or m.group(1).lower() not in MONTHS:
        return None
    return dt.date(int(m.group(3)), MONTHS[m.group(1).lower()], int(m.group(2))).isoformat()


# =====================================================================================
# DOLLAR GENERAL
# =====================================================================================
PG_BASE = "https://pennygeneral.net"
PPM_URL = "https://pennypinchinmom.com/dollar-general-penny-list/"
GND_URL = "https://glitchndealz.com/penny-list-for-dollar-general"


def _pg_cards(page):
    out = []
    for m in re.finditer(r'<article class="item-card[^>]*>', page, re.S):
        a = {k: html.unescape(v) for k, v in re.findall(r'data-([a-z-]+)="([^"]*)"', m.group(0))}
        out.append(a)
    return out


def _ppm(page):
    """PennyPinchinMom: <h2>Dollar General Penny List October 20, 2026</h2><ul><li>Name UPC: 0123…</li>"""
    m = re.search(r"<h2[^>]*>\s*Dollar General Penny List ([A-Z][a-z]+ \d{1,2}, \d{4})\s*</h2>(.*?)</ul>", page, re.S)
    if not m:
        return None, []
    date = parse_long_date(m.group(1))
    rows = []
    for li in re.findall(r"<li[^>]*>(.*?)</li>", m.group(2), re.S):
        t = text(li)
        mm = re.match(r"(.*?)\s*UPC:\s*(\d{8,14}|Not provided)?", t)
        if mm:
            rows.append({"name": mm.group(1).strip(), "upc": mm.group(2) if mm.group(2) and mm.group(2)[0].isdigit() else None})
    return date, rows


def _gnd(page):
    """GlitchNDealz: <table><caption>Dollar General penny-shopping leads for October 20, 2026</caption>…"""
    m = re.search(r"<caption>[^<]*?penny[^<]*?([A-Z][a-z]+ \d{1,2}, \d{4})\s*</caption>(.*?)</table>", page, re.S)
    if not m:
        return None, []
    rows = []
    for tr in re.findall(r"<tr>(.*?)</tr>", m.group(2), re.S):
        cells = [text(c) for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", tr, re.S)]
        if len(cells) >= 3 and re.fullmatch(r"\d{8,14}", cells[2]):
            rows.append({"name": f"{cells[0]}, {cells[1]}" if cells[1] else cells[0], "upc": cells[2]})
    return parse_long_date(m.group(1)), rows


def fetch_dollar_general(today, offline=False, max_age_days=14):
    idx = fetch(PG_BASE + "/lists", "dg_pg_lists.html", offline)
    dates = sorted(set(re.findall(r'href="/lists/(\d{4}-\d{2}-\d{2})"', idx)), reverse=True)
    if not dates:
        raise FetchError("Penny General list index: no list dates found (layout changed?)")
    newest = dt.date.fromisoformat(dates[0])
    if (today - newest).days > max_age_days:
        raise FetchError(f"Penny General newest list is {newest}, older than {max_age_days} days")
    # DG penny week starts Tuesday; publishers also post Monday-night previews -> take lists from the Monday
    # before the newest list's Tuesday onward.
    tuesday = newest - dt.timedelta(days=(newest.weekday() - 1) % 7)
    week_start = tuesday - dt.timedelta(days=1)
    week = [d for d in dates if dt.date.fromisoformat(d) >= week_start]

    merged, order = {}, []

    def key_for(upc, sku, name):
        if upc:
            return "g" + gtin_key(upc)
        if sku and len(digits(sku)) >= 11:  # Penny General sometimes files an 11-digit UPC (no leading 0) as "SKU"
            return "g" + gtin_key(sku)
        if sku:
            return "s" + digits(sku)
        return "n" + norm_name(name)

    def add(name, upc, sku, date, src_name, src_url, image=None):
        k = key_for(upc, sku, name)
        it = merged.get(k)
        if not it:
            it = merged[k] = {"store": "dollar_general", "name": name, "aka": [], "upc": None, "sku": None,
                              "price": 0.01, "retail": None, "first_reported": date, "last_seen": date,
                              "image": None, "sources": []}
            order.append(k)
        if upc and not it["upc"]:
            it["upc"] = upc
        if sku and not it["sku"]:
            it["sku"] = digits(sku)
        if image and not it["image"]:
            it["image"] = image
        if norm_name(name) != norm_name(it["name"]) and name not in it["aka"]:
            it["aka"].append(name)
        it["first_reported"] = min(filter(None, [it["first_reported"], date]))
        it["last_seen"] = max(filter(None, [it["last_seen"], date]))
        if not any(s["url"] == src_url for s in it["sources"]):
            it["sources"].append({"name": src_name, "url": src_url, "date": date})

    sources = []
    for d in week:
        url = f"{PG_BASE}/lists/{d}"
        cards = _pg_cards(fetch(url, f"dg_pg_{d}.html", offline))
        n = 0
        for c in cards:
            if c.get("type") != "penny":
                continue
            u, s = digits(c.get("upc")), digits(c.get("sku"))
            add(text(c.get("name")), u or None, s or None, c.get("date") or d, f"Penny General list {d}", url,
                c.get("image") or None)
            n += 1
        sources.append({"name": f"Penny General list {d}", "url": url, "date": d, "items": n})

    for fn, url, nm, cache in [(_ppm, PPM_URL, "PennyPinchinMom", "dg_ppm.html"), (_gnd, GND_URL, "GlitchNDealz", "dg_gnd.html")]:
        try:
            date, rows = fn(fetch(url, cache, offline))
        except FetchError as e:
            print(f"  DG WARN: {nm} unavailable ({e})")
            continue
        if not date or not rows:
            print(f"  DG WARN: {nm} page parsed 0 items (layout changed?) - skipped")
            continue
        if dt.date.fromisoformat(date) < week_start:
            print(f"  DG note: {nm} list is dated {date}, before this penny week - skipped")
            continue
        for r in rows:
            add(r["name"], r["upc"], None, date, f"{nm} ({date})", url)
        sources.append({"name": f"{nm} penny list {date}", "url": url, "date": date, "items": len(rows)})

    items = []
    for k in order:
        it = merged[k]
        it["source_count"] = len({s["name"].split(" ")[0] for s in it["sources"]})
        it["id"] = "dg:" + (digits(it["upc"]) or it["sku"] or norm_name(it["name"]))
        it["sku_display"] = it["sku"] or ""
        it["notes"] = "" if it["upc"] or it["sku"] else "No UPC published; match by name/size on the shelf."
        items.append(it)
    if len(items) < 3:
        raise FetchError(f"Dollar General: only {len(items)} items parsed")
    return {"items": items, "sources": sources, "as_of": max(s["date"] for s in sources),
            "note": f"Current DG penny week starting {tuesday.isoformat()} (Tuesday)."}


# =====================================================================================
# LOWE'S  (ClearanceFinds monthly Lowe's penny list: item #, model, observed 1¢–6¢ price, dated store rows)
# =====================================================================================
CF_GUIDE = "https://clearancefinds.com/lowes-penny-deals/"


def fetch_lowes(today, offline=False, max_age_days=45):
    guide = fetch(CF_GUIDE, "lw_cf_guide.html", offline)
    links = sorted(set(re.findall(r'href="(/alerts/lowes-penny-list-[a-z]+-\d{4}/)"', guide)))
    if not links:
        raise FetchError("ClearanceFinds guide: no monthly Lowe's penny list link found")
    url = "https://clearancefinds.com" + links[-1] if len(links) == 1 else None
    if not url:  # pick the newest month
        def mkey(l):
            m = re.search(r"list-([a-z]+)-(\d{4})", l); return (int(m.group(2)), MONTHS.get(m.group(1), 0))
        url = "https://clearancefinds.com" + max(links, key=mkey)
    page = fetch(url, "lw_cf_list.html", offline)
    pub = parse_long_date((re.search(r"Published ([A-Z][a-z]+ \d{1,2}, \d{4})", page) or [None, ""])[1]) \
        or (re.search(r'"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})', page) or [None, None])[1]
    if not pub:
        raise FetchError("ClearanceFinds Lowe's list: publish date not found")
    if (today - dt.date.fromisoformat(pub)).days > max_age_days:
        raise FetchError(f"ClearanceFinds Lowe's list published {pub}, older than {max_age_days} days")
    cover = re.search(r"Scan coverage:\s*([^.<]+)", page)
    items = []
    for a in re.findall(r"<article data-category.*?</article>", page, re.S):
        item_no = (re.search(r"ITEM #(\d+)", a) or [None, None])[1]
        name = text((re.search(r"<h2>(.*?)</h2>", a, re.S) or [None, ""])[1])
        if not item_no or not name:
            continue
        model = (re.search(r"Model:\s*([^<]+)", a) or [None, None])[1]
        badge = (re.search(r'<span class="price">\s*(\d+)\s*¢', a) or [None, None])[1]
        rows = []
        for tr in re.findall(r"<tr><td>(.*?)</td><td>(.*?)</td><td>(.*?)</td><td>(.*?)</td></tr>", a, re.S):
            d, store, price, qty = (text(x) for x in tr)
            rows.append({"date": d if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) else None, "store": store,
                         "price": float(digits(price)) / 100 if re.search(r"\$\d", price) else None, "qty": qty})
        dated = [r for r in rows if r["date"]]
        prices = [r["price"] for r in rows if r["price"] is not None]
        states = {}
        for r in rows:
            m = re.search(r",\s*([A-Z]{2})$", r["store"])
            if m:
                states[m.group(1)] = states.get(m.group(1), 0) + 1
        fl_stores = sorted({r["store"] for r in rows if r["store"].endswith(", FL")})
        img = (re.search(r'<img[^>]*src="([^"]+)"', a) or [None, None])[1]
        items.append({
            "store": "lowes", "id": "lw:" + item_no, "sku": item_no, "sku_display": item_no,
            "name": name, "model": model.strip() if model else None, "upc": None,
            "category": text((re.search(r'data-category="([^"]*)"', a) or [None, ""])[1]),
            "price": min(prices) if prices else (int(badge) / 100 if badge else None), "retail": None,
            "first_reported": min(r["date"] for r in dated) if dated else None,
            "last_seen": max(r["date"] for r in dated) if dated else None,
            "listed": pub, "reports": len(rows), "states": states, "state_count": len(states),
            "florida_reports": states.get("FL", 0), "florida_stores": fl_stores,
            "image": (url + img) if img and not img.startswith("http") else img,
            "user_reported": 'data-user="1"' in a,
            "sources": [{"name": f"ClearanceFinds Lowe's penny list (published {pub})", "url": url, "date": pub}],
            "notes": "" if dated else f"Reporter gave no date/store; on ClearanceFinds list published {pub}.",
        })
    if len(items) < 5:
        raise FetchError(f"Lowe's: only {len(items)} items parsed")
    return {"items": items, "sources": [{"name": "ClearanceFinds Lowe's penny list", "url": url, "date": pub,
                                          "items": len(items), "coverage": cover.group(1).strip() if cover else None}],
            "as_of": pub, "note": "Lowe's has no official penny list; at Lowe's most 'penny' items ring up at 2¢."}


# =====================================================================================
# WALMART  (no free store-level hidden-clearance feed exists; we use dated public in-store clearance posts)
# =====================================================================================
GND_WM_CAT = "https://glitchndealz.com/category/walmart/"
GND_WM_KNOWN = ["https://glitchndealz.com/2026/10/walmart-fall-clearance-six-finds-item-ids.html"]
WM_ITEM_RE = re.compile(
    r"<strong>([^<]+?):\s*\$(\d+(?:\.\d\d)?)\s*\.?\s*</strong>\s*(?:,\s*with a \$(\d+(?:\.\d\d)?) comparison price)?"
    r".{0,200}?Walmart item ID:\s*(?:<[^>]+>)*\s*(\d{6,13})", re.S)


def _gnd_walmart_post(url, offline):
    page = fetch(url, "wm_" + re.sub(r"\W+", "_", url.rsplit("/", 1)[-1])[:60] + ".html", offline)
    pub = (re.search(r'"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})', page) or
           re.search(r'article:published_time"\s+content="(\d{4}-\d{2}-\d{2})', page) or [None, None])[1]
    found = parse_long_date((re.search(r"These [a-z]+ ([A-Z][a-z]+ \d{1,2}) in-store finds", page) or [None, ""])[1]
                            + f", {pub[:4]}" if pub else "")
    body = page.split("Use the item ID before making a trip")[0]
    rows = []
    for m in WM_ITEM_RE.finditer(body):
        rows.append({"name": text(m.group(1)), "clearance": float(m.group(2)),
                     "compare": float(m.group(3)) if m.group(3) else None, "item_id": m.group(4)})
    return pub, found, rows


def fetch_walmart(today, offline=False, max_age_days=14):
    urls = list(GND_WM_KNOWN)
    try:
        cat = fetch(GND_WM_CAT, "wm_gnd_cat.html", offline)
        urls += re.findall(r'href="(https://glitchndealz\.com/\d{4}/\d{2}/[a-z0-9-]*walmart[a-z0-9-]*clearance[a-z0-9-]*\.html)"', cat)
        urls += re.findall(r'href="(https://glitchndealz\.com/\d{4}/\d{2}/[a-z0-9-]*clearance[a-z0-9-]*walmart[a-z0-9-]*\.html)"', cat)
    except FetchError as e:
        print(f"  Walmart WARN: category page unavailable ({e})")
    items, sources, seen = [], [], set()
    for url in dict.fromkeys(urls):
        try:
            pub, found, rows = _gnd_walmart_post(url, offline)
        except FetchError as e:
            print(f"  Walmart WARN: {e}")
            continue
        if not pub or not rows or (today - dt.date.fromisoformat(pub)).days > max_age_days:
            continue
        date = found or pub
        for r in rows:
            if r["item_id"] in seen:
                continue
            seen.add(r["item_id"])
            pct = round(100 * (1 - r["clearance"] / r["compare"])) if r["compare"] else None
            items.append({
                "store": "walmart", "id": "wm:" + r["item_id"], "sku": r["item_id"], "sku_display": r["item_id"],
                "item_id": r["item_id"], "name": r["name"], "upc": None,
                "price": r["clearance"], "retail": r["compare"], "retail_label": "comparison price (per source)",
                "pct_off": pct, "first_reported": date, "last_seen": date, "listed": pub,
                "sources": [{"name": f"GlitchNDealz (in-store finds {date}, posted {pub})", "url": url, "date": pub}],
                "notes": "In-store clearance find; source names no store. Walmart clearance is store-specific - scan it in the Walmart app (Check a price) with your store selected.",
            })
        sources.append({"name": "GlitchNDealz Walmart clearance post", "url": url, "date": pub, "items": len(rows)})
    if not items:
        raise FetchError("Walmart: no dated clearance items found in the last %d days" % max_age_days)
    return {"items": items, "sources": sources, "as_of": max(s["date"] for s in sources),
            "note": "No free source publishes store-level Walmart hidden clearance for Clermont, FL; these are dated national in-store finds."}


FETCHERS = {"dollar_general": fetch_dollar_general, "lowes": fetch_lowes, "walmart": fetch_walmart}
