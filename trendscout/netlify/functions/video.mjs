// Netlify Function: GET /api/video?platform=&url=
// Fetches a video's transcript and top 20 comments in parallel:
//   { transcript: string|null, comments: [{author, text, likes}], errors: { transcript?, comments? } }
// Each half can fail on its own; the other half is still returned with a 200.
import { ENDPOINTS, normalizeComments, normalizeTranscript } from "./lib/normalize.mjs";
import {
  PLATFORM_LABELS, CACHE_OK, NO_STORE, callApi, cached, errorResponse, guard, json, missingKey,
  safeMessage, validatePlatform, validateVideoUrl,
} from "./lib/scrapecreators.mjs";

const MAX_COMMENTS = 20;

function fetchPart(platform, feature, url, normalize) {
  const endpoint = ENDPOINTS[platform]?.[feature];
  if (!endpoint) return Promise.reject(new Error("unsupported"));
  return cached(`${feature}:${platform}:${url}`, async () => {
    const data = await callApi(endpoint.path, endpoint.params(url), { label: PLATFORM_LABELS[platform] });
    return normalize(platform, data);
  });
}

export default async (req, context) => {
  const blocked = guard(req, context);
  if (blocked) return blocked;
  const noKey = missingKey();
  if (noKey) return noKey;

  const params = new URL(req.url).searchParams;
  const platform = validatePlatform(params.get("platform"));
  if (platform.error) return errorResponse(400, platform.error);
  const p = platform.value;
  const url = validateVideoUrl(p, params.get("url"));
  if (url.error) return errorResponse(400, url.error);

  const [t, c] = await Promise.allSettled([
    fetchPart(p, "transcript", url.value, normalizeTranscript),
    fetchPart(p, "comments", url.value, normalizeComments),
  ]);

  const errors = {};
  let transcript = null;
  let comments = [];
  if (t.status === "fulfilled") transcript = typeof t.value === "string" && t.value.trim() ? t.value : null;
  else errors.transcript = safeMessage(t.reason, "Couldn't load the transcript");
  if (c.status === "fulfilled") comments = Array.isArray(c.value) ? c.value.slice(0, MAX_COMMENTS) : [];
  else errors.comments = safeMessage(c.reason, "Couldn't load the comments");

  const ok = Object.keys(errors).length === 0;
  return json(200, { transcript, comments, errors }, { "Cache-Control": ok ? CACHE_OK : NO_STORE });
};

export const config = { path: "/api/video" };
