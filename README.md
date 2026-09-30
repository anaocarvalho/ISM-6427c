# ISM-6427c — Boca Weather

A responsive weather app that shows live conditions, a 24-hour forecast and a 7-day forecast. It opens on **Boca Raton, FL (Florida Atlantic University)** by default and greets the visitor by name.

- **Data:** [Open-Meteo](https://open-meteo.com/). It's free and needs no API key or account.
- **Themes:** Light, Dark and System (follows your device setting). Your choice is remembered.
- **Units:** °F / °C toggle.
- **Locations:** search any city, use your current location (📍), or jump back to Boca Raton (🏠).
- **Responsive:** works on phones, tablets and desktop browsers.
- **Auto-refresh:** reloads the data every 10 minutes and whenever you return to the tab.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup |
| `styles.css` | Styles, themes and responsive layout |
| `app.js` | Open-Meteo calls, rendering, theme and search logic |
| `netlify.toml` | Netlify config (no build step) |

## Run locally

It's plain HTML/CSS/JS, so any static server works:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy to Netlify

1. In Netlify, choose **Add new site → Import an existing project** and pick this GitHub repo.
2. Leave **Build command** empty and set **Publish directory** to `.` (both come from `netlify.toml`).
3. Click **Deploy**. Every push to `main` redeploys the site automatically.

Or drag and drop the project folder onto <https://app.netlify.com/drop>.
