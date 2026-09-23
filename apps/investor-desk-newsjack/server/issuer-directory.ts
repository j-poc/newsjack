import { IssuerSearchResultSchema, type IssuerSearchResult } from "../src/domain";

const SEC_TICKER_DIRECTORY = "https://www.sec.gov/files/company_tickers_exchange.json";
const SEC_TICKER_MIRROR_BASE = "https://cdn.jsdelivr.net/gh/jadchaar/sec-cik-mapper@main/mappings/stocks";
const CACHE_TTL_MS = 15 * 60 * 1000;

type Cache = { fetchedAt: number; entries: IssuerSearchResult[]; source: "sec" | "sec_mirror" };
let cache: Cache | null = null;

function userAgent(): string {
  return process.env.NEWSJACK_SEC_USER_AGENT ?? process.env.SEC_USER_AGENT ?? "";
}

function parseOfficialDirectory(payload: unknown): IssuerSearchResult[] {
  if (typeof payload !== "object" || payload === null || !Array.isArray(Reflect.get(payload, "fields")) || !Array.isArray(Reflect.get(payload, "data"))) {
    throw new Error("SEC issuer directory returned an invalid payload.");
  }
  const fields = Reflect.get(payload, "fields") as unknown[];
  const rows = Reflect.get(payload, "data") as unknown[];
  const indexes = new Map(fields.map((field, index) => [typeof field === "string" ? field : "", index]));
  const cikIndex = indexes.get("cik");
  const nameIndex = indexes.get("name");
  const tickerIndex = indexes.get("ticker");
  const exchangeIndex = indexes.get("exchange");
  if (cikIndex === undefined || nameIndex === undefined || tickerIndex === undefined || exchangeIndex === undefined) {
    throw new Error("SEC issuer directory is missing an expected field.");
  }
  const entries: IssuerSearchResult[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const rawCik = row[cikIndex];
    const cikNumber = typeof rawCik === "number" ? rawCik : Number(rawCik);
    const name = typeof row[nameIndex] === "string" ? row[nameIndex].trim() : "";
    const ticker = typeof row[tickerIndex] === "string" ? row[tickerIndex].trim().toUpperCase() : "";
    const exchange = typeof row[exchangeIndex] === "string" ? row[exchangeIndex].trim() : "";
    if (!Number.isInteger(cikNumber) || cikNumber <= 0 || name.length === 0 || ticker.length === 0 || exchange.length === 0) continue;
    const parsed = IssuerSearchResultSchema.safeParse({ cik: String(cikNumber).padStart(10, "0"), ticker, name, exchange });
    if (parsed.success) entries.push(parsed.data);
  }
  if (entries.length === 0) throw new Error("SEC issuer directory contained no usable issuers.");
  return entries;
}

async function loadOfficialDirectory(): Promise<IssuerSearchResult[]> {
  const configuredUserAgent = userAgent().trim();
  if (configuredUserAgent.length === 0) {
    throw new Error("SEC User-Agent is not configured. Set NEWSJACK_SEC_USER_AGENT to a descriptive, contactable identifier.");
  }
  const response = await fetch(process.env.NEWSJACK_SEC_TICKER_DIRECTORY_URL ?? SEC_TICKER_DIRECTORY, {
    headers: { Accept: "application/json", "User-Agent": configuredUserAgent },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`SEC issuer directory returned HTTP ${response.status}.`);
  return parseOfficialDirectory(await response.json());
}

async function loadDirectoryMirror(): Promise<IssuerSearchResult[]> {
  const urls = ["ticker_to_cik.json", "ticker_to_company_name.json", "ticker_to_exchange.json"].map((file) => `${SEC_TICKER_MIRROR_BASE}/${file}`);
  const responses = await Promise.all(urls.map((url) => fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) })));
  for (const response of responses) {
    if (!response.ok) throw new Error(`Public SEC identity mirror returned HTTP ${response.status}.`);
  }
  const [cikPayload, namePayload, exchangePayload] = await Promise.all(responses.map((response) => response.json()));
  if (![cikPayload, namePayload, exchangePayload].every((value) => typeof value === "object" && value !== null && !Array.isArray(value))) {
    throw new Error("Public SEC identity mirror returned an invalid payload.");
  }
  const cikMap = cikPayload as Record<string, unknown>;
  const nameMap = namePayload as Record<string, unknown>;
  const exchangeMap = exchangePayload as Record<string, unknown>;
  const entries: IssuerSearchResult[] = [];
  for (const [rawTicker, rawCik] of Object.entries(cikMap)) {
    const ticker = rawTicker.trim().toUpperCase();
    const cik = typeof rawCik === "string" ? rawCik.padStart(10, "0") : "";
    const name = typeof nameMap[rawTicker] === "string" ? nameMap[rawTicker].trim() : "";
    const exchange = typeof exchangeMap[rawTicker] === "string" ? exchangeMap[rawTicker].trim() : "";
    const parsed = IssuerSearchResultSchema.safeParse({ cik, ticker, name, exchange });
    if (parsed.success) entries.push(parsed.data);
  }
  if (entries.length === 0) throw new Error("Public SEC identity mirror contained no usable issuers.");
  return entries;
}

async function loadDirectory(): Promise<Cache> {
  try {
    return { fetchedAt: Date.now(), entries: await loadOfficialDirectory(), source: "sec" };
  } catch (officialError) {
    try {
      return { fetchedAt: Date.now(), entries: await loadDirectoryMirror(), source: "sec_mirror" };
    } catch (mirrorError) {
      const officialMessage = officialError instanceof Error ? officialError.message : "official SEC directory failed";
      const mirrorMessage = mirrorError instanceof Error ? mirrorError.message : "public SEC identity mirror failed";
      throw new Error(`${officialMessage} Issuer search fallback also failed: ${mirrorMessage}`);
    }
  }
}

export async function searchSecIssuers(query: string): Promise<IssuerSearchResult[]> {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2) return [];
  if (cache === null || Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
    cache = await loadDirectory();
  }
  const ranked = cache.entries
    .filter((entry) => entry.name.toLowerCase().includes(normalized) || entry.ticker.toLowerCase().includes(normalized))
    .sort((left, right) => {
      const leftExact = left.ticker.toLowerCase() === normalized ? 0 : left.name.toLowerCase().startsWith(normalized) || left.ticker.toLowerCase().startsWith(normalized) ? 1 : 2;
      const rightExact = right.ticker.toLowerCase() === normalized ? 0 : right.name.toLowerCase().startsWith(normalized) || right.ticker.toLowerCase().startsWith(normalized) ? 1 : 2;
      return leftExact - rightExact || left.name.localeCompare(right.name);
    });
  return ranked.slice(0, 20);
}
