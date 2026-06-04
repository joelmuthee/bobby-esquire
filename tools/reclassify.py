#!/usr/bin/env python3
"""
Re-classify the live catalog against the worker /api/classify (vision+text AI),
using the PERMANENT worker /img/ photo for each item (IG CDN urls expire).
Updates category + re-derives sizes (gated by the new category, now incl.
Trousers). Prints a before->after diff; publishes via fetch-merge /api/bulk
unless --dry. Idempotent. Needs BOBBY_ADMIN_TOKEN in the env.
"""
import os, sys, json, re, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
WORKER = "https://bobbyesquire-api.stawisystems.workers.dev"
TOK = os.environ.get("BOBBY_ADMIN_TOKEN", "")
if not TOK:
    raise SystemExit("set BOBBY_ADMIN_TOKEN")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36"
TOPS  = {"Tshirts","Shirts","Polos","Hoodies","Jackets","Suits","Tracksuits"}
LOWER = {"Jeans","Trousers","Shorts","Joggers"}
FOOT  = {"Sneakers","Boots","Shoes"}

def sizes_for(caption, category):
    low = (caption or "").lower()
    padded = re.sub(r"\s+", " ", " " + re.sub(r"[,/|·]+", " ", low) + " ")
    stock = {}
    if category in TOPS or category not in (LOWER | FOOT | {"Caps"}):
        for sz in ["XS","XXL","XXXL","3XL","4XL","5XL","S","M","L","XL"]:
            if re.search(r"(?:^|\s|[^a-z0-9])" + re.escape(sz.lower()) + r"(?=$|\s|[^a-z0-9])", padded):
                stock["3XL" if sz == "XXXL" else sz] = 1
    if category in LOWER:
        for m in re.finditer(r"(?<![0-9])(\d{2})(?![0-9])", padded):
            n = int(m.group(1))
            if 28 <= n <= 44: stock[str(n)] = 1
    if category in FOOT:
        for m in re.finditer(r"(?:uk\s*(\d{1,2})|(\d{1,2})\s*uk)", low):
            n = int(m.group(1) or m.group(2))
            if 4 <= n <= 13: stock["UK%d" % n] = 1
    if not stock: stock["One Size"] = 1
    return stock

def req(path, method="GET", body=None, auth=False):
    h = {"User-Agent": UA}
    if auth: h["Authorization"] = "Bearer " + TOK
    data = None
    if body is not None:
        data = json.dumps(body).encode(); h["Content-Type"] = "application/json"
    r = urllib.request.Request(WORKER + path, data=data, method=method, headers=h)
    return json.load(urllib.request.urlopen(r, timeout=120))

# shortcode -> original IG CDN url (external; worker CANNOT fetch its own /img/
# for vision — same-worker fetch is Cloudflare error 1042).
_seed = {x["shortcode"]: (x.get("imageUrls") or [None])[0]
         for x in json.load(open(".tmp/ig_seed.json", encoding="utf-8"))}

def classify(bag):
    try:
        ig_url = _seed.get(bag["id"].replace("ig_", ""), "")
        c = req("/api/classify", "POST", {"caption": (bag.get("description") or "")[:600], "imageUrl": ig_url}, auth=True)
        return bag["id"], (c.get("category") or bag.get("category"))
    except Exception as e:
        print("  err", bag.get("id"), str(e)[:70]); return bag["id"], bag.get("category")

def main():
    data = req("/api/bags", auth=True)
    bags = data.get("bags", [])
    assert len(bags) == 148, "ABORT: expected 148, got %d" % len(bags)
    new_cat = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        for bid, cat in ex.map(classify, bags):
            new_cat[bid] = cat

    changes = []
    for b in bags:
        old = b.get("category")
        nc = new_cat.get(b["id"], old)
        ns = sizes_for(b.get("description"), nc)
        if nc != old or ns != b.get("stock"):
            changes.append((b.get("name","")[:28], old, nc, "".join("" if nc==old else "*")))
        b["category"] = nc
        b["stock"] = ns

    print("Changed %d / %d items." % (len(changes), len(bags)))
    from collections import Counter
    print("New distribution:", Counter(b["category"] for b in bags).most_common())
    cat_changes = [(n,o,nc) for (n,o,nc,_) in changes if o!=nc]
    print("Category moves (%d):" % len(cat_changes))
    for n,o,nc in cat_changes[:60]:
        print("  %-28s %s -> %s" % (n, o, nc))

    if "--dry" in sys.argv:
        print("DRY — not published."); return
    body = {"bags": bags, "settings": data.get("settings", {}), "sets": data.get("sets", []), "clients": data.get("clients", [])}
    print("publish:", req("/api/bulk", "POST", body, auth=True))

if __name__ == "__main__":
    main()
