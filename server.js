import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { resolve4, resolve6 } from "dns/promises";
import net from "net";

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS: Open broadly (no cookies). You can lock down later if desired.
app.use(cors());

function isPrivateIPv4(ip) {
  const b = ip.split(".").map(Number);
  return (
    b[0] === 10 ||
    (b[0] === 172 && b[1] >= 16 && b[1] <= 31) ||
    (b[0] === 192 && b[1] === 168) ||
    (b[0] === 169 && b[1] === 254) || // link-local
    ip === "127.0.0.1"
  );
}
function isPrivateIPv6(ip) {
  // ::1 loopback, fc00::/7 unique local, fe80::/10 link-local
  return (
    ip === "::1" ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("fe8") ||
    ip.startsWith("fe9") ||
    ip.startsWith("fea") ||
    ip.startsWith("feb")
  );
}
function isPrivateIP(ip) {
  if (net.isIP(ip) === 4) return isPrivateIPv4(ip);
  if (net.isIP(ip) === 6) return isPrivateIPv6(ip);
  return false;
}
async function hostIsSafe(hostname) {
  const a4 = await resolve4(hostname).catch(() => []);
  const a6 = await resolve6(hostname).catch(() => []);
  const ips = [...a4, ...a6];
  // If unresolved, let fetch handle it; if resolved, ensure none are private
  return ips.length === 0 ? true : ips.every((ip) => !isPrivateIP(ip));
}

// Follow redirects safely and block private/internal hosts
async function safeHttpGet(startUrl, maxBytes = 200000) {
  let url = startUrl;
  for (let hops = 0; hops < 5; hops++) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, status: 0, error: "invalid_url" };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { ok: false, status: 0, error: "unsupported_protocol" };
    }
    // Block obvious bad hosts
    const hostLower = u.hostname.toLowerCase();
    if (
      hostLower === "localhost" ||
      hostLower === "0.0.0.0" ||
      hostLower.endsWith(".local") ||
      hostLower.endsWith(".internal") ||
      hostLower === "metadata.google.internal"
    )
      return { ok: false, status: 0, error: "blocked_host" };

    // DNS safety
    const safe = await hostIsSafe(u.hostname);
    if (!safe) return { ok: false, status: 0, error: "private_ip_blocked" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch(url, {
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SlickdealFinderBot/1.0)",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: controller.signal,
      });
      const loc = r.headers.get("location");

      // Handle 30x manually to re-check host each hop
      if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
        url = new URL(loc, url).toString();
        continue;
      }

      const ct = r.headers.get("content-type") || "";
      const isTextLike = /text|json|xml|html/i.test(ct);
      let text = "";
      if (isTextLike) {
        const buf = await r.arrayBuffer();
        const slice = buf.slice(0, Math.min(maxBytes, buf.byteLength));
        text = new TextDecoder("utf-8").decode(slice);
      }
      return { ok: r.ok, status: r.status, url: r.url, content_type: ct, text };
    } catch (e) {
      return { ok: false, status: 0, error: String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, error: "too_many_redirects" };
}

// --- CONFIG ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // set in Render
const EXT_SHARED_TOKEN = process.env.EXT_SHARED_TOKEN || ""; // optional shared secret (recommended)
const OPENAI_MODEL = "gpt-5";

