// Scrape Creators endpoint config + normalizers for TrendScout.
//
// Pure ES module, no dependencies, no I/O. Every normalizer takes the parsed
// JSON body of a Scrape Creators response and returns plain data. They never
// throw: an unexpected shape gives [] (videos, comments) or null (transcript).
//
// Shapes were taken from the example responses on https://docs.scrapecreators.com
// (saved, trimmed, in ./samples/<platform>-<feature>.json).
//
// Video = { id, platform, url, thumbnail, caption, author, authorAvatar,
//           postedAt, views, likes, comments, shares, durationSec, engagementRate }
// Missing values are null (never undefined, never a made-up 0).
// engagementRate = (likes + comments + shares) / views * 100, null when views is null or 0
// (or when likes is unknown); a missing comments/shares count is treated as 0.

export const PLATFORMS = ["tiktok", "youtube", "instagram"];

export const ENDPOINTS = {
  tiktok: {
    // 1 credit. `query` is the documented name. `region` only moves the proxy
    // (does not filter by origin), US keeps results consistent with trending.
    search: { path: "/v1/tiktok/search/keyword", params: (q) => ({ query: q, region: "US" }) },
    // 1 credit. `region` is REQUIRED on this endpoint.
    trending: { path: "/v1/tiktok/get-trending-feed", params: () => ({ region: "US" }) },
    // 1 credit for captions, or a flat 1 credit for AI transcription of videos
    // up to 2 minutes when captions are missing. We never opt into paid long
    // transcription (allow_long_transcription).
    transcript: { path: "/v1/tiktok/video/transcript", params: (url) => ({ url, use_ai_as_fallback: "true" }) },
    // 1 credit, first page (~20 comments).
    comments: { path: "/v1/tiktok/video/comments", params: (url) => ({ url }) },
  },
  youtube: {
    // `type: "shorts"` keeps results to Shorts. `includeExtras` adds like and
    // comment counts + description (slightly slower) so engagementRate can be
    // computed. `region` places the proxy.
    search: {
      path: "/v1/youtube/search",
      params: (q) => ({ query: q, type: "shorts", includeExtras: "true", region: "US" }),
    },
    // No query parameters documented.
    trending: { path: "/v1/youtube/shorts/trending", params: () => ({}) },
    // 1 credit. Default track selection (original language / auto captions).
    transcript: { path: "/v1/youtube/video/transcript", params: (url) => ({ url }) },
    // 1 credit. Top comments first.
    comments: { path: "/v1/youtube/video/comments", params: (url) => ({ url, order: "top" }) },
  },
  instagram: {
    // 1 credit. Optional date_posted / page are left at their defaults.
    search: { path: "/v2/instagram/reels/search", params: (q) => ({ query: q }) },
    // 1 credit. No query parameters documented (reels from the last 7 days).
    trending: { path: "/v1/instagram/reels/trending", params: () => ({}) },
    // 1 credit for AI transcription up to 2 minutes; 0 credits when there is
    // no transcript. Paid long transcription is never requested.
    transcript: { path: "/v2/instagram/media/transcript", params: (url) => ({ url }) },
    // 1 credit. Never send include_replies (adds 15 credits).
    comments: { path: "/v2/instagram/post/comments", params: (url) => ({ url }) },
  },
};

const MAX_COMMENTS = 20;

