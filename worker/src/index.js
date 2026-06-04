// Ryker Luxury API Worker
// Public:   GET  /api/bags          → { bags, settings }
//           GET  /img/:name         → image binary
// Admin:    POST /api/bulk          → replace { bags, settings }
//           POST /api/image         → upload image → { path }
//           POST /api/buyer         → forward buyer to GHL

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });

const isAuthed = (req, env) => {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return env.ADMIN_TOKEN && auth.slice(7).trim() === env.ADMIN_TOKEN.trim();
};

// Master token = billing/agency only. Controls the suspend flag. The shop's
// ADMIN_TOKEN can NOT flip suspend, so the owner can't reactivate themselves.
const isMaster = (req, env) => {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return env.MASTER_TOKEN && auth.slice(7).trim() === env.MASTER_TOKEN.trim();
};

const b64ToBytes = b64 => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

// Decode HTML entities IG slathers across og:description and the embed Caption
// div. Named entities + decimal (&#064;) + hex (&#x40;). Per CATALOG-STANDARDS
// "Instagram quick-add — Caption pre-processing" rules. Mostly cosmetic for
// ryker (new-stock model, no @<price> parser) but keeps descriptions clean.
const decodeEntities = (s) => (s || "")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));

// ---- Caption → brand/category heuristics for IG bulk-sync ----
// Ryker Luxury is MEN'S clothing + footwear (broad catalog). Order matters:
// specific models before generic brand fallbacks; brands before generic types.
const MENSWEAR_BRANDS = [
  // Sneakers — specific models first
  ["nike air force",   "Nike Air Force",     "Sneakers"],
  ["air force",        "Nike Air Force",     "Sneakers"],
  ["nike air max",     "Nike Air Max",       "Sneakers"],
  ["air max",          "Nike Air Max",       "Sneakers"],
  ["nike dunk",        "Nike Dunk",          "Sneakers"],
  ["nike cortez",      "Nike Cortez",        "Sneakers"],
  ["cortez",           "Nike Cortez",        "Sneakers"],
  ["nike sb",          "Nike SB",            "Sneakers"],
  ["jordan 1",         "Jordan 1",           "Sneakers"],
  ["jordan 4",         "Jordan 4",           "Sneakers"],
  ["jordan 11",        "Jordan 11",          "Sneakers"],
  ["jordan",           "Jordan",             "Sneakers"],
  ["adidas yeezy",     "Adidas Yeezy",       "Sneakers"],
  ["yeezy",            "Adidas Yeezy",       "Sneakers"],
  ["adidas samba",     "Adidas Samba",       "Sneakers"],
  ["samba",            "Adidas Samba",       "Sneakers"],
  ["adidas gazelle",   "Adidas Gazelle",     "Sneakers"],
  ["gazelle",          "Adidas Gazelle",     "Sneakers"],
  ["stan smith",       "Adidas Stan Smith",  "Sneakers"],
  ["adidas superstar", "Adidas Superstar",   "Sneakers"],
  ["adidas ultraboost","Adidas Ultraboost",  "Sneakers"],
  ["adidas",           "Adidas",             "Sneakers"],
  ["puma",             "Puma",               "Sneakers"],
  ["new balance",      "New Balance",        "Sneakers"],
  [/\bnb\b/,           "New Balance",        "Sneakers"],
  ["asics",            "Asics",              "Sneakers"],
  ["reebok",           "Reebok",             "Sneakers"],
  ["fila",             "Fila",               "Sneakers"],
  ["vans",             "Vans",               "Sneakers"],
  ["converse",         "Converse",           "Sneakers"],
  // Boots
  ["timberland",       "Timberland",         "Boots"],
  ["dr martens",       "Dr Martens",         "Boots"],
  ["doc martens",      "Dr Martens",         "Boots"],
  ["ugg",              "UGG",                "Boots"],
  [/\bcat\b/,          "CAT",                "Boots"],
  // Clothing — denim
  ["levi's",           "Levi's",             "Jeans"],
  ["levis",            "Levi's",             "Jeans"],
  ["diesel",           "Diesel",             "Jeans"],
  ["wrangler",         "Wrangler",           "Jeans"],
  ["true religion",    "True Religion",      "Jeans"],
  // Clothing — designer suits / shirts
  ["hugo boss",        "Hugo Boss",          "Suits"],
  [/\bboss\b/,         "Hugo Boss",          "Suits"],
  ["armani",           "Armani",             "Suits"],
  ["versace",          "Versace",            "Shirts"],
  // Polos / shirts
  ["polo ralph lauren","Polo Ralph Lauren",  "Polos"],
  ["ralph lauren",     "Polo Ralph Lauren",  "Polos"],
  ["lacoste",          "Lacoste",            "Polos"],
  ["fred perry",       "Fred Perry",         "Polos"],
  // Casual / streetwear
  ["tommy hilfiger",   "Tommy Hilfiger",     "Shirts"],
  [/\btommy\b/,        "Tommy Hilfiger",     "Shirts"],
  ["calvin klein",     "Calvin Klein",       "Tshirts"],
  [/\bck\b/,           "Calvin Klein",       "Tshirts"],
  ["gucci",            "Gucci",              "Tshirts"],
  ["louis vuitton",    "Louis Vuitton",      "Tshirts"],
  [/\blv\b/,           "Louis Vuitton",      "Tshirts"],
  ["balenciaga",       "Balenciaga",         "Tshirts"],
  ["off white",        "Off-White",          "Tshirts"],
  ["off-white",        "Off-White",          "Tshirts"],
  ["supreme",          "Supreme",            "Hoodies"],
  ["champion",         "Champion",           "Hoodies"],
  ["stussy",           "Stüssy",             "Tshirts"],
  ["stüssy",           "Stüssy",             "Tshirts"],
  // Outerwear
  ["north face",       "The North Face",     "Jackets"],
  [/\btnf\b/,          "The North Face",     "Jackets"],
  ["carhartt",         "Carhartt",           "Jackets"],
  ["patagonia",        "Patagonia",          "Jackets"],
  // Tracksuits
  ["kappa",            "Kappa",              "Tracksuits"],
  ["ellesse",          "Ellesse",            "Tracksuits"],
  ["sergio tacchini",  "Sergio Tacchini",    "Tracksuits"],
  // Generic type fallbacks (when no brand)
  ["tracksuit",        null,                 "Tracksuits"],
  ["jogger",           null,                 "Joggers"],
  ["hoodie",           null,                 "Hoodies"],
  ["sweatshirt",       null,                 "Hoodies"],
  ["jacket",           null,                 "Jackets"],
  ["bomber",           null,                 "Jackets"],
  ["parka",            null,                 "Jackets"],
  ["overcoat",         null,                 "Jackets"],
  [/\bcoat\b/,         null,                 "Jackets"],
  [/\bsuit\b/,         null,                 "Suits"],
  ["blazer",           null,                 "Suits"],
  [/\bpolo\b/,         null,                 "Polos"],
  [/\btee\b/,          null,                 "Tshirts"],
  ["tshirt",           null,                 "Tshirts"],
  ["t-shirt",          null,                 "Tshirts"],
  [/\bshirt\b/,        null,                 "Shirts"],
  ["denim",            null,                 "Jeans"],
  [/\bjeans?\b/,       null,                 "Jeans"],
  ["chino",            null,                 "Trousers"],
  [/\btrousers?\b/,    null,                 "Trousers"],
  [/\bslacks?\b/,      null,                 "Trousers"],
  [/\bshorts?\b/,      null,                 "Shorts"],
  ["sneaker",          null,                 "Sneakers"],
  ["trainer",          null,                 "Sneakers"],
  [/\bboots?\b/,       null,                 "Boots"],
  [/\bcaps?\b/,        null,                 "Caps"],
  [/\bhats?\b/,        null,                 "Caps"],
  // Generic "shoes" last — only used if no other footwear type matched
  [/\bshoes?\b/,       null,                 "Shoes"],
];

