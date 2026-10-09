# Plateful: AI Calorie Tracker

Type what you ate the way you'd text a friend ("2 scrambled eggs, toast with butter, a large oat latte"). A Netlify Function sends the text to the **Claude API**, which returns calories, protein, carbs and fat for each item plus totals. Add the calories you burned, and Plateful shows your daily log, 7-day averages, and whether you're in a **deficit or surplus**, with a bar chart.

## Features

- **AI meal logging.** Type a sentence, a comma list, or one food per line. Claude returns every item as structured JSON, and the meal is saved right away. The breakdown card lets you remove an item, undo, or re-analyze.
- **Meal memory.** One tap for *"Same breakfast as yesterday"*, a recent-meals row for quick re-logging, favorites (⭐), "Had it again", and "Copy all of yesterday's meals". If you type a meal you've logged before, the saved result is reused with no AI call.
- **Calories burned** for each day, with +100/+250/+500 buttons and "Same as yesterday".
- **Daily summary.** A progress ring against your goal, eaten/burned/net totals, a deficit/surplus badge, and macro bars.
- **Trends.** 7-day average intake, burned and balance, projected weekly weight change, an interactive intake-vs-burned bar chart with your goal line (with a table view), average macro split, and insights.
- **Engagement.** A personal greeting (defaults to **Ana Cecília**), streaks, 12 unlockable badges with confetti, playful loading messages, and undo on every change.
- **Getting started.** A welcome screen with a calorie goal picker, plus a **sample week** you can load to explore.
- **Light / Dark / System** themes. Your choice is remembered.
- **Responsive** on phone (bottom tab bar), tablet and desktop. Installable to the home screen (web manifest).
- **Your data.** Everything is stored in your browser (localStorage). You can export or import a JSON backup, or erase it all. A manual-entry fallback works without AI.

## Project layout

| Path | Purpose |
| --- | --- |
| `public/index.html` | App markup |
| `public/styles.css` | Theme tokens (light/dark/system), responsive layout |
| `public/app.js` | State, rendering, meal memory, chart, badges |
| `public/weather/` | The earlier Boca Weather app, still available at `/weather/` |
| `netlify/functions/analyze-meal.mjs` | Serverless function at `POST /api/analyze-meal` that calls Claude |
| `netlify.toml` | Publish `public/`, functions directory, headers |
| `package.json` | `@anthropic-ai/sdk` dependency for the function |

## Deploy to Netlify

1. In Netlify: **Add new site → Import an existing project**, then pick this GitHub repo. The build settings come from `netlify.toml`: publish directory `public`, no build command.
2. Go to **Site configuration → Environment variables** and add:
   - `ANTHROPIC_API_KEY`: your key from <https://platform.claude.com/>. It's only used server-side and is never sent to the browser.
   - *(optional)* `ANTHROPIC_MODEL`: defaults to `claude-opus-5-5`.
3. **Deploy** (or trigger a redeploy after you add the key). Every push to `main` redeploys automatically.

### How the function calls Claude

- Model `claude-opus-5-5` with **structured outputs** (`output_config.format` with a JSON schema), so the response is always valid JSON in the expected shape.
- **Complete itemization.** The function splits the text into lines and comma-separated entries and passes that checklist to Claude. The schema has Claude list every food it sees (`foods_mentioned`) before estimating each one. If the answer has fewer items than the checklist, the function retries once.
- `effort: "medium"` for accuracy. Answers well within Netlify's 60-second function limit.
- **Server-side refusal fallback is on** (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). If a safety classifier declines a request, the API retries it on Anthropic's recommended fallback model.
- Totals are recomputed on the server from the items, and the input is capped at 2,000 characters.
- `GET /api/analyze-meal` is a health check (`hasKey`, `model`). It's wired to **Settings → Test AI connection**. Failed requests show the API's error detail under the meal box.

## Run locally

```bash
npm install
npx netlify-cli dev        # serves public/ and the function at http://localhost:8888
```

Put `ANTHROPIC_API_KEY=...` in a local `.env` file (it's git-ignored) or export it in your shell. Opening `public/index.html` with a plain static server also works, but meal analysis then falls back to manual entry.

*Estimates come from AI and may be off. Plateful isn't medical advice.*