// ---------------------------------------------------------------- helpers

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parse(json) {
  if (typeof json === "string") {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  return json;
}

// First value that is not null/undefined/"".
function first(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return null;
}

function str(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return null;
}

// Count from a number or a string like "14,860,541 views", "1.2M", "750K".
// Negative numbers (Instagram uses -1 for hidden counts) and garbage give null.
function count(v) {
  if (v === undefined || v === null || v === "" || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  if (typeof v !== "string") return null;
  const m = v.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1;
  const n = Math.round(parseFloat(m[1]) * mult);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function firstCount(...vals) {
  for (const v of vals) {
    const n = count(v);
    if (n !== null) return n;
  }
  return null;
}

// Unix seconds / ms, or a date string -> ISO 8601, else null.
function iso(v) {
  if (v === undefined || v === null || v === "") return null;
  let d;
  if (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v.trim()))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else if (typeof v === "string") {
    d = new Date(v);
  } else {
    return null;
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// "4:14", "1:02:03", "00:00:19" -> seconds.
function clockToSec(v) {
  if (typeof v !== "string" || !/^\d+(:\d+){1,2}$/.test(v.trim())) return null;
  return v
    .trim()
    .split(":")
    .reduce((acc, p) => acc * 60 + Number(p), 0);
}

function seconds(v) {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v);
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) return Math.round(Number(v));
  return null;
}

/** True when `u` is a URL on `domain` itself or one of its subdomains. */
function onDomain(u, domain) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return host === domain || host.endsWith("." + domain);
  } catch {
    return false;
  }
}

function https(u) {
  if (typeof u !== "string") return null;
  let s = u.trim();
  if (s.startsWith("//")) s = "https:" + s;
  if (s.startsWith("http://")) s = "https://" + s.slice(7);
  return /^https:\/\/\S+$/.test(s) ? s : null;
}

// First https URL from a string, {url}, {url_list: []}, or array of those.
function img(...cands) {
  for (const c of cands) {
    if (!c) continue;
    if (typeof c === "string") {
      const u = https(c);
      if (u) return u;
    } else if (Array.isArray(c)) {
      const u = img(...c);
      if (u) return u;
    } else if (isObj(c)) {
      const u = img(c.url, c.url_list, c.urls, c.src);
      if (u) return u;
    }
  }
  return null;
}

function engagementRate(views, likes, comments, shares) {
  if (views === null || views === 0) return null;
  // Likes dominate engagement; without them the rate would be misleadingly low.
  // Missing comments/shares (YouTube never exposes shares) count as 0.
  if (likes === null) return null;
  return (((likes ?? 0) + (comments ?? 0) + (shares ?? 0)) / views) * 100;
}

function finish(platform, v) {
  const out = {
    id: v.id ?? null,
    platform,
    url: v.url ?? null,
    thumbnail: v.thumbnail ?? null,
    caption: v.caption ?? null,
    author: v.author ?? null,
    authorAvatar: v.authorAvatar ?? null,
    postedAt: v.postedAt ?? null,
    views: v.views ?? null,
    likes: v.likes ?? null,
    comments: v.comments ?? null,
    shares: v.shares ?? null,
    durationSec: v.durationSec ?? null,
    engagementRate: null,
  };
  out.engagementRate = engagementRate(out.views, out.likes, out.comments, out.shares);
  return out;
}

// Breadth-first search for the first array of objects that satisfies `test`.
function findArray(root, test, maxDepth = 5) {
  const queue = [[root, 0]];
  const seen = new Set();
  while (queue.length) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.some((x) => isObj(x) && test(x))) return node;
      if (depth < maxDepth) for (const x of node.slice(0, 5)) queue.push([x, depth + 1]);
    } else if (depth < maxDepth) {
      for (const v of Object.values(node)) if (v && typeof v === "object") queue.push([v, depth + 1]);
    }
  }
  return [];
}