// Paste your **latest** Slickdeal Finder prompt below:
const SYSTEM_PROMPT = `You are **SlickDeal Finder**, a specialized agent that accepts a user search term and returns a ranked set of **Slickdeals-worthy** offers.

**Prime Directive**
Return only deals likely to be approved by the Slickdeals community. Each qualified deal must:

1. Be the **best price online** at time of check (after all stackable discounts).
2. **Meet or beat** comparable Slickdeals posts from the **past 365 days** for the same or very similar item.

If you cannot verify both, do not qualify the deal.

---

**Inputs (JSON provided in the user message)**

- \`query\`: string (user search term)
- \`prefs\` (optional):

  - \`min_percent_off\` (default 15)
  - \`ship_zip\`
  - \`allow_domains\` / \`block_domains\` (arrays)
  - \`banned_sellers\` (array)
  - \`time_window_days\` (default 7)
  - \`include_refurb\` (default false)
  - \`multi_buy_ok\` (default false)

---

**Data You Must Gather**

1. **Live merchant offer pages** (price, coupon, Lightning/flash, S&S %, bundle contents, shipping, stock, condition).
2. **Slickdeals past 12 months**: same or very similar model (prefer exact ASIN/UPC/Model). Capture post date, final price, net votes, and badge (Frontpage/Popular/None).
3. **Competing merchants** selling the same SKU. Include them even if slightly higher; users may prefer certain merchants.

If browsing/tools are unavailable, return **site-specific search URLs** instead of extracted deals.

---

**Normalization Rules (Final Price Math)**

- Compute **final price** as: base sale − instant discounts − **amount-off coupons**.
- If **percent coupon** + **Lightning/flash** are present: apply percent to the **regular price**, then subtract the Lightning delta (percent-then-lightning rule).
- Include **Subscribe & Save (S&S)** % stacking; if both S&S percent and amount-off coupon exist, apply S&S first, then subtract the amount.
- Ignore multi-buy-only promos (e.g., “Save 5% on 3”) unless \`multi_buy_ok=true\`.
- Note membership gating (Prime/Plus), shipping costs, and tax if they materially change ranking.
- Flag condition: \`new\`/\`refurb\`/\`open_box\`. Exclude refurb/open_box unless \`include_refurb=true\`.

---

**Best Price Online Test**

- Build a competitor set across allowed domains.
- Rank by normalized final price (tie-breakers: free shipping/returns, warranty, merchant reputation).
- Set \`best_price_online=true\` only if the candidate is #1 or tied at time of check.

---

**Slickdeals History Comparison (365-day lookback)**

- Collect up to 5 most relevant historical SD posts for the same (preferred) or very similar item.
- Compute \`meets_or_beats_sd_history=true\` when current final price ≤ the best historical SD final price (allow a small tolerance: $0.50 or 1%).
- If only **similar** SKUs exist, label as “similar”, include a \`similarity\` score, and justify.

---

**Community Approval Prediction**

Produce \`community_prediction\`:

- \`score_0_100\` and \`verdict\` in {Frontpage, Popular, Pass}.
- Basis: discount depth (≥15–20% typical threshold), SD precedent (FP/Popular), stackability (coupon+S&S), shipping/returns, brand heat, scarcity (Lightning), seasonality.
- Penalties: refurb/open-box (if included), YMMV, multi-buy required (unless allowed), niche variants.
- Add 2–4 short rationale bullets.

---

**De-dupe & Variants**

- Prefer hard keys: ASIN/UPC/Model. Else fuzzy match normalized titles + key specs (size, kit contents, panel tech, battery/charger).
- Collapse merchant duplicates; keep best effective price. List other same-item offers under \`other_merchants\`.

---

# Output (STRICT JSON ONLY)

- Return **only** a single valid JSON object (RFC 8259).
- **No** markdown/code fences, no comments, no trailing commas, no extra text.
- Use **double quotes** for all keys/strings.
- Numbers must be numbers (not strings). Use up to **2 decimal places** for currency.
- Dates must be **ISO-8601** (e.g., "2025-08-22T14:05:00-04:00").
- When a value is unknown, use \`null\` (not an empty string).
- Arrays must be present even if empty.
- For every \`DealItem\`, include **all keys** shown below (fill with \`null\`/defaults as needed).
- Enumerations must match exactly:

  - \`mode\`: "browsed" or "search_urls"
  - \`deal_type\`: "Lightning" | "S&S" | "Clearance" | "Bundle" | "Sale" | "OpenBox" | "Refurb" | "Other"
  - \`shipping\`: "free" | "paid" | "store-pickup" | "unknown"
  - \`stock\`: "in_stock" | "low" | "oos" | "unknown"
  - \`condition\`: "new" | "refurb" | "open_box" | "unknown"
  - \`coupon.type\`: "percent" | "amount" | null
  - \`community_prediction.verdict\`: "Frontpage" | "Popular" | "Pass"
  - \`slickdeals_history[].badge\`: "Frontpage" | "Popular" | "None"

- Key order (recommended for stable rendering):
  \`query, generated_at, mode, qualified, borderline, not_qualified, notes\`

### Top-level JSON shape

{
"query": "string",
"generated_at": "iso8601",
"mode": "browsed",
"qualified": [DealItem],
"borderline": [DealItem],
"not_qualified": [DealItem],
"notes": ["string"]
}

### DealItem shape

{
"title": "string",
"merchant": "string",
"domain": "string",
"product_id": "string|null",
"url": "string",
"price_current": number,
"price_was": number|null,
"percent_off": number|null,
"coupon": { "type": "percent|amount|null", "value": number|null, "notes": "string|null" },
"deal_type": "Lightning|S&S|Clearance|Bundle|Sale|OpenBox|Refurb|Other",
"shipping": "free|paid|store-pickup|unknown",
"stock": "in_stock|low|oos|unknown",
"condition": "new|refurb|open_box|unknown",
"posted_time": "iso8601|null",
"images": ["string"],
"notes": ["string"],
"best_price_online": boolean,
"price_rank_online": number,
"other_merchants": [
{ "merchant": "string", "domain": "string", "url": "string", "final_price": number, "delta_vs_best": number }
],
"slickdeals_history": [
{ "title": "string", "url": "string", "date": "iso8601", "final_price": number, "net_votes": number, "badge": "Frontpage|Popular|None", "similarity": number }
],
"meets_or_beats_sd_history": boolean,
"community_prediction": { "score_0_100": number, "verdict": "Frontpage|Popular|Pass", "rationale": ["string"] },
"confidence": number,
"evidence": ["string"]
}

### Failure / Low-Signal Path

If you cannot verify live prices **and** last-365-day Slickdeals history, set "mode": "search_urls" and still return the same top-level shape with **empty** qualified/borderline/not_qualified arrays. Populate notes with site-specific query URLs to check.

---

**Bucket Policy**

- \`qualified\`: best_price_online=true AND meets_or_beats_sd_history=true AND verdict ∈ {Frontpage, Popular}
- \`borderline\`: narrowly fails one criterion but close (e.g., tied best price; within 2% of best SD)
- \`not_qualified\`: fails clearly (worse than last-year SD or not best online)

---

**Style**

- Terse. No prose outside the JSON envelope.
- No hallucinated values. Every numeric claim must map to a real page you can link in \`evidence\`.`;

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// Main endpoint
app.post("/deal-search", async (req, res) => {
  const { query, prefs } = req.body || {};
  console.log(
    `[deal-search] query="${query || ""}" at ${new Date().toISOString()}`
  );

  try {
    if (!OPENAI_API_KEY)
      return res.status(500).json({ error: "server not configured" });
    if (EXT_SHARED_TOKEN && req.get("x-ext-token") !== EXT_SHARED_TOKEN) {
      return res.status(403).json({ error: "forbidden" });
    }
    if (!query) return res.status(400).json({ error: "missing query" });

    // ----- tools definition -----
    const tools = [
      {
        type: "function",
        function: {
          name: "http_get",
          description:
            "Fetch a web page over HTTP(S). Returns text (truncated). Use to verify prices, SD posts, merchant pages.",
          parameters: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "Absolute URL (https://...)",
              },
              max_bytes: { type: "integer", default: 200000 },
            },
            required: ["url"],
          },
        },
      },
    ];

    // ----- conversation seed -----
    const messages = [
      {
        role: "system",
        content:
          SYSTEM_PROMPT +
          "\nUse tools to fetch pages and verify evidence. When finished, output only the strict JSON envelope.",
      },
      { role: "user", content: JSON.stringify({ query, prefs }) },
    ];

    let finalJson = null;

    for (let step = 0; step < 6; step++) {
      const r1 = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENAI_MODEL, // "gpt-5"
          messages,
          tools,
          tool_choice: "auto", // let the model call http_get if it wants
        }),
      });

      if (!r1.ok) {
        const t = await r1.text().catch(() => "");
        return res
          .status(502)
          .json({ error: `openai ${r1.status}`, detail: t.slice(0, 800) });
      }

      const j1 = await r1.json();
      const msg = j1?.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls || [];

      if (toolCalls.length) {
        // Execute tool calls, append results
        for (const call of toolCalls) {
          const name = call.function?.name;
          let args = {};
          try {
            args = JSON.parse(call.function?.arguments || "{}");
          } catch {}
          if (name === "http_get") {
            const { url, max_bytes } = args;
            console.log(`[http_get] ${url}`);
            const result = await safeHttpGet(url, max_bytes || 200000);
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(result),
            });
          } else {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({
                ok: false,
                error: `unknown_tool:${name}`,
              }),
            });
          }
        }
        // Allow the model to use the tool outputs
        continue;
      }

      // No tool calls — try to parse final JSON
      const content = msg?.content?.trim();
      try {
        finalJson = JSON.parse(content);
      } catch {
        // One pass to force strict JSON
        messages.push({
          role: "system",
          content:
            "Return only a single strict JSON object per the schema. No commentary.",
        });
        messages.push({ role: "assistant", content }); // echo for context
        const r2 = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            messages,
            response_format: { type: "json_object" },
          }),
        });
        if (!r2.ok) {
          const t2 = await r2.text().catch(() => "");
          return res
            .status(502)
            .json({ error: `openai ${r2.status}`, detail: t2.slice(0, 800) });
        }
        const j2 = await r2.json();
        const c2 = j2?.choices?.[0]?.message?.content?.trim();
        try {
          finalJson = JSON.parse(c2);
        } catch {}
      }
      break; // leave loop after a non-tool reply
    }

    if (!finalJson) {
      // safe fallback
      return res.json({
        query: query || "",
        generated_at: new Date().toISOString(),
        mode: "search_urls",
        qualified: [],
        borderline: [],
        not_qualified: [],
        notes: [
          `https://www.google.com/search?q=${encodeURIComponent(
            query
          )}+price+drop`,
          `https://www.google.com/search?q=site%3Aslickdeals.net+${encodeURIComponent(
            query
          )}`,
        ],
      });
    }

    res.json(finalJson);
  } catch (e) {
    res
      .status(500)
      .json({ error: "server error", detail: String(e).slice(0, 500) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () =>
  console.log("Slickdeal Finder proxy listening on " + port)
);
