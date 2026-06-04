#!/usr/bin/env python3
"""
Seed the Bobby Esquire catalog from the Instagram FEED API.

Per the build instruction + CATALOG-STANDARDS:
  - SOURCE from https://www.instagram.com/api/v1/feed/user/<id>/ DIRECTLY (not
    the grid), paginating via next_max_id up to the top 150 posts.
  - CLASSIFY each post's name + category with the worker's vision+text AI
    (/api/classify) — the standard quality path for IG sync. (Pure caption parse
    fails on Bobby Esquire's marketing-style captions.)
  - SIZES parsed from the caption, gated by the AI category.
  - SKIP any caption containing  \\bsold(?:\\s*out)?\\b  and any post that yields
    no real product name (NEVER an "Item <shortcode>" placeholder).
  - PUSH to /api/ig-sync in small chunks, oldest chunk first, so the catalog ends
    up newest-first in Featured order.

Idempotent: /api/ig-sync dedupes by ig_<shortcode>, so re-runs only add new posts.
"""
import sys, json, re, time, urllib.request, urllib.parse
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

IG_USER_ID = "70096390865"
WORKER = "https://bobbyesquire-api.stawisystems.workers.dev"
# Read the admin token from the env so it never lives in the repo:
#   set BOBBY_ADMIN_TOKEN=...  (the value is the worker's ADMIN_TOKEN secret)
import os as _os
ADMIN_TOKEN = _os.environ.get("BOBBY_ADMIN_TOKEN", "")
if not ADMIN_TOKEN:
    raise SystemExit("Set BOBBY_ADMIN_TOKEN env var to the worker ADMIN_TOKEN before running.")
MAX_POSTS = 150
MAX_IMAGES = 2          # bound KV writes (2 writes/image, 1000/day free tier)
CHUNK = 4               # bound worker subrequests (~50/invocation cap)

IG_HEADERS = {
    "User-Agent": "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; "
                  "samsung; SM-G930F; herolte; samsungexynos8890; en_US; 314665256)",
    "X-IG-App-ID": "936619743392459",
    "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9",
}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36"

EMOJI = re.compile("[\U0001F000-\U0001FAFF\U00002190-\U000027BF\U0001F1E6-\U0001F1FF⬀-⯿️‍]", re.UNICODE)
TOPS  = {"Tshirts","Shirts","Polos","Hoodies","Jackets","Suits","Tracksuits"}
LOWER = {"Jeans","Shorts","Joggers"}
FOOT  = {"Sneakers","Boots","Shoes"}

def clean_name(s):
    s = EMOJI.sub("", s or "")
    s = re.sub(r"[^\w\s'&/.\-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip(" .-,/")
    words = s.split()
    if len(words) > 6:
        s = " ".join(words[:6])
    return s[:55].strip()

def clean_desc(caption):
    cleaned = re.split(r"whatsapp|whatsup|whastup|wa\.me|dm to order|call/?whatsapp|0\d{8,}",
                       caption or "", flags=re.I)[0].strip(" .\n")
    cleaned = cleaned.replace("—", ", ").replace("–", "-").replace(" , ", ", ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) > 240:
        cleaned = cleaned[:240].rsplit(" ", 1)[0] + "…"
    if len(re.sub(r"[^A-Za-z]", "", cleaned)) < 4:
        return "Brand new menswear, hand-picked. Photographed exactly as it is. Pick your size below to enquire."
    return cleaned

def sizes_for(caption, category):
    """Sizes parsed from caption, gated by the (AI) category to avoid over-capture."""
    low = caption.lower()
    padded = re.sub(r"\s+", " ", " " + re.sub(r"[,/|·]+", " ", low) + " ")
    stock = {}
    if category in TOPS or category not in (LOWER | FOOT | {"Caps"}):
        for sz in ["XS","XXL","XXXL","3XL","4XL","5XL","S","M","L","XL"]:
            if re.search(r"(?:^|\s|[^a-z0-9])" + re.escape(sz.lower()) + r"(?=$|\s|[^a-z0-9])", padded):
                stock["3XL" if sz == "XXXL" else sz] = 1
    if category in LOWER:
        for m in re.finditer(r"(?<![0-9])(\d{2})(?![0-9])", padded):
            n = int(m.group(1))
            if 28 <= n <= 44:
                stock[str(n)] = 1
    if category in FOOT:
        for m in re.finditer(r"(?:uk\s*(\d{1,2})|(\d{1,2})\s*uk)", low):
            n = int(m.group(1) or m.group(2))
            if 4 <= n <= 13:
                stock["UK%d" % n] = 1
    if not stock:
        stock["One Size"] = 1
    return stock

def img_urls(item):
    out = []
    for m in (item.get("carousel_media") or [item]):
        cands = (m.get("image_versions2") or {}).get("candidates") or []
        if cands:
            out.append(cands[0]["url"])
    return out[:MAX_IMAGES]

def classify(caption, image_url):
    body = json.dumps({"caption": caption[:600], "imageUrl": image_url}).encode()
    req = urllib.request.Request(WORKER + "/api/classify", data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + ADMIN_TOKEN, "User-Agent": UA})
    return json.load(urllib.request.urlopen(req, timeout=90))

def fetch_feed():
    posts, max_id, pages = [], None, 0
    while len(posts) < MAX_POSTS and pages < 30:
        url = "https://www.instagram.com/api/v1/feed/user/%s/?count=33" % IG_USER_ID
        if max_id:
            url += "&max_id=" + urllib.parse.quote(max_id)
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=IG_HEADERS), timeout=40))
        items = d.get("items", [])
        posts.extend(items)
        pages += 1
        print("  page %d: +%d (total %d)" % (pages, len(items), len(posts)))
        if not d.get("more_available") or not d.get("next_max_id"):
            break
        max_id = d["next_max_id"]; time.sleep(1.2)
    return posts[:MAX_POSTS]