function dedupe(videos) {
  const seen = new Set();
  return videos.filter((v) => {
    const key = v.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------- TikTok

function tiktokHandleFromUrl(url) {
  const m = typeof url === "string" && url.match(/tiktok\.com\/@([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function tiktokVideo(raw) {
  const a = isObj(raw?.aweme_info) ? raw.aweme_info : isObj(raw?.item) ? raw.item : raw;
  if (!isObj(a)) return null;
  if (a.is_ad === true || a.is_ads === true) return null;
  const id = str(first(a.aweme_id, a.id, a.statistics?.aweme_id));
  if (!id || !/^\d+$/.test(id)) return null;

  const author = isObj(a.author) ? a.author : {};
  const givenUrl = https(a.url) || https(typeof a.share_url === "string" ? a.share_url.split("?")[0] : null);
  const handle = str(first(author.unique_id, author.uniqueId, tiktokHandleFromUrl(givenUrl)));
  // Only trust a given link that points at this post.
  let url = givenUrl && onDomain(givenUrl, "tiktok.com") && givenUrl.includes(id) ? givenUrl : null;
  if (!url) url = `https://www.tiktok.com/@${handle ? encodeURIComponent(handle) : ""}/video/${id}`;

  const stats = isObj(a.statistics) ? a.statistics : isObj(a.stats) ? a.stats : {};
  const video = isObj(a.video) ? a.video : {};

  // video.duration is milliseconds in current responses (83851) and seconds in
  // older ones (15). TikTok videos are at most 60 min, so anything >= 1000 is ms.
  let durationSec = null;
  if (typeof video.duration_ms === "number") durationSec = Math.round(video.duration_ms / 1000);
  else if (typeof video.duration === "number" && video.duration > 0)
    durationSec = video.duration >= 1000 ? Math.round(video.duration / 1000) : Math.round(video.duration);

  return {
    id,
    url,
    thumbnail: img(
      video.cover,
      video.origin_cover,
      video.dynamic_cover,
      video.ai_dynamic_cover,
      a.image_post_info?.images?.[0]?.display_image,
      a.image_post_info?.images?.[0]?.thumbnail,
      a.cover,
    ),
    caption: str(first(a.desc, a.title, a.content_desc)),
    author: str(first(handle, author.nickname)),
    authorAvatar: img(author.avatar_thumb, author.avatar_medium, author.avatar_168x168, author.avatar_larger, author.avatar),
    postedAt: iso(first(a.create_time, a.createTime, a.create_time_utc)),
    views: firstCount(stats.play_count, stats.playCount),
    likes: firstCount(stats.digg_count, stats.diggCount),
    comments: firstCount(stats.comment_count, stats.commentCount),
    shares: firstCount(stats.share_count, stats.shareCount),
    durationSec,
  };
}

function tiktokItems(json) {
  if (Array.isArray(json?.search_item_list)) return json.search_item_list;
  if (Array.isArray(json?.aweme_list)) return json.aweme_list;
  if (Array.isArray(json?.data?.aweme_list)) return json.data.aweme_list;
  if (Array.isArray(json?.itemList)) return json.itemList;
  return findArray(json, (x) => "aweme_id" in x || isObj(x.aweme_info));
}

// ---------------------------------------------------------------- YouTube

function youtubeVideo(v, fromShortsList) {
  if (!isObj(v)) return null;
  if (v.type && !["video", "short", "shorts", "reel"].includes(v.type)) return null; // channels, playlists, shelves
  const id = str(first(v.id, v.videoId));
  if (!id || !/^[\w-]{6,}$/.test(id)) return null;

  const isShort = fromShortsList || v.type === "short" || v.type === "shorts" || /\/shorts\//.test(v.url || "");
  const url = isShort ? `https://www.youtube.com/shorts/${id}` : (onDomain(https(v.url), "youtube.com") ? https(v.url) : null) || `https://www.youtube.com/watch?v=${id}`;

  const ch = isObj(v.channel) ? v.channel : isObj(v.author) ? v.author : {};
  let handle = str(ch.handle);
  if (handle && handle.startsWith("channel/")) handle = null; // "channel/UC..." is an id, not a handle
  if (handle) handle = handle.replace(/^@/, "");

  const lengthSec = seconds(v.lengthSeconds);
  return {
    id,
    url,
    thumbnail: img(v.thumbnail, v.thumbnails, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
    caption: str(first(v.title, v.description)),
    author: str(first(handle, ch.title, ch.name, typeof v.channel === "string" ? v.channel : null)),
    authorAvatar: img(ch.thumbnail, ch.avatar, ch.thumbnails),
    postedAt: iso(first(v.publishedTime, v.publishDate, v.uploadDate)),
    views: firstCount(v.viewCountInt, v.viewCount, v.viewCountText),
    likes: firstCount(v.likeCountInt, v.likeCount, v.likeCountText),
    comments: firstCount(v.commentCountInt, v.commentCount, v.commentCountText),
    shares: null, // YouTube does not expose share counts
    durationSec:
      lengthSec ??
      (typeof v.durationMs === "number" ? Math.round(v.durationMs / 1000) : null) ??
      clockToSec(v.lengthText) ??
      clockToSec(v.durationFormatted),
  };
}

// Returns [item, fromShortsList] pairs.
function youtubeItems(json) {
  const out = [];
  const add = (arr, shorts) => Array.isArray(arr) && arr.forEach((x) => out.push([x, shorts]));
  if (!isObj(json)) return out;
  add(json.shorts, true);
  add(json.videos, false);
  if (Array.isArray(json.shelves)) for (const s of json.shelves) add(s?.items, /short/i.test(s?.title || ""));
  if (!out.length) add(json.items ?? json.results, false);
  if (!out.length) add(findArray(json, (x) => typeof x.id === "string" && ("title" in x || "url" in x)), false);
  return out;
}

// ---------------------------------------------------------------- Instagram

function instagramVideo(raw) {
  const r = isObj(raw?.media) ? raw.media : isObj(raw?.node) ? raw.node : raw;
  if (!isObj(r)) return null;
  const code = str(first(r.shortcode, r.code));
  const givenUrl = onDomain(https(r.url), "instagram.com") ? https(r.url) : null;
  const codeFromUrl = givenUrl?.match(/\/(?:reel|reels|p|tv)\/([\w-]+)/)?.[1] ?? null;
  const shortcode = code ?? codeFromUrl;
  const id = str(first(shortcode, r.id, r.pk));
  if (!id) return null;
  const url = givenUrl || (shortcode ? `https://www.instagram.com/reel/${shortcode}/` : null);
  if (!url) return null;

  const owner = isObj(r.owner) ? r.owner : isObj(r.user) ? r.user : {};
  const caption = typeof r.caption === "string" ? r.caption : r.caption?.text ?? r.edge_media_to_caption?.edges?.[0]?.node?.text;

  return {
    id,
    url,
    thumbnail: img(
      r.thumbnail_src,
      r.display_url,
      r.image_url,
      r.thumbnail_url,
      r.image_versions2?.candidates,
      r.image_versions2?.additional_candidates?.first_frame,
    ),
    caption: str(caption),
    author: str(owner.username),
    authorAvatar: img(owner.profile_pic_url, owner.profile_pic_url_hd),
    postedAt: iso(first(r.taken_at, r.taken_at_timestamp, r.created_at)),
    // Instagram often omits view counts (see docs.scrapecreators.com/instagram-view-counts).
    views: firstCount(r.play_count, r.ig_play_count, r.video_play_count, r.video_view_count, r.view_count),
    likes: firstCount(r.like_count, r.edge_liked_by?.count, r.edge_media_preview_like?.count),
    comments: firstCount(r.comment_count, r.edge_media_to_comment?.count),
    shares: firstCount(r.share_count, r.reshare_count),
    durationSec: seconds(r.video_duration),
  };
}

function instagramItems(json) {
  if (Array.isArray(json?.reels)) return json.reels;
  if (Array.isArray(json?.items)) return json.items;
  if (Array.isArray(json?.posts)) return json.posts;
  if (Array.isArray(json?.data?.items)) return json.data.items;
  return findArray(json, (x) => "shortcode" in x || "code" in x || isObj(x.media) || isObj(x.node));
}

// ---------------------------------------------------------------- public API

/** Search or trending response -> Video[] (never throws). */
export function normalizeVideos(platform, json) {
  try {
    const data = parse(json);
    if (!data || typeof data !== "object") return [];
    let raw = [];
    if (platform === "tiktok") raw = tiktokItems(data).map(tiktokVideo);
    else if (platform === "youtube") raw = youtubeItems(data).map(([x, s]) => youtubeVideo(x, s));
    else if (platform === "instagram") raw = instagramItems(data).map(instagramVideo);
    else return [];
    return dedupe(raw.filter((v) => v && v.id && v.url).map((v) => finish(platform, v)));
  } catch {
    return [];
  }
}

// WEBVTT / SRT -> plain text (drops header, cue numbers, timestamps, tags, repeats).
function captionsToText(s) {
  const lines = s.replace(/\r/g, "").split("\n");
  const out = [];
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (/-->/.test(line)) continue;
    line = line.replace(/<[^>]+>/g, "").trim();
    if (line && out[out.length - 1] !== line) out.push(line);
  }
  return out.join(" ");
}

function cleanText(s) {
  if (typeof s !== "string") return null;
  const t = (/WEBVTT|-->/.test(s) ? captionsToText(s) : s).replace(/\s+/g, " ").trim();
  return t || null;
}

function segmentsToText(arr) {
  if (!Array.isArray(arr)) return null;
  const parts = arr
    .map((x) => (typeof x === "string" ? x : isObj(x) ? first(x.text, x.snippet, x.content) : null))
    .filter((x) => typeof x === "string" && x.trim());
  return parts.length ? cleanText(parts.join(" ")) : null;
}

/** Transcript response -> plain text, or null when there is none (never throws). */
export function normalizeTranscript(platform, json) {
  try {
    const d = parse(json);
    if (typeof d === "string") return cleanText(d);
    if (!isObj(d)) return null;
    if (platform === "youtube") {
      return cleanText(d.transcript_only_text) ?? segmentsToText(d.transcript) ?? cleanText(d.transcript);
    }
    if (platform === "instagram") {
      if (Array.isArray(d.transcripts)) {
        const t = d.transcripts
          .map((x) => cleanText(x?.text) ?? segmentsToText(x?.transcript_with_timestamp))
          .filter(Boolean)
          .join(" ");
        return t || null;
      }
      return cleanText(d.text) ?? cleanText(d.transcript) ?? segmentsToText(d.transcript);
    }
    if (platform === "tiktok") {
      return cleanText(d.transcript) ?? segmentsToText(d.transcript) ?? cleanText(d.text);
    }
    return null;
  } catch {
    return null;
  }
}

function commentOf(platform, c) {
  if (!isObj(c)) return null;
  let author = null;
  let text = null;
  let likes = null;
  if (platform === "tiktok") {
    author = first(c.user?.unique_id, c.user?.nickname);
    text = c.text;
    likes = count(c.digg_count);
  } else if (platform === "youtube") {
    author = first(c.author?.name, c.author?.handle, typeof c.author === "string" ? c.author : null);
    text = first(c.content, c.text);
    likes = firstCount(c.engagement?.likes, c.likes, c.likeCount);
  } else if (platform === "instagram") {
    author = first(c.user?.username, c.owner?.username);
    text = c.text;
    likes = firstCount(c.comment_like_count, c.like_count, c.edge_liked_by?.count);
  }
  text = typeof text === "string" ? text.trim() : null;
  if (!text) return null;
  author = str(author);
  if (author) author = author.replace(/^@/, "");
  return { author: author ?? null, text, likes: likes ?? null };
}

/** Comments response -> [{ author, text, likes }] (max 20, never throws). */
export function normalizeComments(platform, json) {
  try {
    if (!PLATFORMS.includes(platform)) return [];
    const d = parse(json);
    if (!d || typeof d !== "object") return [];
    const arr = Array.isArray(d)
      ? d
      : Array.isArray(d.comments)
        ? d.comments
        : Array.isArray(d.data?.comments)
          ? d.data.comments
          : findArray(d, (x) => "text" in x || "content" in x);
    const out = [];
    for (const c of arr) {
      const n = commentOf(platform, c);
      if (n) out.push(n);
      if (out.length >= MAX_COMMENTS) break;
    }
    return out;
  } catch {
    return [];
  }
}
