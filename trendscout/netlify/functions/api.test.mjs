// Tests for the TrendScout API functions. No network: globalThis.fetch is stubbed
// and a fake API key is set, so the real Scrape Creators API is never called.
// Run from trendscout/: node --test
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const FAKE_KEY = "sk-test-FAKE-KEY-1234567890";
process.env.SCRAPECREATORS_API_KEY = FAKE_KEY;

const { default: search, byViewsDesc } = await import("./search.mjs");
const { default: trending } = await import("./trending.mjs");
const { default: video } = await import("./video.mjs");
const { default: credits, readCredits } = await import("./credits.mjs");
const { _resetState } = await import("./lib/scrapecreators.mjs");

const realFetch = globalThis.fetch;
let calls = [];
let responder = () => ({ status: 200, body: {} });
const bodies = []; // every response body seen, checked for the key at the end

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  calls.push({ url, headers: init.headers || {} });
  const r = await responder(url);
  if (r instanceof Error) throw r;
  return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
    status: r.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
};

let ipCounter = 0;
async function call(handler, path, { method = "GET", ip } = {}) {
  const req = new Request(`https://trendscout.test${path}`, {
    method,
    headers: { "x-nf-client-connection-ip": ip || `10.0.0.${++ipCounter}` },
  });
  const res = await handler(req, {});
  const text = await res.text();
  bodies.push(text);
  return { res, status: res.status, body: JSON.parse(text) };
}

beforeEach(() => {
  _resetState();
  calls = [];
  responder = () => ({ status: 200, body: {} });
  process.env.SCRAPECREATORS_API_KEY = FAKE_KEY;
});