function deriveBrand(caption) {
  let text = (caption || "").toLowerCase().trim();
  // NOTE: no leading-handle strip here. Feed-API captions (/api/v1/feed/user/)
  // have no "username " prefix, so stripping the first word eats the real
  // product word. The handle strip belongs only on embed-page captions
  // (handled client-side in the admin quick-add).
  const padded = " " + text + " ";
  for (const [key, name, cat] of MENSWEAR_BRANDS) {
    if (key instanceof RegExp) {
      if (key.test(padded)) return [name, cat];
    } else if (padded.includes(key)) {
      return [name, cat];
    }
  }
  return [null, null];
}

// Ryker is NEW-STOCK — captions like "Sizes M, L, XL" or "S/M/L/XL" mean the
// owner has stock in each of those sizes. Default qty=1 per detected size;
// owner adjusts in admin. Returns { name, category, stock: { sz: qty }, description }.
function parseCaptionForBag(caption) {
  const text = (caption || "").trim();
  const lower = text.toLowerCase();
  // Cut everything after the first WA/phone/CTA marker — captions often end
  // with a phone number block that has noise like "0712...".
  const cleaned = text.split(/whatsapp|whastup|wa\.me|0\d{8,}/i)[0].trim().replace(/[.\s]+$/, "");
  let [brand, category] = deriveBrand(caption);
  if (!brand) {
    const first = cleaned.split(/\.\.|\.\s|,|\n|·/)[0].trim();
    brand = first ? first.slice(0, 60).replace(/\b\w/g, c => c.toUpperCase()) : "New Item";
  }

  const stock = {};

  // --- Apparel letter sizes: XS, S, M, L, XL, XXL, 3XL, 4XL, 5XL ---
  // Match any standalone size token. Captions: "Sizes M, L, XL", "S/M/L/XL",
  // "available in M L XL", "sizes: S to XXL".
  const APPAREL = ["XS", "XXL", "XXXL", "3XL", "4XL", "5XL", "S", "M", "L", "XL"];
  // Use a tagged scan so "size XS" isn't double-counted as XS + S.
  const padded = " " + lower.replace(/[,/|·]+/g, " ").replace(/\s+/g, " ") + " ";
  for (const sz of APPAREL) {
    const re = new RegExp(`(?:^|\\s|[^a-z0-9])${sz.toLowerCase()}(?=$|\\s|[^a-z0-9])`, "g");
    if (re.test(padded)) {
      // Normalise XXXL → 3XL for consistency with admin stock grid
      const key = sz === "XXXL" ? "3XL" : sz;
      stock[key] = 1;
    }
  }

  // --- Numeric jeans waist sizes (28-44) — only when category looks like jeans/shorts/joggers ---
  const isLowerBody = /jeans?|denim|shorts?|joggers?|trouser|pants|chinos|slacks?|waist/i.test(text)
    || /^(Jeans|Trousers|Shorts|Joggers)$/.test(category || "");
  if (isLowerBody) {
    const seen = new Set();
    // Lookahead for the trailing boundary so consecutive numbers ("32 34 36")
    // don't get skipped by the regex consuming the space between them.
    const numRe = /(?<![0-9])(\d{2})(?![0-9])/g;
    let m;
    while ((m = numRe.exec(padded)) !== null) {
      const n = parseInt(m[1], 10);
      if (n >= 28 && n <= 44 && !seen.has(n)) {
        stock[String(n)] = 1;
        seen.add(n);
      }
    }
  }

  // --- Shoe sizes UK4-UK13 — only when category looks like footwear ---
  const isFoot = /sneaker|trainer|boots?|shoes?|sandal|slide/i.test(text)
    || /^(Sneakers|Boots|Shoes)$/.test(category || "");
  if (isFoot) {
    // "UK 9", "UK9", "9uk", "size 9"
    const ukRe = /(?:uk\s*(\d{1,2})|(\d{1,2})\s*uk)/gi;
    let m;
    while ((m = ukRe.exec(lower)) !== null) {
      const n = parseInt(m[1] || m[2], 10);
      if (n >= 4 && n <= 13) stock[`UK${n}`] = 1;
    }
  }

  // Default to One Size only if literally nothing matched. Owner edits in admin.
  if (!Object.keys(stock).length) stock["One Size"] = 1;

  return {
    name: brand,
    category: category || null,
    stock,
    description: "Premium menswear, hand-selected. Photographed exactly as it is. Pick your size below to enquire.",
  };
}

