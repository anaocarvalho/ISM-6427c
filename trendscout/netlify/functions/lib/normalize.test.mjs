// Tests for normalize.mjs against the saved Scrape Creators docs samples.
// Run: cd trendscout && node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PLATFORMS,
  ENDPOINTS,
  normalizeVideos,
  normalizeTranscript,
  normalizeComments,
} from "./normalize.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sample = (platform, feature) =>
  JSON.parse(readFileSync(join(here, "samples", `${platform}-${feature}.json`), "utf8"));

const VIDEO_KEYS = [
  "id", "platform", "url", "thumbnail", "caption", "author", "authorAvatar",
  "postedAt", "views", "likes", "comments", "shares", "durationSec", "engagementRate",
];
const NUMBER_KEYS = ["views", "likes", "comments", "shares", "durationSec", "engagementRate"];
const STRING_KEYS = ["thumbnail", "caption", "author", "authorAvatar", "postedAt"];
const POST_URL = {
  tiktok: /^https:\/\/www\.tiktok\.com\/@[^/]*\/(video|photo)\/\d+/,
  youtube: /^https:\/\/www\.youtube\.com\/(shorts\/|watch\?v=)[\w-]+/,
  instagram: /^https:\/\/www\.instagram\.com\/(reel|reels|p|tv)\/[\w-]+\/?/,
};