after(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------- method + validation

test("non-GET returns 405 on every route", async () => {
  for (const [h, p] of [[search, "/api/search?q=cats"], [trending, "/api/trending?platform=tiktok"], [video, "/api/video"], [credits, "/api/credits"]]) {
    const { status, body, res } = await call(h, p, { method: "POST" });
    assert.equal(status, 405);
    assert.equal(typeof body.error, "string");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(calls.length, 0);
});

test("search validates q and platforms", async () => {
  const cases = [
    "/api/search",
    "/api/search?q=",
    "/api/search?q=%20%20%20",
    `/api/search?q=${"a".repeat(101)}`,
    "/api/search?q=cats&platforms=myspace",
    "/api/search?q=cats&platforms=tiktok,vine",
    "/api/search?q=cats&platforms=,,",
  ];
  for (const p of cases) {
    const { status, body } = await call(search, p);
    assert.equal(status, 400, p);
    assert.equal(typeof body.error, "string", p);
  }
  assert.equal(calls.length, 0);
});

test("trending validates platform", async () => {
  for (const p of ["/api/trending", "/api/trending?platform=", "/api/trending?platform=facebook"]) {
    const { status } = await call(trending, p);
    assert.equal(status, 400, p);
  }
  assert.equal(calls.length, 0);
});

test("video validates platform and url host", async () => {
  const bad = [
    "/api/video?url=https://www.tiktok.com/@a/video/1",
    "/api/video?platform=tiktok",
    "/api/video?platform=tiktok&url=not-a-url",
    "/api/video?platform=tiktok&url=" + encodeURIComponent("http://www.tiktok.com/@a/video/1"),
    "/api/video?platform=tiktok&url=" + encodeURIComponent("https://www.youtube.com/watch?v=x"),
    "/api/video?platform=youtube&url=" + encodeURIComponent("https://youtube.com.evil.example/watch?v=x"),
    "/api/video?platform=youtube&url=" + encodeURIComponent("https://evil-youtube.com/watch?v=x"),
    "/api/video?platform=instagram&url=" + encodeURIComponent("https://user:pw@www.instagram.com/p/x"),
    "/api/video?platform=instagram&url=" + encodeURIComponent("javascript:alert(1)"),
  ];
  for (const p of bad) {
    const { status } = await call(video, p);
    assert.equal(status, 400, p);
  }
  assert.equal(calls.length, 0);

  const good = [
    ["tiktok", "https://www.tiktok.com/@a/video/1"],
    ["tiktok", "https://m.tiktok.com/v/1"],
    ["youtube", "https://youtu.be/abc"],
    ["youtube", "https://m.youtube.com/watch?v=abc"],
    ["youtube", "https://youtube.com/shorts/abc"],
    ["instagram", "https://www.instagram.com/reel/abc/"],
  ];
  for (const [platform, u] of good) {
    const { status } = await call(video, `/api/video?platform=${platform}&url=${encodeURIComponent(u)}`);
    assert.equal(status, 200, u);
  }
});

// ---------------------------------------------------------------- missing key

test("missing key returns 500 without calling upstream", async () => {
  delete process.env.SCRAPECREATORS_API_KEY;
  for (const [h, p] of [[search, "/api/search?q=cats"], [trending, "/api/trending?platform=tiktok"],
    [video, "/api/video?platform=youtube&url=" + encodeURIComponent("https://youtu.be/x")], [credits, "/api/credits"]]) {
    const { status, body } = await call(h, p);
    assert.equal(status, 500);
    assert.equal(body.error, "Server is missing SCRAPECREATORS_API_KEY");
  }
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- upstream behaviour

test("upstream requests carry the key header and hit the Scrape Creators host", async () => {
  await call(search, "/api/search?q=cats&platforms=tiktok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, "https://api.scrapecreators.com");
  assert.equal(calls[0].headers["x-api-key"], FAKE_KEY);
});

test("search: one platform failing still returns 200 with an errors entry", async () => {
  responder = (url) => {
    if (url.pathname.includes("tiktok")) return { status: 502, body: `upstream exploded, key=${FAKE_KEY}` };
    return { status: 200, body: {} };
  };
  const { status, body, res } = await call(search, "/api/search?q=cats");
  assert.equal(status, 200);
  assert.equal(body.query, "cats");
  assert.ok(Array.isArray(body.results));
  assert.deepEqual(Object.keys(body.errors), ["tiktok"]);
  assert.equal(body.errors.tiktok, "Upstream error 502");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(calls.length, 3);
});

test("search: timeouts and network errors become short messages", async () => {
  responder = (url) => {
    if (url.pathname.includes("tiktok")) return Object.assign(new Error("aborted"), { name: "TimeoutError" });
    if (url.pathname.includes("youtube")) return new TypeError(`fetch failed ${FAKE_KEY}`);
    return { status: 401, body: { message: "bad key " + FAKE_KEY } };
  };
  const { status, body } = await call(search, "/api/search?q=dogs");
  assert.equal(status, 200);
  assert.equal(body.errors.tiktok, "TikTok timed out");
  assert.equal(body.errors.youtube, "Couldn't reach YouTube");
  assert.match(body.errors.instagram, /^Instagram: /);
});

test("search: all ok is cacheable and identical searches hit the cache", async () => {
  const first = await call(search, "/api/search?q=cats&platforms=youtube");
  assert.equal(first.status, 200);
  assert.equal(first.res.headers.get("Cache-Control"), "public, max-age=300");
  const second = await call(search, "/api/search?q=%20cats%20&platforms=youtube");
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(calls.length, 1);
});

test("search: failures are not cached", async () => {
  responder = () => ({ status: 500, body: {} });
  await call(search, "/api/search?q=fail&platforms=youtube");
  responder = () => ({ status: 200, body: {} });
  const { body } = await call(search, "/api/search?q=fail&platforms=youtube");
  assert.deepEqual(body.errors, {});
  assert.equal(calls.length, 2);
});

test("search: merges sample results from all platforms sorted by views desc", async () => {
  const { readFile } = await import("node:fs/promises");
  const sample = async (name) => {
    try { return JSON.parse(await readFile(new URL(`./lib/samples/${name}.json`, import.meta.url), "utf8")); } catch { return {}; }
  };
  const bodies = {
    tiktok: await sample("tiktok-search"), youtube: await sample("youtube-search"), instagram: await sample("instagram-search"),
  };
  responder = (url) => ({ status: 200, body: bodies[["tiktok", "youtube", "instagram"].find((p) => url.pathname.includes(p))] });
  const { status, body } = await call(search, "/api/search?q=samples");
  assert.equal(status, 200);
  assert.deepEqual(body.errors, {});
  const views = body.results.map((v) => v.views);
  const firstNull = views.indexOf(null);
  const counted = firstNull === -1 ? views : views.slice(0, firstNull);
  if (firstNull !== -1) assert.ok(views.slice(firstNull).every((v) => v === null), "nulls last");
  for (let i = 1; i < counted.length; i++) assert.ok(counted[i - 1] >= counted[i], "views desc");
});

test("byViewsDesc sorts by views with nulls last", () => {
  const list = [{ id: "a", views: null }, { id: "b", views: 5 }, { id: "c" }, { id: "d", views: 100 }, { id: "e", views: 0 }];
  assert.deepEqual(list.sort(byViewsDesc).map((v) => v.id), ["d", "b", "e", "a", "c"]);
});

test("trending: upstream failure returns 200 with errors", async () => {
  responder = () => ({ status: 503, body: {} });
  const { status, body } = await call(trending, "/api/trending?platform=YouTube");
  assert.equal(status, 200);
  assert.equal(body.platform, "youtube");
  assert.deepEqual(body.results, []);
  assert.equal(body.errors.youtube, "Upstream error 503");
});

test("video: transcript and comments fail independently", async () => {
  responder = () => (calls.length === 1 ? { status: 404, body: {} } : { status: 200, body: {} });
  const u = encodeURIComponent("https://www.youtube.com/watch?v=abc");
  const { status, body } = await call(video, `/api/video?platform=youtube&url=${u}`);
  assert.equal(status, 200);
  assert.equal(calls.length, 2);
  assert.equal(Object.keys(body.errors).length, 1);
  assert.ok("transcript" in body && "comments" in body);
  assert.ok(Array.isArray(body.comments));
});

test("credits: reads the balance defensively and is never cached", async () => {
  responder = () => ({ status: 200, body: { creditCount: 4321 } });
  const { status, body, res } = await call(credits, "/api/credits");
  assert.equal(status, 200);
  assert.deepEqual(body, { credits: 4321 });
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  await call(credits, "/api/credits");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/v1/account/credit-balance");

  assert.equal(readCredits({ credits: 7 }), 7);
  assert.equal(readCredits({ data: { credit_balance: "12" } }), 12);
  assert.equal(readCredits({ nothing: true }), null);
  assert.equal(readCredits(null), null);
});

test("credits: upstream error returns 502 with a plain message", async () => {
  responder = () => ({ status: 401, body: { error: FAKE_KEY } });
  const { status, body } = await call(credits, "/api/credits");
  assert.equal(status, 502);
  assert.equal(typeof body.error, "string");
});

// ---------------------------------------------------------------- rate limit

test("rate limit: 31st request in a minute from one IP gets 429 with Retry-After", async () => {
  const ip = "203.0.113.9";
  for (let i = 0; i < 30; i++) {
    const { status } = await call(credits, "/api/credits", { ip });
    assert.equal(status, 200);
  }
  const { status, body, res } = await call(credits, "/api/credits", { ip });
  assert.equal(status, 429);
  assert.equal(typeof body.error, "string");
  assert.ok(Number(res.headers.get("Retry-After")) >= 1);
  const other = await call(credits, "/api/credits", { ip: "203.0.113.10" });
  assert.equal(other.status, 200);
});

// ---------------------------------------------------------------- secrets

test("the API key never appears in any response body", () => {
  assert.ok(bodies.length > 20);
  for (const b of bodies) assert.ok(!b.includes(FAKE_KEY), `key leaked in: ${b.slice(0, 200)}`);
});