// Is this caption plausibly a product post?
function looksLikeProduct(caption) {
  if (!caption) return false;
  const lower = caption.toLowerCase();
  // Size signal (apparel letter, jeans waist number, or UK shoe size)
  if (/(?:^|\s|[,/|·])(?:xs|s|m|l|xl|xxl|3xl|4xl|5xl)(?:$|\s|[,/|·])/i.test(" " + lower + " ")) return true;
  if (/\b(?:uk\s*\d{1,2}|\d{1,2}\s*uk|size\s+\d{2,})\b/i.test(lower)) return true;
  if (/\bsizes?\s*[:\-]?\s*/i.test(lower)) return true;
  for (const [key] of MENSWEAR_BRANDS) {
    if (key instanceof RegExp ? key.test(lower) : lower.includes(key)) return true;
  }
  return false;
}

// ---- IG response normalisers (module-level so endpoints share them) ----
function extractFromTimelineNode(node) {
  const shortcode = node.shortcode || node.code;
  let imageUrls = [];
  const children = node.edge_sidecar_to_children?.edges || [];
  if (children.length) {
    imageUrls = children.map(({ node: c }) => c.display_url || c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
  } else if (node.display_url) {
    imageUrls = [node.display_url];
  } else if (node.image_versions2?.candidates?.length) {
    imageUrls = [node.image_versions2.candidates[0].url];
  }
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || node.caption?.text || "";
  return {
    shortcode,
    imageUrl: imageUrls[0],
    imageUrls,
    caption,
    isCarousel: imageUrls.length > 1,
    postUrl: `https://www.instagram.com/p/${shortcode}/`,
    takenAt: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : (node.taken_at ? new Date(node.taken_at * 1000).toISOString() : null),
  };
}

function extractFromFeedItem(m) {
  const carousel = m.carousel_media || [];
  let imageUrls = [];
  if (carousel.length) {
    imageUrls = carousel.map(c => c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
  } else if (m.image_versions2?.candidates?.length) {
    imageUrls = [m.image_versions2.candidates[0].url];
  }
  const shortcode = m.code;
  const caption = m.caption?.text || "";
  return {
    shortcode,
    imageUrl: imageUrls[0],
    imageUrls,
    caption,
    isCarousel: imageUrls.length > 1,
    postUrl: `https://www.instagram.com/p/${shortcode}/`,
    takenAt: m.taken_at ? new Date(m.taken_at * 1000).toISOString() : null,
  };
}

// 3-tier IG feed pull: embedded timeline → GraphQL pagination → /api/v1/feed/user/.
// Always prefer user_id over username — username triggers a rate-limited profile call.
async function fetchIgFeed({ username, userId: directUserId, count = 50, maxId = "" } = {}) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
    "X-IG-App-ID": "936619743392459",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": `https://www.instagram.com/${username || ""}/`,
  };
  let userId, user = null, profile = null;
  if (directUserId) {
    userId = directUserId;
    profile = { id: userId, username: username || null };
  } else {
    const pRes = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, { headers });
    if (!pRes.ok) return { error: `profile lookup ${pRes.status}` };
    const pData = await pRes.json();
    user = pData?.data?.user;
    if (!user?.id) return { error: "user id not found" };
    userId = user.id;
    profile = {
      id: userId,
      username: user.username,
      fullName: user.full_name,
      biography: user.biography,
      profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url,
      followers: user.edge_followed_by?.count,
    };
  }
  const qsTail = `?count=${count}${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ""}`;
  let items = [];
  let moreAvailable = false;
  let nextMaxId = null;
  const embedded = user?.edge_owner_to_timeline_media;
  if (!maxId && embedded?.edges?.length) {
    items = embedded.edges.map(({ node }) => extractFromTimelineNode(node)).filter(it => it.imageUrl);
    moreAvailable = !!embedded.page_info?.has_next_page;
    nextMaxId = embedded.page_info?.end_cursor || null;
  }
  if (items.length < count && (maxId || moreAvailable || directUserId)) {
    const cursor = maxId || nextMaxId;
    const variables = encodeURIComponent(JSON.stringify({ id: userId, first: count, after: cursor || null }));
    const gqlRes = await fetch(`https://www.instagram.com/graphql/query/?query_hash=003056d32c2554def87228bc3fd9668a&variables=${variables}`, { headers });
    if (gqlRes.ok) {
      const gData = await gqlRes.json();
      const media = gData?.data?.user?.edge_owner_to_timeline_media;
      if (media?.edges?.length) {
        items = items.concat(media.edges.map(({ node }) => extractFromTimelineNode(node)).filter(it => it.imageUrl));
        moreAvailable = !!media.page_info?.has_next_page;
        nextMaxId = media.page_info?.end_cursor || null;
      }
    }
  }
  if (!items.length) {
    let fRes = await fetch(`https://www.instagram.com/api/v1/feed/user/${userId}/${qsTail}`, { headers });
    if (!fRes.ok) fRes = await fetch(`https://i.instagram.com/api/v1/feed/user/${userId}/${qsTail}`, { headers });
    if (!fRes.ok) return { error: `feed fetch ${fRes.status}`, profile };
    const fData = await fRes.json();
    items = (fData.items || []).map(extractFromFeedItem).filter(it => it.imageUrl);
    moreAvailable = !!fData.more_available;
    nextMaxId = fData.next_max_id || null;
  }
  return { profile, items, count: items.length, more_available: moreAvailable, next_max_id: nextMaxId };
}