function assertVideo(v, platform) {
  assert.deepEqual(Object.keys(v).sort(), [...VIDEO_KEYS].sort(), "exact Video keys");
  for (const k of VIDEO_KEYS) assert.notEqual(v[k], undefined, `${k} must not be undefined`);
  assert.equal(v.platform, platform);
  assert.equal(typeof v.id, "string");
  assert.ok(v.id.length > 0);
  assert.match(v.url, POST_URL[platform]);
  for (const k of NUMBER_KEYS) {
    if (v[k] !== null) {
      assert.equal(typeof v[k], "number", `${k} is a number or null`);
      assert.ok(Number.isFinite(v[k]) && v[k] >= 0, `${k} is finite and >= 0`);
    }
  }
  for (const k of STRING_KEYS) if (v[k] !== null) assert.equal(typeof v[k], "string", `${k} is a string or null`);
  for (const k of ["thumbnail", "authorAvatar"]) if (v[k] !== null) assert.match(v[k], /^https:\/\//);
  if (v.postedAt !== null) {
    assert.match(v.postedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    assert.equal(new Date(v.postedAt).toISOString(), v.postedAt);
  }
  // engagementRate rule
  if (v.views === null || v.views === 0 || v.likes === null) {
    assert.equal(v.engagementRate, null);
  } else {
    const expected = ((v.likes + (v.comments ?? 0) + (v.shares ?? 0)) / v.views) * 100;
    assert.ok(Math.abs(v.engagementRate - expected) < 1e-9, `engagementRate ${v.engagementRate} != ${expected}`);
  }
}

test("exports: PLATFORMS and ENDPOINTS shape", () => {
  assert.deepEqual(PLATFORMS, ["tiktok", "youtube", "instagram"]);
  for (const p of PLATFORMS) {
    assert.deepEqual(Object.keys(ENDPOINTS[p]).sort(), ["comments", "search", "transcript", "trending"]);
    for (const [feature, ep] of Object.entries(ENDPOINTS[p])) {
      assert.match(ep.path, /^\/v\d\//, `${p}.${feature} path`);
      assert.equal(typeof ep.params, "function");
      const arg = feature === "search" ? "cats" : "https://example.com/x";
      const params = ep.params(arg);
      assert.ok(params && typeof params === "object" && !Array.isArray(params));
      for (const val of Object.values(params)) assert.equal(typeof val, "string", `${p}.${feature} params are strings`);
      if (feature === "search") assert.equal(params.query, "cats");
      if (feature === "transcript" || feature === "comments") assert.equal(params.url, arg);
    }
  }
  assert.equal(ENDPOINTS.tiktok.trending.params().region, "US", "TikTok trending requires region");
  assert.equal(ENDPOINTS.instagram.comments.params("u").include_replies, undefined, "never pay for replies");
});

for (const platform of PLATFORMS) {
  for (const feature of ["search", "trending"]) {
    test(`normalizeVideos: ${platform}-${feature} sample`, () => {
      const videos = normalizeVideos(platform, sample(platform, feature));
      assert.ok(Array.isArray(videos));
      assert.ok(videos.length > 0, "sample yields at least one video");
      for (const v of videos) assertVideo(v, platform);
      assert.equal(new Set(videos.map((v) => v.id)).size, videos.length, "ids are unique");
    });
  }

  test(`normalizeTranscript: ${platform}-transcript sample`, () => {
    const t = normalizeTranscript(platform, sample(platform, "transcript"));
    assert.equal(typeof t, "string");
    assert.ok(t.length > 20);
    assert.doesNotMatch(t, /WEBVTT|-->|\d{2}:\d{2}:\d{2}\.\d{3}/, "no caption timing left");
    assert.doesNotMatch(t, /\s{2,}/, "whitespace collapsed");
  });

  test(`normalizeComments: ${platform}-comments sample`, () => {
    const comments = normalizeComments(platform, sample(platform, "comments"));
    assert.ok(Array.isArray(comments) && comments.length > 0);
    assert.ok(comments.length <= 20);
    for (const c of comments) {
      assert.deepEqual(Object.keys(c).sort(), ["author", "likes", "text"]);
      assert.equal(typeof c.text, "string");
      assert.ok(c.text.length > 0);
      assert.ok(c.author === null || (typeof c.author === "string" && !c.author.startsWith("@")));
      assert.ok(c.likes === null || (Number.isInteger(c.likes) && c.likes >= 0));
    }
  });

  test(`${platform}: never throws on junk input`, () => {
    const junk = [undefined, null, "", "not json", 42, true, [], {}, { success: false, error: "x" },
      { data: { items: "nope" } }, [null, 1, "a"], { reels: [null, {}] }, { aweme_list: [{}] }];
    for (const j of junk) {
      assert.deepEqual(normalizeVideos(platform, j), []);
      assert.equal(normalizeTranscript(platform, j), null);
      assert.deepEqual(normalizeComments(platform, j), []);
    }
  });
}

test("unknown platform returns empty results", () => {
  assert.deepEqual(normalizeVideos("vine", sample("tiktok", "trending")), []);
  assert.deepEqual(normalizeComments("vine", sample("tiktok", "comments")), []);
  assert.equal(normalizeTranscript("vine", sample("tiktok", "transcript")), null);
});

test("tiktok: known values from the trending sample", () => {
  const [v] = normalizeVideos("tiktok", sample("tiktok", "trending"));
  assert.equal(v.id, "7540000301621841183");
  assert.equal(v.author, "breannafriedman0"); // handle recovered from the url
  assert.equal(v.views, 1443873);
  assert.equal(v.likes, 71423);
  assert.equal(v.comments, 646);
  assert.equal(v.shares, 8440);
  assert.equal(v.postedAt, new Date(1755543133 * 1000).toISOString());
  assert.ok(Math.abs(v.engagementRate - ((71423 + 646 + 8440) / 1443873) * 100) < 1e-9);
});

test("tiktok: ms duration, built url, ads and id-less items dropped", () => {
  const json = {
    search_item_list: [
      { aweme_info: { aweme_id: "111", author: { unique_id: "alice" }, video: { duration: 83851 }, statistics: { play_count: 0, digg_count: 5 } } },
      { aweme_info: { aweme_id: "222", is_ad: true, author: { unique_id: "ad" } } },
      { aweme_info: { desc: "no id" } },
      { aweme_info: { aweme_id: "333", video: { duration: 15 } } },
    ],
  };
  const vs = normalizeVideos("tiktok", json);
  assert.deepEqual(vs.map((v) => v.id), ["111", "333"]);
  assert.equal(vs[0].url, "https://www.tiktok.com/@alice/video/111");
  assert.equal(vs[0].durationSec, 84);
  assert.equal(vs[0].views, 0);
  assert.equal(vs[0].engagementRate, null, "views 0 -> null rate");
  assert.equal(vs[0].comments, null, "missing count is null, not 0");
  assert.equal(vs[1].durationSec, 15);
  assert.match(vs[1].url, /^https:\/\/www\.tiktok\.com\/@\/video\/333$/);
});

test("youtube: shorts get /shorts/ urls, text counts parsed, channel ids not used as author", () => {
  const vs = normalizeVideos("youtube", {
    videos: [{ type: "video", id: "abcdefghijk", title: "t", viewCountText: "1,234 views", channel: { handle: "channel/UCxyz", title: "Chan" }, lengthText: "1:02:03" }],
    shorts: [{ type: "short", id: "zyxwvutsrqp", viewCountInt: 1000, likeCountInt: 50, commentCountInt: 10 }],
    channels: [{ type: "channel", id: "UCxyz" }],
  });
  const byId = Object.fromEntries(vs.map((v) => [v.id, v]));
  assert.equal(vs.length, 2);
  assert.equal(byId.abcdefghijk.url, "https://www.youtube.com/watch?v=abcdefghijk");
  assert.equal(byId.abcdefghijk.views, 1234);
  assert.equal(byId.abcdefghijk.author, "Chan");
  assert.equal(byId.abcdefghijk.durationSec, 3723);
  assert.equal(byId.zyxwvutsrqp.url, "https://www.youtube.com/shorts/zyxwvutsrqp");
  assert.equal(byId.zyxwvutsrqp.shares, null);
  assert.equal(byId.zyxwvutsrqp.engagementRate, 6);
});

test("instagram: missing views -> null rate; url built from shortcode; -1 likes -> null", () => {
  const vs = normalizeVideos("instagram", {
    reels: [
      { shortcode: "ABC123", like_count: 10, comment_count: 2, owner: { username: "bob" }, taken_at: 1700000000 },
      { shortcode: "DEF456", like_count: -1, play_count: 100 },
      { caption: "no id or url" },
    ],
  });
  assert.equal(vs.length, 2);
  assert.equal(vs[0].url, "https://www.instagram.com/reel/ABC123/");
  assert.equal(vs[0].views, null);
  assert.equal(vs[0].engagementRate, null);
  assert.equal(vs[0].postedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(vs[1].likes, null);
  assert.equal(vs[1].engagementRate, null);
});

test("normalizeVideos finds arrays in unexpected places", () => {
  const vs = normalizeVideos("instagram", { data: { wrapper: { list: [{ media: { code: "XYZ", like_count: 1, play_count: 10 } }] } } });
  assert.equal(vs.length, 1);
  assert.equal(vs[0].id, "XYZ");
  assert.equal(vs[0].engagementRate, 10);
  assert.equal(normalizeVideos("tiktok", JSON.stringify(sample("tiktok", "trending"))).length, 2, "accepts a JSON string");
});

test("transcripts: VTT is flattened, empty gives null", () => {
  const vtt = "WEBVTT\n\n00:00:00.120 --> 00:00:01.840\nHello there.\n\n00:00:01.841 --> 00:00:03.761\n<c>General</c> Kenobi.\n";
  assert.equal(normalizeTranscript("tiktok", { transcript: vtt }), "Hello there. General Kenobi.");
  assert.equal(normalizeTranscript("tiktok", { transcript: null }), null);
  assert.equal(normalizeTranscript("youtube", { transcript: null, transcript_only_text: null }), null);
  assert.equal(normalizeTranscript("youtube", { transcript: [{ text: "a" }, { text: "b" }] }), "a b");
  assert.equal(normalizeTranscript("instagram", { transcripts: [] }), null);
  assert.equal(normalizeTranscript("instagram", { transcripts: [{ text: "one" }, { text: "two" }] }), "one two");
});

test("comments: capped at 20, blank text dropped", () => {
  const many = { comments: Array.from({ length: 30 }, (_, i) => ({ text: `c${i}`, digg_count: i, user: { unique_id: `u${i}` } })) };
  many.comments.unshift({ text: "   ", user: { unique_id: "blank" } });
  const out = normalizeComments("tiktok", many);
  assert.equal(out.length, 20);
  assert.deepEqual(out[0], { author: "u0", text: "c0", likes: 0 });
  assert.deepEqual(normalizeComments("youtube", { comments: [{ content: "hi" }] }), [{ author: null, text: "hi", likes: null }]);
});

test("post links from the API are only trusted on the platform's own domain", () => {
  const [ig] = normalizeVideos("instagram", { reels: [{ shortcode: "ABC123", url: "https://evil.com/instagram.com/reel/ABC123/" }] });
  assert.equal(ig.url, "https://www.instagram.com/reel/ABC123/");
  const [yt] = normalizeVideos("youtube", { videos: [{ id: "abcDEF12345", type: "video", url: "https://evil.com/watch?v=abcDEF12345" }] });
  assert.equal(yt.url, "https://www.youtube.com/watch?v=abcDEF12345");
  const [tt] = normalizeVideos("tiktok", { search_item_list: [{ aweme_info: { aweme_id: "7123", author: { unique_id: "me" }, url: "https://evil.com/tiktok.com/7123" } }] });
  assert.equal(tt.url, "https://www.tiktok.com/@me/video/7123");
});
