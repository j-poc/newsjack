import { createClient } from "@libsql/client";

// Market-news headlines for an issuer, proxied server-side from Yahoo's
// public search feed and displayed strictly as external pointers: the desk
// neither screens nor endorses them, and failures degrade to an empty list
// with an honest note instead of a fabricated headline.
export interface IssuerNewsItem {
  title: string;
  url: string;
  publisher: string;
  publishedAt: string;
}

export interface IssuerNewsResult {
  items: IssuerNewsItem[];
  note: string;
}

const cache = new Map<string, { at: number; result: IssuerNewsResult }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

export async function fetchIssuerNews(ticker: string, fetchFn: typeof fetch, timeoutMs = 8000): Promise<IssuerNewsResult> {
  const key = ticker.trim().toUpperCase();
  if (key === "") return { items: [], note: "No ticker to search." };
  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(key)}&newsCount=8&quotesCount=0&enableFuzzyQuery=false`;
  let payload: { news?: Array<{ title?: string; link?: string; publisher?: string; providerPublishTime?: number }> };
  try {
    const response = await fetchFn(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { items: [], note: `Market news feed returned HTTP ${response.status}.` };
    payload = await response.json() as typeof payload;
  } catch {
    return { items: [], note: "Market news feed was unreachable." };
  }
  const items: IssuerNewsItem[] = [];
  for (const item of payload.news ?? []) {
    if (typeof item.title !== "string" || typeof item.link !== "string" || item.title === "" || item.link === "") continue;
    items.push({
      title: item.title,
      url: item.link,
      publisher: typeof item.publisher === "string" ? item.publisher : "Yahoo Finance",
      publishedAt: typeof item.providerPublishTime === "number"
        ? new Date(item.providerPublishTime * 1000).toISOString()
        : "",
    });
  }
  const result = { items: items.slice(0, 8), note: items.length === 0 ? "No market news found for this issuer." : "" };
  cache.set(key, { at: Date.now(), result });
  return result;
}