// Base64-encode a Uint8Array in chunks (avoids call-stack overflow on large images).
function arrayToB64(buf) {
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// Vision-model classifier — Llama 3.2 11B Vision sees the photo so it can
// distinguish polos vs t-shirts vs shirts, sneakers vs boots vs formal shoes.
// Returns { is_product, name, category, reason, via } or { _debug } on failure.
async function classifyPostWithVision(env, caption, imageUrl) {
  if (!env.AI || !imageUrl) return null;
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return { _debug: `img fetch ${imgRes.status}` };
    const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
    const trimmed = (caption || "").replace(/\s+/g, " ").slice(0, 400);
    const prompt = `You sort Instagram posts from Bobby Esquire — a Nairobi men's fashion shop selling men's clothing AND footwear. You're given ONE photo + ONE caption. Decide:
1. Is this a single product (one specific item or one stocked SKU) for sale? (is_product true|false)
2. What brand / model is it? (name — short, e.g. "Tommy Hilfiger Polo", "Nike Air Force", or "New Item" if unknown)
3. What category? Pick EXACTLY one from this list — never invent another:
   Tshirts, Shirts, Polos, Jeans, Trousers, Shorts, Joggers, Tracksuits, Hoodies, Jackets, Suits, Shoes, Sneakers, Boots, Caps

Category guide (look carefully — this is the hardest call):
- Tshirts: short-sleeve crew/v-neck pullover, NO collar, NO buttons. Plain tees, graphic tees.
- Polos: short-sleeve pullover WITH a soft fold-down collar + 2-3 buttons at the neck. Lacoste-style.
- Shirts: long-sleeve OR short-sleeve with FULL button-up front + structured collar. Includes oxfords, casual button-downs, formal shirts.
- Hoodies: pullover or zip with a HOOD; also sweatshirts (crewnecks without zips).
- Jackets: outerwear — bombers, denim/leather jackets, parkas, puffers, blazers count as Suits if matched to trousers, otherwise Jackets.
- Suits: matched jacket + trousers, or formal suits/blazers.
- Jeans: DENIM trousers only (any wash).
- Trousers: non-denim full-length bottoms — chinos, dress trousers, slacks, linen/cotton pants. If you see folded/hanging trousers that are NOT denim and NOT shorts, this is Trousers (not Shirts).
- Shorts: above-the-knee bottoms (denim, cargo, sweat).
- Joggers: tapered casual sweatpants with elastic ankle cuffs.
- Tracksuits: matching top + bottom athletic set (Kappa, Ellesse).
- Sneakers: casual athletic / lifestyle shoes — Air Force, Jordan, Yeezy, Adidas, Puma, Nike, dunks, basketball shoes, running.
- Boots: ankle-high or taller — Timberland, Dr Martens, work boots, hiking boots, chukkas.
- Shoes: formal/dress shoes ONLY — Oxford, derby, brogue, loafers, monk-strap. Never use "Shoes" for sneakers.
- Caps: caps, hats, beanies.

NEVER use Crossbody, Tote, Clutch, Hobo, Heels, Sandals, Bags, Handbags — Bobby Esquire only sells men's clothing and footwear. If the photo shows a women's bag or women's heels, set is_product=false.

is_product=false ONLY for: shop intros, marketing banners, owner photos, restock teasers, holiday greetings, "DM us" announcements without a specific item.

Caption: """${trimmed}"""

Reply with strict minified JSON, no prose, no code fences:
{"is_product":true|false,"name":"<brand+model or New Item>","category":"<exactly one from the list>","reason":"<3-6 words>"}`;
    const result = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      prompt,
      image: Array.from(imgBytes),
      max_tokens: 220,
      temperature: 0.1,
    });
    let parsed = null;
    if (result?.response && typeof result.response === "object") {
      parsed = result.response;
    } else {
      let text = "";
      if (typeof result?.response === "string") text = result.response;
      else if (typeof result?.description === "string") text = result.description;
      else if (typeof result === "string") text = result;
      text = text.trim();
      if (text) {
        const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch (_) {}
        }
      }
    }
    if (!parsed) return { _debug: "could not parse vision output", raw: JSON.stringify(result).slice(0, 400) };
    return {
      is_product: !!(parsed.is_product ?? parsed.is_shoe ?? parsed.is_item),
      name: parsed.name || null,
      category: parsed.category || null,
      reason: parsed.reason || "",
      via: "vision",
    };
  } catch (err) {
    return { _debug: `vision throw: ${err.message}` };
  }
}

// Text-only LLM classifier — fallback when vision call fails. Best for decoding
// caption shorthand (brand names) when the photo can't carry the call.
async function classifyPostWithAi(env, caption) {
  if (!env.AI || !caption) return null;
  const trimmed = caption.replace(/\s+/g, " ").slice(0, 400);
  const prompt = `You sort Instagram posts from Bobby Esquire — a Nairobi men's fashion shop selling men's clothing AND footwear. Each post is either ONE specific product (or one stocked SKU) listed for sale, OR a non-product post.

Reply with strict minified JSON only, no prose, no code fences.

Schema:
{"is_product": true|false, "name": "<short brand + model OR generic descriptor>", "category": "<exactly one of: Tshirts, Shirts, Polos, Jeans, Trousers, Shorts, Joggers, Tracksuits, Hoodies, Jackets, Suits, Shoes, Sneakers, Boots, Caps>", "reason": "<3-6 words>"}

NEVER output Crossbody, Tote, Clutch, Hobo, Heels, Sandals, Bags, Handbags — Bobby Esquire only sells men's clothing and footwear.

Rules:
- is_product = true when the caption mentions a clothing/footwear item and at least one size signal (S, M, L, XL, "size 32", "UK 9", "Sizes M L XL", etc.) OR a known brand/model.
- is_product = false for shop intros, owner photos, marketing banners, holiday greetings, generic "DM us" announcements with no specific product.
- Decode shorthand: "Tommy" → Tommy Hilfiger; "CK" → Calvin Klein; "LV" → Louis Vuitton; "Polo" alone usually = Polo Ralph Lauren when capitalised at the start; "NB" → New Balance; "TNF" → The North Face.
- name MUST be brand+model when known. Strip prices, sizes, phone numbers, hashtags. If brand unknown but item type clear, name = generic description (e.g. "Slim-Fit Jeans", "Cargo Shorts"). If truly unknown, name = "New Item".
- category: match the product to the EXACT list. T-shirts and tees → Tshirts. Anything with a soft collar + neck buttons → Polos. Button-up shirts → Shirts. Generic "shoes" mention with no clear sneaker/boot signal → Shoes (use sparingly — most are Sneakers).

Caption: """${trimmed}"""`;
  try {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 160,
    });
    const text = (result?.response || "").trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      is_product: !!(parsed.is_product ?? parsed.is_shoe ?? parsed.is_item),
      name: parsed.name || null,
      category: parsed.category || null,
      reason: parsed.reason || "",
    };
  } catch (_) {
    return null;
  }
}