def build_one(item):
    cap = ((item.get("caption") or {}) or {}).get("text") or ""
    urls = img_urls(item)
    if not urls or not cap.strip():
        return None
    if re.search(r"\bsold(?:\s*out)?\b", cap.lower()):     # skip sold
        return None
    try:
        c = classify(cap, urls[0])
    except Exception as e:
        print("   classify err", item.get("code"), str(e)[:80]); return None
    if not c.get("is_product"):
        return None
    name = clean_name(c.get("name") or "")
    if not name or len(re.sub(r"[^A-Za-z]", "", name)) < 3:  # no real name -> skip (no placeholder)
        return None
    category = c.get("category") or "Shirts"
    ts = item.get("taken_at")
    return {
        "shortcode": item.get("code"),
        "name": name, "category": category,
        "stock": sizes_for(cap, category), "description": clean_desc(cap),
        "imageUrls": urls,
        "takenAt": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None,
    }

def post_chunk(items):
    body = json.dumps({"items": items}).encode()
    req = urllib.request.Request(WORKER + "/api/ig-sync", data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + ADMIN_TOKEN, "User-Agent": UA})
    return json.load(urllib.request.urlopen(req, timeout=120))

def main():
    print("Fetching feed for user %s ..." % IG_USER_ID)
    raw = fetch_feed()
    print("Got %d raw posts. Classifying (vision+text AI)..." % len(raw))

    parsed = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        for r in ex.map(build_one, raw):
            if r:
                parsed.append(r)
    # keep newest-first (feed order); ex.map preserves input order
    print("Kept %d sellable items, skipped %d (sold/non-product/no-name/no-image)." % (len(parsed), len(raw) - len(parsed)))

    import os
    os.makedirs(".tmp", exist_ok=True)
    json.dump(parsed, open(".tmp/ig_seed.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    if "--dry" in sys.argv:
        print("DRY RUN — wrote .tmp/ig_seed.json, no push.")
        for p in parsed[:25]:
            print("  -", p["category"].ljust(11), "|", p["name"], "| sizes:", ",".join(p["stock"]))
        return

    chunks = [parsed[i:i+CHUNK] for i in range(0, len(parsed), CHUNK)]
    added = err = 0
    for ci, chunk in enumerate(reversed(chunks)):   # oldest chunk first -> newest-first catalog
        try:
            r = post_chunk(chunk)
            added += r.get("added", 0); err += len(r.get("errors", []))
            print("  chunk %d/%d -> +%d (err %d)" % (ci+1, len(chunks), r.get("added", 0), len(r.get("errors", []))))
        except Exception as e:
            print("  chunk %d FAILED: %s" % (ci+1, str(e)[:160]))
        time.sleep(1.5)
    print("DONE. added=%d errors=%d" % (added, err))

if __name__ == "__main__":
    main()
