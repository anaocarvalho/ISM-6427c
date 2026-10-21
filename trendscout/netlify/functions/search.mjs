// Netlify Function: GET /api/search?q=&platforms=tiktok,youtube,instagram
// Searches the selected platforms in parallel through Scrape Creators and returns
//   { query, results: Video[], errors: { [platform]: message } }
// One platform failing never fails the request: its message goes in `errors`.
// Needs SCRAPECREATORS_API_KEY in Netlify → Site configuration → Environment variables.
import { ENDPOINTS, normalizeVideos } from "./lib/normalize.mjs";
import {
  PLATFORM_LABELS, CACHE_OK, NO_STORE, callApi, cached, errorResponse, guard, json, missingKey,
  safeMessage, validatePlatforms, validateQuery,
} from "./lib/scrapecreators.mjs";

const views = (v) => (Number.isFinite(v?.views) ? v.views : null);

// Highest views first; videos without a view count go last.
export const byViewsDesc = (a, b) => {
  const va = views(a);
  const vb = views(b);
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  return vb - va;
};

async function searchPlatform(platform, q) {
  const endpoint = ENDPOINTS[platform]?.search;
  if (!endpoint) throw new Error("unsupported");
  return cached(`search:${platform}:${q.toLowerCase()}`, async () => {
    const data = await callApi(endpoint.path, endpoint.params(q), { label: PLATFORM_LABELS[platform] });
    const videos = normalizeVideos(platform, data);
    return Array.isArray(videos) ? videos : [];
  });
}

export default async (req, context) => {
  const blocked = guard(req, context);
  if (blocked) return blocked;
  const noKey = missingKey();
  if (noKey) return noKey;

  const params = new URL(req.url).searchParams;
  const q = validateQuery(params.get("q"));
  if (q.error) return errorResponse(400, q.error);
  const platforms = validatePlatforms(params.get("platforms"));
  if (platforms.error) return errorResponse(400, platforms.error);

  const settled = await Promise.allSettled(platforms.value.map((p) => searchPlatform(p, q.value)));
  const results = [];
  const errors = {};
  settled.forEach((s, i) => {
    const platform = platforms.value[i];
    if (s.status === "fulfilled") results.push(...s.value);
    else errors[platform] = safeMessage(s.reason, `Couldn't load ${PLATFORM_LABELS[platform]} results`);
  });
  results.sort(byViewsDesc);

  const ok = Object.keys(errors).length === 0;
  return json(200, { query: q.value, results, errors }, { "Cache-Control": ok ? CACHE_OK : NO_STORE });
};

export const config = { path: "/api/search" };