// Ryker stocks men's clothing + footwear only. Coerce any AI-suggested category
// that's outside the allowed list to either the closest legal option or null.
const RYKER_CATEGORIES = new Set([
  "Tshirts","Shirts","Polos","Jeans","Trousers","Shorts","Joggers","Tracksuits",
  "Hoodies","Jackets","Suits","Shoes","Sneakers","Boots","Caps",
]);
function coerceCategory(c) {
  if (!c) return null;
  const raw = String(c).trim();
  if (RYKER_CATEGORIES.has(raw)) return raw;
  const lower = raw.toLowerCase();
  // Strip the bag / women's categories outright
  if (/^(cross\s*body|tote|clutch|hobo|bags?|handbags?|purse|heels?|sandals?|stilettos?|wedges?|pumps?)$/i.test(lower)) return null;
  // Plural / singular / spelling variants
  if (/^(tee|tees|t[\s\-]?shirts?)$/i.test(lower)) return "Tshirts";
  if (/^(shirts?|button[\s\-]?ups?|oxfords?)$/i.test(lower)) return "Shirts";
  if (/^polos?$/i.test(lower)) return "Polos";
  if (/^(jeans?|denim)$/i.test(lower)) return "Jeans";
  if (/^(trousers?|chinos?|slacks?|pants?|dress\s*pants?|linen\s*(pants?|trousers?))$/i.test(lower)) return "Trousers";
  if (/^shorts?$/i.test(lower)) return "Shorts";
  if (/^joggers?$/i.test(lower)) return "Joggers";
  if (/^(tracksuits?|track\s*suits?)$/i.test(lower)) return "Tracksuits";
  if (/^(hoodies?|sweatshirts?|sweaters?|pullovers?)$/i.test(lower)) return "Hoodies";
  if (/^(jackets?|coats?|bombers?|parkas?|puffers?)$/i.test(lower)) return "Jackets";
  if (/^(suits?|blazers?)$/i.test(lower)) return "Suits";
  if (/^(sneakers?|trainers?)$/i.test(lower)) return "Sneakers";
  if (/^boots?$/i.test(lower)) return "Boots";
  if (/^(formal|dress|oxford|derby|brogue|loafers?|moccasins?|monk[\s\-]?straps?)$/i.test(lower)) return "Shoes";
  if (/^(caps?|hats?|beanies?|snapbacks?)$/i.test(lower)) return "Caps";
  // Don't invent — return null so the owner picks
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // Public: catalog data
    if (request.method === "GET" && path === "/api/bags") {
      const raw = await env.BAGS.get("data");
      const data = raw ? JSON.parse(raw) : { bags: [], settings: {} };
      // Billing kill-switch: stored in its own KV key so the owner's admin
      // publishes (which only write "data") can never clear it.
      data.suspended = (await env.BAGS.get("suspended")) === "1";
      // PRIVACY: strip buyer PII (sales[].buyerName/buyerPhone/notes, soldTo) for
      // unauthed callers. The storefront only reads sold/price/salePrice/sales.length,
      // never buyer details. The admin sends a Bearer token and gets the full data.
      const admin = isAuthed(request, env);
      if (!admin && Array.isArray(data.bags)) {
        data.bags = data.bags.map(b => {
          if (!b || typeof b !== "object") return b;
          let nb = b;
          if ("soldTo" in nb) { const { soldTo, ...r } = nb; nb = r; }
          if (Array.isArray(nb.sales)) nb = { ...nb, sales: nb.sales.map(s => {
            if (!s || typeof s !== "object") return s;
            const { buyerName, buyerPhone, notes, name, phone, buyer, ...keep } = s;
            return keep;
          }) };
          return nb;
        });
      }
      // The manually-added clients list is owner-only CRM data (names + phones) —
      // never expose it publicly. Admin (Bearer) keeps it for the Clients tab.
      if (!admin && data.clients) delete data.clients;
      return json(data, 200, admin ? { "Cache-Control": "no-store" } : { "Cache-Control": "public, max-age=10" });
    }

    // Billing only: flip the suspend flag. Authed by MASTER_TOKEN (not the shop admin token).
    if (request.method === "POST" && path === "/api/suspend") {
      if (!isMaster(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const suspended = !!body.suspended;
      await env.BAGS.put("suspended", suspended ? "1" : "0");
      return json({ ok: true, suspended });
    }

    // Public: serve images
    const imgMatch = path.match(/^\/img\/(.+)$/);
    if (request.method === "GET" && imgMatch) {
      const name = decodeURIComponent(imgMatch[1]);
      const b64 = await env.BAGS.get(`img:${name}`);
      if (!b64) return new Response("Not found", { status: 404, headers: CORS });
      const mime = (await env.BAGS.get(`mime:${name}`)) || "image/jpeg";
      return new Response(b64ToBytes(b64), {
        status: 200,
        headers: { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable", ...CORS },
      });
    }

    // Per-item share page for WhatsApp/social link previews. The catalog Enquire
    // link ends with `${API_BASE}/p/<id>`; WhatsApp crawls this HTML, reads the OG
    // tags, and renders a preview card with the product photo + name + price.
    // A bare image URL doesn't preview reliably; an OG-tagged page always does.
    if (request.method === "GET" && path.startsWith("/p/")) {
      const SITE = "https://bobbyesquire.essenceautomations.com";
      const esc = (s) => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const id = decodeURIComponent(path.slice(3));
      const raw = await env.BAGS.get("data");
      const bags = raw ? (JSON.parse(raw).bags || []) : [];
      const item = bags.find(b => b.id === id);
      if (!item) return Response.redirect(SITE + "/#shop", 302);
      const img = item.image || (item.images && item.images[0]) || `${SITE}/images/og-image.jpg`;
      const mime = /\.png$/i.test(img) ? "image/png" : /\.webp$/i.test(img) ? "image/webp" : "image/jpeg";
      const price = item.price > 0 ? ` · Ksh ${Number(item.price).toLocaleString("en-US")}` : "";
      const title = esc(item.name + price);
      const desc = esc((item.description || "Premium menswear in Nairobi. Tap to view and enquire on WhatsApp.").slice(0, 160));
      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:type" content="product">
<meta property="og:site_name" content="Bobby Esquire">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:secure_url" content="${esc(img)}">
<meta property="og:image:type" content="${mime}">
<meta property="og:image:width" content="1080">
<meta property="og:image:height" content="1080">
<meta property="og:url" content="${SITE}/#shop">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:image" content="${esc(img)}">
<title>${title} · Bobby Esquire</title>
<meta http-equiv="refresh" content="0; url=${SITE}/#shop">
</head><body style="font-family:system-ui;background:#0e0f23;color:#dfe1f5;text-align:center;padding:40px">Opening Bobby Esquire…</body></html>`;
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
    }

    if (path === "/api/health") return json({ ok: true, time: new Date().toISOString() });

    // Agency master-login check (server-side so the master password is never in
    // the public admin.js). Owner password is checked client-side in admin.js.
    // Accepts the memorable agency MASTER_PASSWORD or the long fleet MASTER_TOKEN.
    if (request.method === "POST" && path === "/api/check-password") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const pw = String(body.password || "");
      const mp = (env.MASTER_PASSWORD || "").trim();
      const mt = (env.MASTER_TOKEN || "").trim();
      const ok = (!!mp && pw === mp) || (!!mt && pw === mt);
      return json({ ok });
    }

    // Buyer capture — GHL forwarding is NEUTRALISED until Bobby Esquire has its
    // own GHL form (the paid CRM feature). Until then this acks without forwarding
    // so buyer PII never lands in another client's CRM. The admin still records
    // every sale + buyer to KV, so nothing is lost. To enable: re-add the GHL
    // FormData POST with Bobby's own locationId/formId.
    if (request.method === "POST" && path === "/api/buyer") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const { name, phone } = body;
      if (!name && !phone) return json({ error: "name or phone required" }, 400);
      return json({ ok: true, forwarded: false });
    }

    // ---- Insights: site-wide event tracking (aggregated in KV) ----
    // Public visitors POST events here; the admin reads the aggregate back.
    // Unlike the old per-browser localStorage counters, this sums every
    // visitor on every device into one shared tally under the "stats" key.
    const TRACK_METRICS = new Set(["itemViews", "itemEnquiries", "itemWishlist", "itemIgClicks", "searchNoResults"]);
    if (request.method === "POST" && path === "/api/track") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const metric = String(body.metric || "");
      const key = String(body.key || "").slice(0, 80).trim();
      if (!TRACK_METRICS.has(metric) || !key) return json({ error: "bad metric/key" }, 400);
      // KV read-modify-write. Low-traffic shop, so the occasional lost
      // concurrent increment is acceptable; KV has no atomic counter.
      let stats;
      try { stats = JSON.parse(await env.BAGS.get("stats")) || {}; } catch { stats = {}; }
      stats[metric] = stats[metric] || {};
      // Cap free-text search keys so a bot can't bloat the blob unbounded.
      if (metric === "searchNoResults" && !(key in stats[metric]) && Object.keys(stats[metric]).length >= 800) {
        return json({ ok: true, capped: true });
      }
      stats[metric][key] = (stats[metric][key] || 0) + 1;
      stats._lastUpdated = new Date().toISOString();
      await env.BAGS.put("stats", JSON.stringify(stats));
      return json({ ok: true });
    }

    // Admin: read aggregated site-wide insights
    if (request.method === "GET" && path === "/api/insights") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let stats;
      try { stats = JSON.parse(await env.BAGS.get("stats")) || {}; } catch { stats = {}; }
      return json(stats);
    }

    // Admin: reset aggregated insights (clears the shop-wide tally)
    if (request.method === "POST" && path === "/api/insights-reset") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      await env.BAGS.put("stats", JSON.stringify({ _lastUpdated: new Date().toISOString() }));
      return json({ ok: true });
    }

    // Admin: replace all data
    if (request.method === "POST" && path === "/api/bulk") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      if (!Array.isArray(body.bags)) return json({ error: "bags must be array" }, 400);
      const payload = {
        bags: body.bags,
        settings: body.settings || {},
      };
      if (Array.isArray(body.sets)) payload.sets = body.sets;
      if (Array.isArray(body.clients)) payload.clients = body.clients;
      await env.BAGS.put("data", JSON.stringify(payload));
      return json({ ok: true, count: body.bags.length, sets: payload.sets?.length || 0 });
    }

    // Admin: upload image
    if (request.method === "POST" && path === "/api/image") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const { base64, ext } = body;
      if (!base64) return json({ error: "base64 required" }, 400);
      const safeExt = (ext || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const name = `item_${Date.now()}.${safeExt}`;
      const mime = safeExt === "png" ? "image/png" : safeExt === "webp" ? "image/webp" : "image/jpeg";
      await env.BAGS.put(`img:${name}`, base64);
      await env.BAGS.put(`mime:${name}`, mime);
      return json({ path: `/img/${name}`, name });
    }

    // ---- IG quick-add: server-side fetch of an Instagram public post ----
    // Lets the admin paste an IG URL and auto-fill the form (name, image, caption).
    // We can't fetch IG from a browser due to CORS; the Worker is server-side so it can.
    if (request.method === "GET" && path === "/api/ig-fetch") {
      const igUrl = url.searchParams.get("url");
      if (!igUrl) return json({ error: "url required" }, 400);

      // Accept all IG public URL shapes that carry a shortcode:
      //   /p/<code>/         photo posts
      //   /reel/<code>/      single reel
      //   /reels/<code>/     plural — some share sheets emit this
      //   /tv/<code>/        IGTV
      //   /share/reel/<code>/, /share/p/<code>/   share-sheet shortlinks
      const m = igUrl.match(/instagram\.com\/(?:share\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
      if (!m) return json({ error: "not an Instagram post URL" }, 400);
      const code = m[1];

      const headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "max-age=0",
        "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      };

      try {
        let caption = "", imageUrl = "", imageUrls = [];

        // Try the embed page first (designed to be embeddable, more bot-friendly)
        const embedRes = await fetch(`https://www.instagram.com/p/${code}/embed/captioned/`, { headers });
        if (embedRes.ok) {
          const html = await embedRes.text();
          const img = html.match(/<img[^>]+class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]+src=["']([^"']+)["']/i)
            || html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
          if (img) imageUrl = img[1].replace(/&amp;/g, "&");
          const capDiv = html.match(/<div[^>]+class=["'][^"']*Caption[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
          if (capDiv) caption = decodeEntities(capDiv[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
          if (!caption) {
            const desc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            if (desc) caption = decodeEntities(desc[1]);
          }
        }

        // Try the GraphQL-ish JSON endpoint for the full post data (gives all carousel images)
        // This URL works for some public posts — IG has been gradually restricting it.
        try {
          const jsonRes = await fetch(`https://www.instagram.com/p/${code}/?__a=1&__d=dis`, {
            headers: { ...headers, "X-IG-App-ID": "936619743392459" },
          });
          if (jsonRes.ok) {
            const text = await jsonRes.text();
            if (text.trim().startsWith("{")) {
              const data = JSON.parse(text);
              const media = data?.graphql?.shortcode_media || data?.items?.[0] || data?.shortcode_media;
              if (media) {
                // Carousel — sidecar children each have image_versions2 / display_url
                const children = media.edge_sidecar_to_children?.edges?.map(e => e.node) || media.carousel_media || [];
                if (children.length) {
                  imageUrls = children.map(c =>
                    c.display_url
                    || c.image_versions2?.candidates?.[0]?.url
                  ).filter(Boolean);
                }
                // Single-image post — display_url
                if (!imageUrls.length) {
                  const single = media.display_url || media.image_versions2?.candidates?.[0]?.url;
                  if (single) imageUrls = [single];
                }
                // Caption
                if (!caption) {
                  const cap = media.edge_media_to_caption?.edges?.[0]?.node?.text
                    || media.caption?.text;
                  if (cap) caption = cap;
                }
              }
            }
          }
        } catch (_) { /* fall through to whatever we got from embed */ }

        // Final fallback: the public post page OG tags
        if (!imageUrl && !imageUrls.length) {
          const pageRes = await fetch(`https://www.instagram.com/p/${code}/`, { headers });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const img = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
            const desc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            if (img) imageUrl = img[1].replace(/&amp;/g, "&");
            if (desc && !caption) {
              caption = decodeEntities(desc[1]);
              const m1 = caption.match(/^"(.+)"\s*-\s*@/s);
              if (m1) caption = m1[1];
            }
          }
        }

        // Normalize: prefer the JSON-derived list (full carousel) over the single embed cover
        if (!imageUrls.length && imageUrl) imageUrls = [imageUrl];
        if (!imageUrls.length) return json({ error: "Instagram blocked the request. Paste images manually instead." }, 502);

        return json({
          code,
          imageUrl: imageUrls[0],
          imageUrls,
          caption,
          postUrl: `https://www.instagram.com/p/${code}/`,
          isCarousel: imageUrls.length > 1,
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG image proxy: pipe an IG CDN image through the worker so the admin
    //      can download it without hitting CORS (IG CDN doesn't send ACAO).
    if (request.method === "GET" && path === "/api/ig-proxy") {
      const target = url.searchParams.get("url");
      if (!target) return json({ error: "url required" }, 400);
      try {
        const u = new URL(target);
        if (!/cdninstagram\.com$|fbcdn\.net$/.test(u.hostname)) {
          return json({ error: "host not allowed" }, 400);
        }
        const res = await fetch(target, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://www.instagram.com/",
          },
        });
        if (!res.ok) return json({ error: `upstream ${res.status}` }, 502);
        return new Response(res.body, {
          headers: {
            "Content-Type": res.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG feed: server-side profile-feed pull ----
    // GET /api/ig-feed?username=...&user_id=...&count=50&max_id=...
    if (request.method === "GET" && path === "/api/ig-feed") {
      const username = url.searchParams.get("username");
      const count = Math.min(parseInt(url.searchParams.get("count") || "50", 10), 100);
      const maxId = url.searchParams.get("max_id") || "";
      const directUserId = url.searchParams.get("user_id") || "";
      if (!username && !directUserId) return json({ error: "username or user_id required" }, 400);
      try {
        const result = await fetchIgFeed({ username, userId: directUserId, count, maxId });
        return json(result, result.error ? 502 : 200);
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // One-time Llama vision license acceptance. CF Workers AI requires
    // calling the model with prompt='agree' once to accept the EULA before
    // any further inference works.
    if (request.method === "GET" && path === "/api/ig-accept-license") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      try {
        const r = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree", max_tokens: 8 });
        return json({ ok: true, response: r });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // Debug: classify a single IG shortcode through both vision + text models.
    // GET /api/ig-classify?shortcode=...&caption=... (caption optional, admin auth)
    if (request.method === "GET" && path === "/api/ig-classify") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const sc = url.searchParams.get("shortcode");
      const capOverride = url.searchParams.get("caption");
      const userIdQ = url.searchParams.get("user_id") || "70096390865";
      if (!sc) return json({ error: "shortcode required" }, 400);
      try {
        const feed = await fetchIgFeed({ userId: userIdQ, count: 50 });
        const found = (feed.items || []).find(i => i.shortcode === sc);
        const imageUrl = found?.imageUrl || null;
        const caption = capOverride || found?.caption || "";
        const vision = await classifyPostWithVision(env, caption, imageUrl);
        const text = await classifyPostWithAi(env, caption);
        const heuristic = parseCaptionForBag(caption);
        return json({ shortcode: sc, caption, imageUrl, vision, text_only: text, heuristic });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG sync: discover new posts (admin preview) ----
    // GET /api/ig-discover?user_id=...&limit=20  (or username=...)
    // Returns up to `limit` posts whose ig_<shortcode> isn't already in the
    // catalog, each with a suggested name/category/stock from the hybrid
    // vision + text + heuristic classifier. No images downloaded yet.
    if (request.method === "GET" && path === "/api/ig-discover") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const username = url.searchParams.get("username");
      const directUserId = url.searchParams.get("user_id");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);
      if (!username && !directUserId) return json({ error: "username or user_id required" }, 400);

      try {
        const existingRaw = await env.BAGS.get("data");
        const existing = existingRaw ? JSON.parse(existingRaw) : { bags: [] };
        const existingIds = new Set((existing.bags || []).map(b => b.id));

        const feedData = await fetchIgFeed({ username, userId: directUserId, count: 50 });
        if (!feedData.items) return json({ error: feedData.error || "feed empty" }, 502);

        const fresh = feedData.items.filter(it => !existingIds.has(`ig_${it.shortcode}`)).slice(0, limit * 2);
        const classified = await Promise.all(fresh.map(async (it) => {
          const heuristic = looksLikeProduct(it.caption);
          const [vision, text] = await Promise.all([
            classifyPostWithVision(env, it.caption, it.imageUrl),
            classifyPostWithAi(env, it.caption),
          ]);
          const visionOk = vision && !vision._debug;
          const isProduct = heuristic || (visionOk && vision.is_product) || (text && text.is_product);
          if (!isProduct) return null;
          const heuristicSuggestion = parseCaptionForBag(it.caption);

          // Name: text LLM is best at brand shorthand. Strip caption-fragment
          // names like bare "Size" or "Polo" if they slip through.
          const looksLikeFragment = (n) => !n || /^(size|sizes|tn|hh|nb)$/i.test(String(n).trim());
          let name = heuristicSuggestion.name;
          if (text?.is_product && !looksLikeFragment(text.name) && text.name !== "New Item") {
            name = text.name.trim();
          } else if (visionOk && vision.is_product && !looksLikeFragment(vision.name) && vision.name !== "New Item") {
            name = vision.name.trim();
          } else if (visionOk && vision.is_product && vision.name === "New Item") {
            name = "New Item";
          }

          // Category: vision wins (it sees the photo — best at polos vs tshirts
          // vs shirts). Text LLM second. Heuristic last. Coerce through the
          // allowed-categories whitelist so we never publish a phantom filter.
          let category = coerceCategory(heuristicSuggestion.category);
          if (visionOk && vision.is_product && vision.category) {
            const c = coerceCategory(vision.category);
            if (c) category = c;
          } else if (text?.is_product && text.category) {
            const c = coerceCategory(text.category);
            if (c) category = c;
          }
          if (!category) category = "Shirts"; // safest default for menswear if all signals failed

          const reason = visionOk ? vision.reason : (text?.reason || (heuristic ? "matched product heuristic" : ""));
          let classifier = "heuristic";
          if (visionOk && text) classifier = "vision+text";
          else if (visionOk) classifier = "vision";
          else if (text) classifier = "text";

          return {
            ...it,
            suggested: {
              name,
              category,
              stock: heuristicSuggestion.stock,
              description: heuristicSuggestion.description,
            },
            ai_reason: reason,
            classifier,
          };
        }));
        const candidates = classified.filter(Boolean).slice(0, limit);

        return json({
          count: candidates.length,
          scanned: fresh.length,
          items: candidates,
          profile: feedData.profile,
          ai_enabled: !!env.AI,
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- Classify ONE post (auth) — used by the feed-API seed script ----
    // POST /api/classify { caption, imageUrl } -> { is_product, name, category }
    // Same vision+text+coerce path as /api/ig-discover, exposed per-item so a
    // seed that sources from the feed API can still get AI-quality name/category.
    if (request.method === "POST" && path === "/api/classify") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const caption = body.caption || "";
      const imageUrl = body.imageUrl || "";
      const heuristic = looksLikeProduct(caption);
      const [vision, text] = await Promise.all([
        classifyPostWithVision(env, caption, imageUrl),
        classifyPostWithAi(env, caption),
      ]);
      const visionOk = vision && !vision._debug;
      const isProduct = heuristic || (visionOk && vision.is_product) || (text && text.is_product);
      const heuristicSuggestion = parseCaptionForBag(caption);
      const looksLikeFragment = (n) => !n || /^(size|sizes|tn|hh|nb)$/i.test(String(n).trim());
      let name = heuristicSuggestion.name;
      if (text?.is_product && !looksLikeFragment(text.name) && text.name !== "New Item") name = text.name.trim();
      else if (visionOk && vision.is_product && !looksLikeFragment(vision.name) && vision.name !== "New Item") name = vision.name.trim();
      let category = coerceCategory(heuristicSuggestion.category);
      if (visionOk && vision.is_product && vision.category) { const c = coerceCategory(vision.category); if (c) category = c; }
      else if (text?.is_product && text.category) { const c = coerceCategory(text.category); if (c) category = c; }
      if (!category) category = "Shirts";
      return json({ is_product: !!isProduct, name, category });
    }

    // ---- IG sync: commit approved posts ----
    // POST /api/ig-sync (auth) body: { items: [{ shortcode, name, category, stock, description, imageUrls, takenAt }] }
    // Downloads each item's images directly from IG CDN, uploads to KV, and
    // prepends new-stock bag objects to the catalog. Ryker schema:
    //   { id: 'ig_<shortcode>', name, category, description, price: 0,
    //     stock: { sz: qty, ... }, sales: [], image, images?, createdAt,
    //     instagramUrl }
    if (request.method === "POST" && path === "/api/ig-sync") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json({ error: "items required" }, 400);

      const existingRaw = await env.BAGS.get("data");
      const data = existingRaw ? JSON.parse(existingRaw) : { bags: [], settings: {} };
      const existingIds = new Set(data.bags.map(b => b.id));

      const added = [];
      const errors = [];
      const newBags = [];

      for (const it of items) {
        const id = `ig_${it.shortcode}`;
        if (existingIds.has(id)) { errors.push({ shortcode: it.shortcode, reason: "already in catalog" }); continue; }
        const urls = (it.imageUrls || []).slice(0, 4);
        if (!urls.length) { errors.push({ shortcode: it.shortcode, reason: "no images" }); continue; }
        const uploaded = [];
        for (const u of urls) {
          try {
            const r = await fetch(u);
            if (!r.ok) throw new Error(`fetch ${r.status}`);
            const buf = new Uint8Array(await r.arrayBuffer());
            const b64 = arrayToB64(buf);
            const name = `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
            await env.BAGS.put(`img:${name}`, b64);
            await env.BAGS.put(`mime:${name}`, "image/jpeg");
            uploaded.push(`${url.origin}/img/${name}`);
          } catch (e) {
            errors.push({ shortcode: it.shortcode, reason: `image fetch: ${e.message}` });
          }
        }
        if (!uploaded.length) continue;

        // Normalise stock — strip any sizes the admin set to 0 or null, default
        // to { "One Size": 1 } if nothing valid came through.
        let stock = {};
        if (it.stock && typeof it.stock === "object") {
          for (const [k, v] of Object.entries(it.stock)) {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) stock[k] = n;
          }
        }
        if (!Object.keys(stock).length) stock["One Size"] = 1;

        const category = coerceCategory(it.category) || "Shirts";

        const bag = {
          id,
          name: (it.name || "New Item").slice(0, 80),
          category,
          description: it.description || "Premium menswear, hand-selected. Photographed exactly as it is. Pick your size below to enquire.",
          price: 0,
          stock,
          sales: [],
          image: uploaded[0],
          createdAt: it.takenAt || new Date().toISOString(),
          instagramUrl: `https://www.instagram.com/p/${it.shortcode}/`,
        };
        if (uploaded.length > 1) bag.images = uploaded;
        newBags.push(bag);
        added.push({ shortcode: it.shortcode, id });
        existingIds.add(id);
      }

      // Newest first — prepend to the catalog
      data.bags = newBags.concat(data.bags);
      await env.BAGS.put("data", JSON.stringify(data));
      return json({ ok: true, added: added.length, errors, items: added });
    }

    return json({ error: "not found" }, 404);
  },
};
