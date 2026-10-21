/* TrendScout: search and browse trending short-form videos.
 * Talks only to our own /api/* Netlify Functions (same origin). No API keys here.
 * All API text is untrusted: it is rendered with textContent, never innerHTML. */

// ---------- Constants ----------
const PLATFORMS = ["tiktok", "youtube", "instagram"];
const LABEL = { tiktok: "TikTok", youtube: "YouTube", instagram: "Instagram" };
const TREND_LABEL = { tiktok: "TikTok", youtube: "YouTube Shorts", instagram: "Instagram Reels" };
const SORTS = ["default", "views", "likes", "engagement", "newest"];
const CACHE_MS = 5 * 60 * 1000;
const SKELETONS = 8;
const LOW_CREDITS = 50;

// ---------- Helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const DASH = "—";

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Thumbnails may also be inline data: images (allowed by the CSP img-src). */
function safeImg(u) {
  return typeof u === "string" && /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(u) ? u : safeUrl(u);
}

/** Only allow http(s) URLs coming from the API into href/src. */
function safeUrl(u) {
  if (typeof u !== "string") return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const fullFmt = new Intl.NumberFormat("en-US");
const compact = (n) => (isNum(n) ? compactFmt.format(n) : DASH);
const full = (n) => (isNum(n) ? fullFmt.format(n) : DASH);
const pct = (n) => (isNum(n) ? (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + "%" : DASH);

function duration(sec) {
  if (!isNum(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function parseDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
function relTime(iso) {
  const d = parseDate(iso);
  if (!d) return null;
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const units = [
    ["year", 31536000], ["month", 2592000], ["week", 604800],
    ["day", 86400], ["hour", 3600], ["minute", 60],
  ];
  for (const [unit, secs] of units) {
    if (abs >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return "just now";
}

const authorText = (a) => {
  if (!a || typeof a !== "string") return null;
  const t = a.trim();
  return t ? (t.startsWith("@") ? t : "@" + t) : null;
};

class ApiError extends Error {
  constructor(message, status, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function getJSON(url, signal) {
  let res;
  try {
    res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError("Network error. Check your connection and try again.", 0);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "", 10);
    let msg = (body && typeof body.error === "string" && body.error) || `Request failed (${res.status}).`;
    if (res.status === 429) {
      msg = isNum(retryAfter) && retryAfter > 0
        ? `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`
        : "Too many requests. Please wait a moment and try again.";
    }
    throw new ApiError(msg, res.status, isNum(retryAfter) ? retryAfter : null);
  }
  if (!body || typeof body !== "object") throw new ApiError("Unexpected response from the server.", res.status);
  return body;
}

// ---------- State ----------
const state = {
  mode: "trending",           // "search" | "trending"
  query: "",
  platforms: new Set(PLATFORMS), // search platforms
  trend: "tiktok",            // trending platform
  sort: "default",
  filter: "all",
  results: [],
  errors: {},
  fatal: null,                // { message, retry }
  loading: false,
};
const cache = new Map();      // key -> { t, data }
let mainCtrl = null;
let generation = 0;

// ---------- DOM ----------
const dom = {
  modeBtns: $$(".mode-btn"),
  form: $("#search-form"),
  q: $("#q"),
  checks: $$('input[name="platform"]'),
  hint: $("#form-hint"),
  searchBtn: $("#search-btn"),
  tabs: $("#trend-tabs"),
  tabBtns: $$(".trend-tab"),
  summary: $("#summary"),
  chips: $("#chips"),
  sort: $("#sort"),
  notices: $("#notices"),
  grid: $("#grid"),
  empty: $("#empty"),
  emptyTitle: $("#empty-title"),
  emptyText: $("#empty-text"),
  credits: $("#credits"),
  creditsText: $("#credits-text"),
  dialog: $("#details"),
};

// ---------- URL state ----------
function readUrl() {
  const p = new URLSearchParams(location.search);
  const q = (p.get("q") || "").trim().slice(0, 100);
  const mode = p.get("mode") === "search" || (q && p.get("mode") !== "trending") ? "search" : "trending";
  const plist = (p.get("p") || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => PLATFORMS.includes(s));
  state.mode = mode;
  state.query = q;
  if (mode === "search") {
    state.platforms = new Set(plist.length ? plist : PLATFORMS);
  } else if (plist.length) {
    state.trend = plist[0];
  }
  const sort = p.get("sort");
  state.sort = SORTS.includes(sort) ? sort : "default";
}

function writeUrl() {
  const p = new URLSearchParams();
  p.set("mode", state.mode);
  if (state.mode === "search") {
    if (state.query) p.set("q", state.query);
    const list = PLATFORMS.filter((x) => state.platforms.has(x));
    if (list.length !== PLATFORMS.length) p.set("p", list.join(","));
  } else {
    p.set("p", state.trend);
  }
  if (state.sort !== "default") p.set("sort", state.sort);
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

// ---------- Controls sync ----------
function syncControls() {
  for (const b of dom.modeBtns) b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
  dom.form.hidden = state.mode !== "search";
  dom.tabs.hidden = state.mode !== "trending";
  dom.q.value = state.query;
  for (const c of dom.checks) c.checked = state.platforms.has(c.value);
  for (const t of dom.tabBtns) {
    const on = t.dataset.platform === state.trend;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
  }
  dom.sort.value = state.sort;
}

// ---------- Loading ----------
function requestKey() {
  return state.mode === "search"
    ? `s|${state.query.toLowerCase()}|${PLATFORMS.filter((x) => state.platforms.has(x)).join(",")}`
    : `t|${state.trend}`;
}

function requestUrl(onlyPlatform) {
  if (state.mode === "search") {
    const list = onlyPlatform ? [onlyPlatform] : PLATFORMS.filter((x) => state.platforms.has(x));
    return `/api/search?q=${encodeURIComponent(state.query)}&platforms=${list.join(",")}`;
  }
  return `/api/trending?platform=${encodeURIComponent(state.trend)}`;
}

function normalizeResults(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((v) => v && typeof v === "object" && PLATFORMS.includes(v.platform))
    .map((v, i) => ({ ...v, _i: i }));
}

function cleanErrors(errors) {
  const out = {};
  if (errors && typeof errors === "object") {
    for (const p of PLATFORMS) if (typeof errors[p] === "string" && errors[p]) out[p] = errors[p];
  }
  return out;
}

async function load({ force = false } = {}) {
  writeUrl();
  if (mainCtrl) mainCtrl.abort();
  const gen = ++generation;
  state.fatal = null;
  state.filter = "all";

  if (state.mode === "search" && !state.query) {
    state.results = [];
    state.errors = {};
    state.loading = false;
    render();
    return;
  }

  const key = requestKey();
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.t < CACHE_MS) {
    applyData(hit.data);
    render();
    return;
  }

  const ctrl = new AbortController();
  mainCtrl = ctrl;
  state.loading = true;
  state.results = [];
  state.errors = {};
  render();

  try {
    const data = await getJSON(requestUrl(), ctrl.signal);
    if (gen !== generation) return;
    cache.set(key, { t: Date.now(), data });
    applyData(data);
    refreshCredits();
  } catch (e) {
    if (e.name === "AbortError" || gen !== generation) return;
    state.fatal = { message: e.message || "Something went wrong." };
  } finally {
    if (gen === generation) {
      state.loading = false;
      mainCtrl = null;
      render();
    }
  }
}

function applyData(data) {
  state.results = normalizeResults(data.results);
  state.errors = cleanErrors(data.errors);
}

/** Retry one failed platform and merge its results in. */
async function retryPlatform(platform, button) {
  if (state.mode === "trending") return load({ force: true });
  const gen = generation;
  const ctrl = new AbortController();
  if (button) {
    button.disabled = true;
    button.textContent = "Retrying…";
  }
  try {
    const data = await getJSON(requestUrl(platform), ctrl.signal);
    if (gen !== generation) return;
    const fresh = normalizeResults(data.results).filter((v) => v.platform === platform);
    const offset = state.results.length;
    state.results = state.results.filter((v) => v.platform !== platform)
      .concat(fresh.map((v, i) => ({ ...v, _i: offset + i })));
    const errs = cleanErrors(data.errors);
    if (errs[platform]) state.errors[platform] = errs[platform];
    else delete state.errors[platform];
    cache.set(requestKey(), { t: Date.now(), data: { results: state.results, errors: state.errors } });
    refreshCredits();
  } catch (e) {
    if (gen !== generation) return;
    state.errors[platform] = e.message || "Retry failed.";
  }
  if (gen === generation) render();
}

// ---------- Credits ----------
let creditsCtrl = null;
async function refreshCredits() {
  if (creditsCtrl) creditsCtrl.abort();
  creditsCtrl = new AbortController();
  try {
    const data = await getJSON("/api/credits", creditsCtrl.signal);
    const n = data.credits;
    dom.credits.hidden = false;
    dom.creditsText.textContent = isNum(n) ? `${full(n)} credits` : `Credits: ${DASH}`;
    dom.credits.classList.toggle("is-low", isNum(n) && n < LOW_CREDITS);
    dom.credits.title = isNum(n) ? "Scrape Creators credits remaining" : "Credit balance unavailable";
  } catch (e) {
    if (e.name !== "AbortError") dom.credits.hidden = true;
  }
}

// ---------- Rendering ----------
function sorted(list) {
  const by = (fn) => (a, b) => {
    const x = fn(a), y = fn(b);
    const xn = isNum(x), yn = isNum(y);
    if (xn && yn) return y - x || a._i - b._i;
    if (xn) return -1;
    if (yn) return 1;
    return a._i - b._i;
  };
  const arr = list.slice();
  switch (state.sort) {
    case "views": return arr.sort(by((v) => v.views));
    case "likes": return arr.sort(by((v) => v.likes));
    case "engagement": return arr.sort(by((v) => v.engagementRate));
    case "newest": return arr.sort(by((v) => parseDate(v.postedAt)?.getTime() ?? null));
    default: return arr.sort((a, b) => a._i - b._i);
  }
}

function render() {
  dom.grid.setAttribute("aria-busy", String(state.loading));
  renderSummary();
  renderChips();
  renderNotices();
  dom.grid.replaceChildren();

  if (state.loading) {
    for (let i = 0; i < SKELETONS; i++) dom.grid.append(skeletonCard());
    dom.empty.hidden = true;
    return;
  }

  const visible = sorted(state.results.filter((v) => state.filter === "all" || v.platform === state.filter));
  const frag = document.createDocumentFragment();
  for (const v of visible) frag.append(card(v));
  dom.grid.append(frag);

  const hasNotices = state.fatal || Object.keys(state.errors).length > 0;
  if (visible.length === 0 && !hasNotices) {
    dom.empty.hidden = false;
    if (state.mode === "search" && !state.query) {
      dom.emptyTitle.textContent = "Find what's trending on any topic";
      dom.emptyText.textContent = "Type a topic above and press Enter to search TikTok, YouTube and Instagram at once.";
    } else {
      dom.emptyTitle.textContent = "No videos found";
      dom.emptyText.textContent = state.mode === "search"
        ? "Try a broader search term or turn on more platforms."
        : "Nothing is trending here right now. Try another platform.";
    }
  } else {
    dom.empty.hidden = true;
  }
}

function renderSummary() {
  const s = dom.summary;
  s.replaceChildren();
  if (state.loading) {
    s.textContent = state.mode === "search" ? `Searching for “${state.query}”…` : `Loading trending on ${TREND_LABEL[state.trend]}…`;
    return;
  }
  if (state.mode === "search" && !state.query) return;
  const n = state.results.length;
  const count = el("strong", { text: `${fullFmt.format(n)} video${n === 1 ? "" : "s"}` });
  if (state.mode === "search") s.append(count, " for ", el("strong", { text: `“${state.query}”` }));
  else s.append(count, ` trending on ${TREND_LABEL[state.trend]}`);
}

function renderChips() {
  dom.chips.replaceChildren();
  const counts = {};
  for (const v of state.results) counts[v.platform] = (counts[v.platform] || 0) + 1;
  const present = PLATFORMS.filter((p) => counts[p]);
  if (state.filter !== "all" && !counts[state.filter]) state.filter = "all";
  // Only worth showing when there is more than one platform to choose from.
  dom.chips.hidden = state.loading || present.length < 2;
  if (dom.chips.hidden) return;
  const mk = (value, label, n) => {
    const b = el("button", { type: "button", class: "chip", "aria-pressed": String(state.filter === value), "data-filter": value },
      value === "all" ? null : el("span", { class: `chip-dot p-${value}`, "aria-hidden": "true" }),
      el("span", { text: label }),
      el("span", { class: "chip-count", text: fullFmt.format(n) }));
    return b;
  };
  dom.chips.append(mk("all", "All", state.results.length));
  for (const p of present) dom.chips.append(mk(p, LABEL[p], counts[p]));
}

function renderNotices() {
  dom.notices.replaceChildren();
  if (state.loading) return;
  if (state.fatal) {
    const btn = el("button", { type: "button", class: "btn btn-secondary btn-small", "data-retry": "all", text: "Retry" });
    dom.notices.append(el("div", { class: "notice", role: "alert" },
      el("p", {}, el("strong", { text: "Couldn't load videos. " }), state.fatal.message), btn));
  }
  for (const p of PLATFORMS) {
    const msg = state.errors[p];
    if (!msg) continue;
    const btn = el("button", { type: "button", class: "btn btn-secondary btn-small", "data-retry": p, text: "Retry" });
    btn.setAttribute("aria-label", `Retry ${LABEL[p]}`);
    dom.notices.append(el("div", { class: "notice", role: "status" },
      el("p", {}, el("strong", { text: `${LABEL[p]}: ` }), msg), btn));
  }
}

const PLACEHOLDER_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>';

function thumbFallback() {
  const f = el("div", { class: "thumb-fallback" });
  f.innerHTML = PLACEHOLDER_SVG; // static markup, no API data
  return f;
}

function badge(platform) {
  return el("span", { class: `badge p-${platform}`, text: LABEL[platform] });
}

function statItem(label, value, isNull) {
  return el("div", { class: "stat" },
    el("dt", { text: label }),
    el("dd", { class: isNull ? "is-null" : null, text: value }));
}

function card(v) {
  const li = el("li");
  const art = el("article", { class: "card" });
  const href = safeUrl(v.url);
  const caption = typeof v.caption === "string" ? v.caption.replace(/\s+/g, " ").trim() : "";
  const author = authorText(v.author);

  // Thumbnail
  const thumb = el("div", { class: `thumb p-${v.platform}` });
  const src = safeImg(v.thumbnail);
  if (src) {
    const img = el("img", {
      src, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
      alt: caption ? `Thumbnail: ${caption.slice(0, 100)}` : `${LABEL[v.platform]} video thumbnail`,
    });
    img.addEventListener("error", () => img.replaceWith(thumbFallback()), { once: true });
    thumb.append(img);
  } else {
    thumb.append(thumbFallback());
  }
  thumb.append(badge(v.platform));
  const dur = duration(v.durationSec);
  if (dur) thumb.append(el("span", { class: "duration", text: dur, "aria-label": `Duration ${dur}` }));

  // Body
  const body = el("div", { class: "card-body" });
  const capEl = el(href ? "a" : "span", {
    class: `card-link caption${caption ? "" : " is-empty"}`,
    href, target: href ? "_blank" : null, rel: href ? "noopener noreferrer" : null,
    text: caption || "No caption",
  });
  if (href) capEl.setAttribute("aria-label", `${caption ? caption.slice(0, 120) : "Untitled video"} (opens ${LABEL[v.platform]} in a new tab)`);
  body.append(el("h3", { class: "card-title" }, capEl));

  const rel = relTime(v.postedAt);
  const by = el("p", { class: "byline" }, el("span", { class: "author", text: author || "Unknown creator" }));
  if (rel) {
    by.append(el("span", { class: "sep", "aria-hidden": "true", text: "·" }),
      el("time", { datetime: parseDate(v.postedAt).toISOString(), title: parseDate(v.postedAt).toLocaleString(), text: rel }));
  }
  body.append(by);

  const stats = el("dl", { class: "stats" },
    statItem("Views", compact(v.views), !isNum(v.views)),
    statItem("Likes", compact(v.likes), !isNum(v.likes)),
    statItem("Comm.", compact(v.comments), !isNum(v.comments)),
    statItem("Eng.", pct(v.engagementRate), !isNum(v.engagementRate)));
  stats.children[2].firstChild.title = "Comments";
  stats.children[3].firstChild.title = "Engagement rate: (likes + comments + shares) / views";
  body.append(stats);

  const btn = el("button", { type: "button", class: "btn btn-secondary btn-small details-btn", text: "Details" });
  btn.setAttribute("aria-label", `Details: ${caption ? caption.slice(0, 80) : "video"}`);
  btn.addEventListener("click", () => openDetails(v, btn));
  body.append(el("div", { class: "card-actions" }, btn));

  art.append(thumb, body);
  li.append(art);
  return li;
}

function skeletonCard() {
  return el("li", { "aria-hidden": "true" },
    el("div", { class: "card skeleton" },
      el("div", { class: "sk sk-thumb" }),
      el("div", { class: "card-body" },
        el("div", { class: "sk sk-line w-90" }),
        el("div", { class: "sk sk-line w-60" }),
        el("div", { class: "sk sk-line w-40" }),
        el("div", { class: "sk sk-stats" }))));
}

// ---------- Details dialog ----------
let detailsCtrl = null;
let detailsOpener = null;

function openDetails(v, opener) {
  const d = dom.dialog;
  detailsOpener = opener;
  const caption = typeof v.caption === "string" ? v.caption.trim() : "";
  const b = $("#details-badge");
  b.className = `badge p-${v.platform}`;
  b.textContent = LABEL[v.platform];
  $("#details-title").textContent = caption || "Untitled video";
  const rel = relTime(v.postedAt);
  $("#details-author").textContent = [authorText(v.author) || "Unknown creator", rel].filter(Boolean).join(" · ");

  const stats = $("#details-stats");
  stats.replaceChildren();
  const rows = [
    ["Views", full(v.views)], ["Likes", full(v.likes)], ["Comments", full(v.comments)],
    ["Shares", full(v.shares)], ["Engagement", pct(v.engagementRate)], ["Duration", duration(v.durationSec) || DASH],
  ];
  for (const [k, val] of rows) stats.append(el("div", {}, el("dt", { text: k }), el("dd", { text: val })));

  const href = safeUrl(v.url);
  const open = $("#details-open");
  open.hidden = !href;
  if (href) open.href = href;

  const tr = $("#transcript");
  const cm = $("#comments");
  tr.replaceChildren();
  cm.replaceChildren(el("div", { class: "sk sk-block", "aria-hidden": "true" }));
  setTranscriptLoading(true);

  if (!d.open) d.showModal();
  $("#details-body").scrollTop = 0;
  $("#details-close").focus();

  if (detailsCtrl) detailsCtrl.abort();
  if (!href) {
    showDetailError("This video has no link, so details aren't available.");
    return;
  }
  const ctrl = new AbortController();
  detailsCtrl = ctrl;
  getJSON(`/api/video?platform=${encodeURIComponent(v.platform)}&url=${encodeURIComponent(href)}`, ctrl.signal)
    .then((data) => {
      if (ctrl !== detailsCtrl) return;
      renderDetails(data);
      refreshCredits();
    })
    .catch((e) => {
      if (e.name === "AbortError" || ctrl !== detailsCtrl) return;
      showDetailError(e.message || "Couldn't load details.");
    });
}

function setTranscriptLoading(on) {
  const sec = $("#transcript").parentElement;
  const old = sec.querySelector(".sk-block, .muted-note, .err-note");
  if (old) old.remove();
  if (on) sec.append(el("div", { class: "sk sk-block", "aria-hidden": "true" }));
}

function showDetailError(msg) {
  setTranscriptLoading(false);
  $("#transcript").parentElement.append(el("p", { class: "err-note", text: msg }));
  $("#comments").replaceChildren(el("p", { class: "muted-note", text: "Comments unavailable." }));
}

function renderDetails(data) {
  const errors = (data && data.errors) || {};
  setTranscriptLoading(false);
  const tr = $("#transcript");
  const trSec = tr.parentElement;
  const text = typeof data.transcript === "string" ? data.transcript.trim() : "";
  if (text) tr.textContent = text;
  else if (typeof errors.transcript === "string" && errors.transcript) trSec.append(el("p", { class: "err-note", text: errors.transcript }));
  else trSec.append(el("p", { class: "muted-note", text: "No transcript available for this video." }));

  const cm = $("#comments");
  cm.replaceChildren();
  const list = Array.isArray(data.comments) ? data.comments.filter((c) => c && typeof c.text === "string" && c.text.trim()) : [];
  if (list.length) {
    const ul = el("ul", { class: "comment-list" });
    for (const c of list) {
      ul.append(el("li", { class: "comment" },
        el("div", { class: "comment-head" },
          el("span", { class: "comment-author", text: authorText(c.author) || "Anonymous" }),
          isNum(c.likes) ? el("span", { class: "comment-likes", text: `♥ ${compact(c.likes)}`, "aria-label": `${full(c.likes)} likes` }) : null),
        el("p", { class: "comment-text", text: c.text.trim() })));
    }
    cm.append(ul);
  } else if (typeof errors.comments === "string" && errors.comments) {
    cm.append(el("p", { class: "err-note", text: errors.comments }));
  } else {
    cm.append(el("p", { class: "muted-note", text: "No comments to show." }));
  }
}

dom.dialog.addEventListener("close", () => {
  if (detailsCtrl) detailsCtrl.abort();
  detailsCtrl = null;
  if (detailsOpener && document.contains(detailsOpener)) detailsOpener.focus();
  detailsOpener = null;
});
// Click on the backdrop (outside the panel) closes the dialog.
dom.dialog.addEventListener("click", (e) => {
  if (e.target === dom.dialog) dom.dialog.close();
});
$("#details-close").addEventListener("click", () => dom.dialog.close());

// ---------- Events ----------
for (const b of dom.modeBtns) {
  b.addEventListener("click", () => {
    const mode = b.dataset.mode;
    if (mode === state.mode) return;
    state.mode = mode;
    syncControls();
    load();
    if (mode === "search") dom.q.focus();
  });
}

dom.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = dom.q.value.trim().replace(/\s+/g, " ");
  const platforms = dom.checks.filter((c) => c.checked).map((c) => c.value);
  dom.hint.hidden = true;
  if (!q) {
    dom.hint.textContent = "Type something to search for.";
    dom.hint.hidden = false;
    dom.q.focus();
    return;
  }
  if (!platforms.length) {
    dom.hint.textContent = "Pick at least one platform.";
    dom.hint.hidden = false;
    return;
  }
  state.query = q.slice(0, 100);
  state.platforms = new Set(platforms);
  dom.q.value = state.query;
  load();
});

for (const c of dom.checks) {
  c.addEventListener("change", () => {
    if (dom.checks.some((x) => x.checked)) dom.hint.hidden = true;
  });
}

function selectTab(platform, focus) {
  const changed = platform !== state.trend;
  state.trend = platform;
  syncControls();
  if (focus) $(`#tab-${platform}`).focus();
  if (changed) load();
}
for (const t of dom.tabBtns) t.addEventListener("click", () => selectTab(t.dataset.platform, false));
dom.tabs.addEventListener("keydown", (e) => {
  const i = PLATFORMS.indexOf(state.trend);
  let next = null;
  if (e.key === "ArrowRight") next = PLATFORMS[(i + 1) % PLATFORMS.length];
  else if (e.key === "ArrowLeft") next = PLATFORMS[(i - 1 + PLATFORMS.length) % PLATFORMS.length];
  else if (e.key === "Home") next = PLATFORMS[0];
  else if (e.key === "End") next = PLATFORMS[PLATFORMS.length - 1];
  if (next) {
    e.preventDefault();
    selectTab(next, true);
  }
});

dom.sort.addEventListener("change", () => {
  state.sort = SORTS.includes(dom.sort.value) ? dom.sort.value : "default";
  writeUrl();
  render();
});

dom.chips.addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b) return;
  state.filter = b.dataset.filter;
  render();
  const again = dom.chips.querySelector(`[data-filter="${state.filter}"]`);
  if (again) again.focus();
});

dom.notices.addEventListener("click", (e) => {
  const b = e.target.closest("[data-retry]");
  if (!b) return;
  const which = b.dataset.retry;
  if (which === "all") load({ force: true });
  else retryPlatform(which, b);
});

// ---------- Init ----------
readUrl();
syncControls();
load();
refreshCredits();
