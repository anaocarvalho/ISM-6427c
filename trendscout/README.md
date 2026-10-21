# TrendScout: trending short-form video finder

Search a topic or browse what's trending, and see short-form videos from **TikTok**, **YouTube Shorts** and **Instagram Reels** on one screen, with views, likes, comments and engagement rate side by side. Data comes from the [Scrape Creators API](https://docs.scrapecreators.com) through Netlify Functions, so the API key never reaches the browser.

This folder is a self-contained project, separate from the Plateful app at the repo root.

## Features

- **Search** one keyword across all three platforms at once (choose which with checkboxes).
- **Trending** tabs for TikTok, YouTube Shorts and Instagram Reels — no typing needed.
- **Video cards** with thumbnail, creator, date, views, likes, comments and engagement rate. Click to open the original post.
- **Sort** by views, likes, engagement or newest, and **filter** by platform, without new API calls.
- **Details** panel with the transcript and top comments, loaded only when you open it.
- **Partial results:** if one platform fails, the others still show, with a Retry button.
- **Credits badge** showing your remaining Scrape Creators balance.
- Shareable URLs, light/dark theme, works on phones.

## Project layout

| Path | Purpose |
| --- | --- |
| `public/` | The page: `index.html`, `styles.css`, `app.js` |
| `netlify/functions/search.mjs` | `GET /api/search?q=&platforms=` |
| `netlify/functions/trending.mjs` | `GET /api/trending?platform=` |
| `netlify/functions/video.mjs` | `GET /api/video?platform=&url=` (transcript + comments) |
| `netlify/functions/credits.mjs` | `GET /api/credits` |
| `netlify/functions/lib/scrapecreators.mjs` | API calls, timeouts, cache, rate limit, validation |
| `netlify/functions/lib/normalize.mjs` | Maps each platform's response to one video shape |
| `netlify/functions/lib/samples/` | Example responses used by the tests |
| `netlify/functions/api.test.mjs`, `lib/normalize.test.mjs` | Unit tests (`npm test`) |
| `netlify.toml` | Publish dir, functions dir, security headers |

## Deploy to Netlify

1. In Netlify: **Add new site → Import an existing project**, and pick this GitHub repo.
2. Under build settings set **Base directory** to `trendscout`. Netlify then reads `trendscout/netlify.toml` (publish `public`, no build command).
3. Go to **Site configuration → Environment variables** and add `SCRAPECREATORS_API_KEY` with your key from the Scrape Creators dashboard.
4. Deploy. Every push to `main` redeploys.

The key lives only in that Netlify variable. Never put it in code or commit it.

## Run locally

```bash
cd trendscout
cp .env.example .env        # then paste your key into .env (it's git-ignored)
npx netlify-cli dev         # serves the page and the functions at http://localhost:8888
```

## Checks

```bash
npm run check   # syntax-check every function and frontend file
npm test        # unit tests with a stubbed fetch — no real API calls, no credits used
```

## Credits and limits

Each platform request costs Scrape Creators credits, so a three-platform search costs about 3. Results are cached for 15 minutes, transcripts and comments load only on demand, and each visitor IP is limited to about 30 requests a minute.
