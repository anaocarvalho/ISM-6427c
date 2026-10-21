// Netlify Function: GET /api/trending?platform=tiktok|youtube|instagram
// Returns one platform's trending feed: { platform, results: Video[], errors: { [platform]: message } }
// An upstream failure is reported in `errors` with a 200, like /api/search.
import { ENDPOINTS, normalizeVideos } from "./lib/normalize.mjs";
import {
  PLATFORM_LABELS, CACHE_OK, NO_STORE, callApi, cached, errorResponse, guard, json, missingKey,
  safeMessage, validatePlatform,
} from "./lib/scrapecreators.mjs";

export default async (req, context) => {
  const blocked = guard(req, context);
  if (blocked) return blocked;
  const noKey = missingKey();
  if (noKey) return noKey;

  const platform = validatePlatform(new URL(req.url).searchParams.get("platform"));
  if (platform.error) return errorResponse(400, platform.error);
  const p = platform.value;
  const label = PLATFORM_LABELS[p];

  const endpoint = ENDPOINTS[p]?.trending;
  if (!endpoint) {
    return json(200, { platform: p, results: [], errors: { [p]: `Trending isn't available for ${label}` } });
  }

  try {
    const results = await cached(`trending:${p}`, async () => {
      const data = await callApi(endpoint.path, endpoint.params(), { label });
      const videos = normalizeVideos(p, data);
      return Array.isArray(videos) ? videos : [];
    });
    return json(200, { platform: p, results, errors: {} }, { "Cache-Control": CACHE_OK });
  } catch (error) {
    const errors = { [p]: safeMessage(error, `Couldn't load ${label} trending videos`) };
    return json(200, { platform: p, results: [], errors }, { "Cache-Control": NO_STORE });
  }
};

export const config = { path: "/api/trending" };
