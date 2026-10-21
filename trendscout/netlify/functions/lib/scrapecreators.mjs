// Shared helpers for the TrendScout functions: the Scrape Creators client,
// an in-memory TTL cache, a per-IP rate limiter, JSON responses and input
// validation. The API key is read from SCRAPECREATORS_API_KEY and never leaves
// this module: it is not logged, echoed or included in any error message.

const API_BASE = "https://api.scrapecreators.com";
const TIMEOUT_MS = 9000; // Netlify functions stop at 10 s; a 3-platform search runs in parallel.

export const PLATFORM_LABELS = { tiktok: "TikTok", youtube: "YouTube", instagram: "Instagram" };
export const ALLOWED_PLATFORMS = Object.keys(PLATFORM_LABELS);

// Hostnames accepted for /api/video, per platform (https only).
const VIDEO_HOSTS = {
  tiktok: ["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
  youtube: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"],
  instagram: ["instagram.com", "www.instagram.com", "m.instagram.com"],
};

export const MAX_QUERY_CHARS = 100;
const MAX_URL_CHARS = 500;

// ---------------------------------------------------------------- responses

export const CACHE_OK = "public, max-age=300";
export const NO_STORE = "no-store";

export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": NO_STORE, ...headers },
  });

export const errorResponse = (status, message, headers = {}) => json(status, { error: message }, headers);

export const missingKey = () =>
  process.env.SCRAPECREATORS_API_KEY ? null : errorResponse(500, "Server is missing SCRAPECREATORS_API_KEY");

// ---------------------------------------------------------------- upstream

// An Error whose message was written by us and is safe to show the user.
export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

function upstreamError(label, status) {
  if (status === 401 || status === 403) return new UpstreamError(`${label}: the server's API key was rejected`);
  if (status === 402) return new UpstreamError("Out of Scrape Creators credits");
  if (status === 404) return new UpstreamError(`${label}: not found`);
  if (status === 429) return new UpstreamError(`${label} is rate limited, try again shortly`, 429);
  return new UpstreamError(`Upstream error ${status}`);
}

/**
 * GET {API_BASE}{path}?{params} with the API key. Resolves to parsed JSON.
 * Throws an Error with a short, sanitized message (no key, no upstream body).
 * `label` names the source in messages, e.g. "TikTok timed out".
 */
export async function callApi(path, params = {}, { label = "Scrape Creators" } = {}) {
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": process.env.SCRAPECREATORS_API_KEY || "", Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new UpstreamError(`${label} timed out`, 504);
    console.error(`[scrapecreators] network error on ${path}:`, error?.name || "Error");
    throw new UpstreamError(`Couldn't reach ${label}`);
  }
  if (!res.ok) {
    console.error(`[scrapecreators] ${path} -> HTTP ${res.status}`);
    throw upstreamError(label, res.status);
  }
  try {
    return await res.json();
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new UpstreamError(`${label} timed out`, 504);
    throw new UpstreamError(`${label} returned an unreadable response`);
  }
}

// ---------------------------------------------------------------- cache

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map(); // key -> { value, expires }; Map order = insertion order (oldest first)

export function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

export function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  cache.delete(key);
  cache.set(key, { value, expires: Date.now() + ttl });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** Returns the cached value for `key`, or runs `fn` and caches its result. Failures are not cached. */
export async function cached(key, fn) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  cacheSet(key, value);
  return value;
}

// ---------------------------------------------------------------- rate limit

// Best-effort: function instances don't share memory, so this limits per instance.
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_IPS = 5000;
const hits = new Map(); // ip -> { start, count }

export function clientIp(req, context) {
  return (req.headers.get("x-nf-client-connection-ip") || context?.ip || "unknown").trim().slice(0, 64);
}

/** Returns a 429 Response when `ip` is over the limit, otherwise null (and counts the request). */
export function rateLimit(ip, now = Date.now()) {
  let entry = hits.get(ip);
  if (!entry || now - entry.start >= RATE_WINDOW_MS) {
    if (hits.size >= RATE_MAX_IPS) {
      for (const [k, v] of hits) if (now - v.start >= RATE_WINDOW_MS) hits.delete(k);
      if (hits.size >= RATE_MAX_IPS) hits.delete(hits.keys().next().value);
    }
    entry = { start: now, count: 0 };
    hits.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count <= RATE_LIMIT) return null;
  const retryAfter = Math.max(1, Math.ceil((entry.start + RATE_WINDOW_MS - now) / 1000));
  return errorResponse(429, "Too many requests. Please wait a minute and try again.", {
    "Retry-After": String(retryAfter),
  });
}

/** Common preamble for every route: GET only, then rate limit. Returns a Response to send, or null. */
export function guard(req, context) {
  if (req.method !== "GET") return errorResponse(405, "Use GET.", { Allow: "GET" });
  return rateLimit(clientIp(req, context));
}

// ---------------------------------------------------------------- validation
// Each validator returns { value } or { error } (a plain message for a 400).

export function validateQuery(raw) {
  const q = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!q) return { error: "Enter something to search for." };
  if (q.length > MAX_QUERY_CHARS) return { error: `Keep the search under ${MAX_QUERY_CHARS} characters.` };
  return { value: q };
}

export function validatePlatform(raw) {
  const p = String(raw ?? "").trim().toLowerCase();
  if (!p) return { error: `Choose a platform: ${ALLOWED_PLATFORMS.join(", ")}.` };
  if (!ALLOWED_PLATFORMS.includes(p)) return { error: `Unknown platform. Use one of: ${ALLOWED_PLATFORMS.join(", ")}.` };
  return { value: p };
}

/** Comma-separated list; empty/missing means all platforms. Duplicates are dropped. */
export function validatePlatforms(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return { value: [...ALLOWED_PLATFORMS] };
  const list = [];
  for (const part of String(raw).split(",")) {
    if (!part.trim()) continue;
    const { value, error } = validatePlatform(part);
    if (error) return { error };
    if (!list.includes(value)) list.push(value);
  }
  if (!list.length) return { error: `Choose at least one platform: ${ALLOWED_PLATFORMS.join(", ")}.` };
  return { value: list };
}

export function validateVideoUrl(platform, raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { error: "Missing the video url." };
  if (s.length > MAX_URL_CHARS) return { error: "That video url is too long." };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: "That video url isn't valid." };
  }
  if (u.protocol !== "https:") return { error: "The video url must start with https://." };
  if (u.username || u.password || u.port) return { error: "That video url isn't valid." };
  if (!VIDEO_HOSTS[platform]?.includes(u.hostname.toLowerCase())) {
    return { error: `That url isn't a ${PLATFORM_LABELS[platform]} link.` };
  }
  return { value: u.toString() };
}

// ---------------------------------------------------------------- misc

/** User-facing message for a caught error: only our own UpstreamError messages pass through. */
export const safeMessage = (error, fallback = "Something went wrong") =>
  error instanceof UpstreamError ? error.message.slice(0, 160) : fallback;

/** Test hook: clears the cache and rate-limit state. */
export function _resetState() {
  cache.clear();
  hits.clear();
}
