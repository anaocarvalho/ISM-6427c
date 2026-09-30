(function () {
  "use strict";

  const USER_NAME = "Ana Cecília";

  // Florida Atlantic University, Boca Raton campus
  const DEFAULT_LOCATION = {
    name: "Boca Raton, FL",
    detail: "Florida Atlantic University",
    latitude: 26.3705,
    longitude: -80.1024,
  };

  const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
  const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
  const REFRESH_MS = 10 * 60 * 1000;

  // WMO weather interpretation codes -> [description, day icon, night icon]
  const WEATHER_CODES = {
    0: ["Clear sky", "☀️", "🌙"],
    1: ["Mainly clear", "🌤️", "🌙"],
    2: ["Partly cloudy", "⛅", "☁️"],
    3: ["Overcast", "☁️", "☁️"],
    45: ["Fog", "🌫️", "🌫️"],
    48: ["Rime fog", "🌫️", "🌫️"],
    51: ["Light drizzle", "🌦️", "🌧️"],
    53: ["Drizzle", "🌦️", "🌧️"],
    55: ["Heavy drizzle", "🌧️", "🌧️"],
    56: ["Freezing drizzle", "🌧️", "🌧️"],
    57: ["Heavy freezing drizzle", "🌧️", "🌧️"],
    61: ["Light rain", "🌦️", "🌧️"],
    63: ["Rain", "🌧️", "🌧️"],
    65: ["Heavy rain", "🌧️", "🌧️"],
    66: ["Freezing rain", "🌧️", "🌧️"],
    67: ["Heavy freezing rain", "🌧️", "🌧️"],
    71: ["Light snow", "🌨️", "🌨️"],
    73: ["Snow", "🌨️", "🌨️"],
    75: ["Heavy snow", "❄️", "❄️"],
    77: ["Snow grains", "🌨️", "🌨️"],
    80: ["Light showers", "🌦️", "🌧️"],
    81: ["Showers", "🌧️", "🌧️"],
    82: ["Violent showers", "⛈️", "⛈️"],
    85: ["Snow showers", "🌨️", "🌨️"],
    86: ["Heavy snow showers", "❄️", "❄️"],
    95: ["Thunderstorm", "⛈️", "⛈️"],
    96: ["Thunderstorm with hail", "⛈️", "⛈️"],
    99: ["Severe thunderstorm with hail", "⛈️", "⛈️"],
  };

  const $ = (id) => document.getElementById(id);

  // ---------- storage helpers ----------
  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  const state = {
    location: load("location", DEFAULT_LOCATION),
    unit: load("unit", "fahrenheit"),
    timer: null,
  };

  // ---------- theme ----------
  function currentThemeChoice() {
    try {
      const t = localStorage.getItem("theme");
      return t === "light" || t === "dark" ? t : "system";
    } catch (e) {
      return "system";
    }
  }
  function applyTheme(choice) {
    const root = document.documentElement;
    if (choice === "system") delete root.dataset.theme;
    else root.dataset.theme = choice;
    try {
      if (choice === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", choice);
    } catch (e) {}
    document.querySelectorAll("[data-theme-choice]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.themeChoice === choice));
    });
  }

  // ---------- greeting ----------
  function renderGreeting() {
    const h = new Date().getHours();
    let part = "Good evening";
    if (h >= 5 && h < 12) part = "Good morning";
    else if (h >= 12 && h < 18) part = "Good afternoon";
    $("greeting").textContent = `${part}, ${USER_NAME}! 👋`;
  }

  // ---------- formatting ----------
  const tempUnit = () => (state.unit === "fahrenheit" ? "°F" : "°C");
  const round = (n) => (n == null || isNaN(n) ? "–" : Math.round(n));
  const fmtTemp = (n) => `${round(n)}°`;

  function fmtTime(iso, tz) {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz });
  }
  function fmtHour(iso, tz) {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", timeZone: tz });
  }
  function fmtDay(dateStr, index) {
    if (index === 0) return "Today";
    // dateStr is YYYY-MM-DD in the location's local date
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], { weekday: "short", timeZone: "UTC" });
  }
  function compass(deg) {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(((deg % 360) / 45)) % 8];
  }
  function weather(code, isDay) {
    const w = WEATHER_CODES[code] || ["Unknown", "🌡️", "🌡️"];
    return { text: w[0], icon: isDay === 0 ? w[2] : w[1] };
  }

  // Open-Meteo returns times without offset when timezone=auto; append the
  // offset so Date parses them as the location's local time.
  function withOffset(iso, offsetSec) {
    const sign = offsetSec >= 0 ? "+" : "-";
    const abs = Math.abs(offsetSec);
    const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
    const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
    return `${iso}${sign}${hh}:${mm}`;
  }

  // ---------- status ----------
  function setStatus(msg, isError) {
    const el = $("status");
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  }

  // ---------- data ----------
  async function fetchWeather() {
    const loc = state.location;
    const params = new URLSearchParams({
      latitude: loc.latitude,
      longitude: loc.longitude,
      current: [
        "temperature_2m", "relative_humidity_2m", "apparent_temperature", "is_day",
        "precipitation", "weather_code", "pressure_msl", "wind_speed_10m",
        "wind_direction_10m", "wind_gusts_10m",
      ].join(","),
      hourly: ["temperature_2m", "precipitation_probability", "weather_code", "is_day"].join(","),
      daily: [
        "weather_code", "temperature_2m_max", "temperature_2m_min", "sunrise", "sunset",
        "uv_index_max", "precipitation_probability_max",
      ].join(","),
      temperature_unit: state.unit,
      wind_speed_unit: state.unit === "fahrenheit" ? "mph" : "kmh",
      precipitation_unit: state.unit === "fahrenheit" ? "inch" : "mm",
      timezone: "auto",
      forecast_days: "7",
    });

    setStatus("Loading latest weather…");
    try {
      const res = await fetch(`${FORECAST_URL}?${params}`);
      if (!res.ok) throw new Error(`Weather service returned ${res.status}`);
      const data = await res.json();
      render(data);
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus("Couldn't load the weather right now. Check your connection and try again.", true);
    }
  }

  function render(data) {
    const tz = data.timezone;
    const off = data.utc_offset_seconds;
    const c = data.current;
    const d = data.daily;
    const w = weather(c.weather_code, c.is_day);
    const loc = state.location;

    $("place-name").textContent = loc.name;
    $("updated").textContent =
      (loc.detail ? loc.detail + " · " : "") + "Updated " + fmtTime(withOffset(c.time, off), tz);
    $("current-icon").textContent = w.icon;
    $("current-temp").textContent = `${round(c.temperature_2m)}${tempUnit()}`;
    $("current-desc").textContent = w.text;
    $("current-hilo").textContent = `H: ${fmtTemp(d.temperature_2m_max[0])}  L: ${fmtTemp(d.temperature_2m_min[0])}`;

    const windUnit = data.current_units.wind_speed_10m;
    $("stat-feels").textContent = fmtTemp(c.apparent_temperature);
    $("stat-humidity").textContent = `${round(c.relative_humidity_2m)}%`;
    $("stat-wind").textContent = `${round(c.wind_speed_10m)} ${windUnit} ${compass(c.wind_direction_10m)}`;
    $("stat-precip").textContent = `${round(d.precipitation_probability_max[0])}%`;
    $("stat-uv").textContent = round(d.uv_index_max[0]);
    $("stat-pressure").textContent = `${round(c.pressure_msl)} hPa`;
    $("stat-sunrise").textContent = fmtTime(withOffset(d.sunrise[0], off), tz);
    $("stat-sunset").textContent = fmtTime(withOffset(d.sunset[0], off), tz);

    $("greeting-sub").textContent = `It's ${round(c.temperature_2m)}${tempUnit()} and ${w.text.toLowerCase()} in ${loc.name}.`;

    // Hourly: next 24 hours starting from the current hour
    const h = data.hourly;
    const nowMs = Date.now();
    let start = h.time.findIndex((t) => new Date(withOffset(t, off)).getTime() > nowMs - 3600 * 1000);
    if (start < 0) start = 0;
    const hourly = $("hourly");
    hourly.replaceChildren();
    for (let i = start; i < Math.min(start + 24, h.time.length); i++) {
      const hw = weather(h.weather_code[i], h.is_day[i]);
      const pop = h.precipitation_probability[i];
      const el = document.createElement("div");
      el.className = "hour";
      el.innerHTML = `
        <div class="h-time">${i === start ? "Now" : fmtHour(withOffset(h.time[i], off), tz)}</div>
        <div class="h-icon" title="${hw.text}">${hw.icon}</div>
        <div class="h-temp">${fmtTemp(h.temperature_2m[i])}</div>
        <div class="h-pop">${pop >= 10 ? pop + "%" : ""}</div>`;
      hourly.appendChild(el);
    }

    // Daily
    const lo = Math.min(...d.temperature_2m_min);
    const hi = Math.max(...d.temperature_2m_max);
    const span = hi - lo || 1;
    const daily = $("daily");
    daily.replaceChildren();
    d.time.forEach((day, i) => {
      const dw = weather(d.weather_code[i], 1);
      const pop = d.precipitation_probability_max[i];
      const left = ((d.temperature_2m_min[i] - lo) / span) * 100;
      const width = ((d.temperature_2m_max[i] - d.temperature_2m_min[i]) / span) * 100;
      const li = document.createElement("li");
      li.className = "day";
      li.innerHTML = `
        <span class="d-name">${fmtDay(day, i)}</span>
        <span class="d-icon" title="${dw.text}">${dw.icon}</span>
        <span class="d-pop">${pop >= 10 ? pop + "%" : ""}</span>
        <span class="d-range">
          <span class="d-lo">${fmtTemp(d.temperature_2m_min[i])}</span>
          <span class="bar"><span style="left:${left}%;width:${Math.max(width, 4)}%"></span></span>
          <span class="d-hi">${fmtTemp(d.temperature_2m_max[i])}</span>
        </span>`;
      daily.appendChild(li);
    });

    $("current").hidden = false;
    $("hourly-section").hidden = false;
    $("daily-section").hidden = false;
  }

  function setLocation(loc) {
    state.location = loc;
    save("location", loc);
    fetchWeather();
    scheduleRefresh();
  }

  function scheduleRefresh() {
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      renderGreeting();
      fetchWeather();
    }, REFRESH_MS);
  }

  // ---------- search ----------
  async function searchCities(query) {
    const results = $("search-results");
    const params = new URLSearchParams({ name: query, count: "8", language: "en", format: "json" });
    try {
      const res = await fetch(`${GEOCODE_URL}?${params}`);
      if (!res.ok) throw new Error(`Geocoding returned ${res.status}`);
      const data = await res.json();
      results.replaceChildren();
      const list = data.results || [];
      if (!list.length) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = `No places found for "${query}".`;
        results.appendChild(li);
      }
      list.forEach((r) => {
        const region = [r.admin1, r.country].filter(Boolean).join(", ");
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = region ? `${r.name}, ${region}` : r.name;
        btn.addEventListener("click", () => {
          results.hidden = true;
          $("search-input").value = "";
          setLocation({
            name: r.admin1 && r.country_code === "US" ? `${r.name}, ${r.admin1}` : `${r.name}${r.country ? ", " + r.country : ""}`,
            detail: "",
            latitude: r.latitude,
            longitude: r.longitude,
          });
        });
        li.appendChild(btn);
        results.appendChild(li);
      });
      results.hidden = false;
    } catch (err) {
      console.error(err);
      setStatus("City search is unavailable right now.", true);
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setStatus("Your browser doesn't support location.", true);
      return;
    }
    setStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setLocation({
          name: "My location",
          detail: "",
          latitude: +pos.coords.latitude.toFixed(4),
          longitude: +pos.coords.longitude.toFixed(4),
        }),
      () => setStatus("Couldn't get your location. You can search for a city instead.", true),
      { timeout: 10000 }
    );
  }

  function applyUnit(unit) {
    state.unit = unit;
    save("unit", unit);
    document.querySelectorAll("[data-unit]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.unit === unit));
    });
  }

  // ---------- init ----------
  function init() {
    renderGreeting();
    applyTheme(currentThemeChoice());
    applyUnit(state.unit);

    document.querySelectorAll("[data-theme-choice]").forEach((b) =>
      b.addEventListener("click", () => applyTheme(b.dataset.themeChoice))
    );
    document.querySelectorAll("[data-unit]").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.unit === state.unit) return;
        applyUnit(b.dataset.unit);
        fetchWeather();
      })
    );

    $("search-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const q = $("search-input").value.trim();
      if (q.length >= 2) searchCities(q);
    });
    $("locate-btn").addEventListener("click", useMyLocation);
    $("home-btn").addEventListener("click", () => setLocation(DEFAULT_LOCATION));

    document.addEventListener("click", (e) => {
      if (!$("search-form").contains(e.target)) $("search-results").hidden = true;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") $("search-results").hidden = true;
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        renderGreeting();
        fetchWeather();
      }
    });

    fetchWeather();
    scheduleRefresh();
  }

  init();
})();
