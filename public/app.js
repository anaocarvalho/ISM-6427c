/* Plateful: AI calorie tracker.
 * All data lives in localStorage. Meal text is sent to /api/analyze-meal
 * (a Netlify Function that calls the Claude API) and comes back as JSON. */
(function () {
  "use strict";

  // ---------- Constants ----------
  const STORE_KEY = "plateful.v1";
  const THEME_KEY = "plateful.theme";
  const API_URL = "/api/analyze-meal";
  const MEALS = {
    breakfast: { label: "Breakfast", emoji: "🌅" },
    lunch: { label: "Lunch", emoji: "🥪" },
    dinner: { label: "Dinner", emoji: "🍝" },
    snack: { label: "Snack", emoji: "🍎" },
  };
  const MEAL_ORDER = ["breakfast", "lunch", "dinner", "snack"];
  const EXAMPLES = [
    "🥚 2 eggs, toast & butter, OJ",
    "🥣 Greek yogurt with granola and blueberries",
    "🌯 Chipotle chicken burrito bowl, no sour cream",
    "🍕 2 slices pepperoni pizza and a Coke",
    "🥗 Caesar salad with grilled chicken",
    "🍣 8 pieces salmon sushi and miso soup",
    "☕ Large oat milk latte and a croissant",
    "🍝 1.5 cups spaghetti bolognese with parmesan",
    "🍌 Banana with 2 tbsp peanut butter",
  ];
  const LOADING_MSGS = [
    "Counting calories…",
    "Weighing the invisible butter…",
    "Consulting the snack oracle…",
    "Measuring the cheese (honestly)…",
    "Crunching numbers, not chips…",
    "Asking the avocado for its macros…",
  ];

  // ---------- Helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const fmt = (n) => Math.round(n).toLocaleString();
  const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString();
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  const pad = (n) => String(n).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return dateKey(d); };
  const todayKey = () => dateKey(new Date());
  const dayName = (k, opts = { weekday: "long" }) => parseKey(k).toLocaleDateString(undefined, opts);
  function relDay(k) {
    const t = todayKey();
    if (k === t) return "today";
    if (k === addDays(t, -1)) return "yesterday";
    return "on " + dayName(k);
  }

  // ---------- State ----------
  const defaultState = () => ({
    profile: { name: "Ana Cecília", goal: 2000, proteinGoal: 100, units: "lb", onboarded: false },
    days: {},
    favorites: [],
    badges: {},
  });

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);
      const d = defaultState();
      return { ...d, ...s, profile: { ...d.profile, ...(s.profile || {}) } };
    } catch (e) {
      return defaultState();
    }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage full or blocked */ }
  }

  let state = load();
  let viewDate = todayKey();
  let selectedMeal = guessMealType();
  let pending = null; // analysis preview waiting for "Add to log"
  let loadingTimer = null;

  const day = (k) => state.days[k] || { meals: [], burned: null };
  function ensureDay(k) {
    if (!state.days[k]) state.days[k] = { meals: [], burned: null };
    return state.days[k];
  }
  function dayTotals(k) {
    const t = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    for (const m of day(k).meals) for (const key in t) t[key] += m.totals[key] || 0;
    return t;
  }
  const hasMeals = (k) => day(k).meals.length > 0;

  function guessMealType() {
    const h = new Date().getHours();
    if (h < 11) return "breakfast";
    if (h < 15) return "lunch";
    if (h >= 17 && h < 22) return "dinner";
    return "snack";
  }

  // ---------- Theme ----------
  function applyTheme(choice) {
    if (choice === "light" || choice === "dark") document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
    $$("[data-theme-choice]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeChoice === choice)));
    try { localStorage.setItem(THEME_KEY, choice); } catch (e) {}
    if (!$("#view-trends").hidden) renderChart();
  }
  function initTheme() {
    let t = "system";
    try { t = localStorage.getItem(THEME_KEY) || "system"; } catch (e) {}
    applyTheme(t);
    $$("[data-theme-choice]").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.themeChoice)));
  }

  // ---------- Tabs ----------
  function showTab(name) {
    $$(".view").forEach((v) => (v.hidden = v.dataset.view !== name));
    $$("[data-tab]").forEach((b) => {
      if (b.dataset.tab === name) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    if (name === "trends") renderTrends();
    if (name === "badges") renderBadges();
    if (name === "settings") fillSettings();
    window.scrollTo({ top: 0, behavior: "smooth" });
    try { history.replaceState(null, "", "#" + name); } catch (e) {}
  }

  // ---------- Toasts & confetti ----------
  function toast(msg, action) {
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<span>${esc(msg)}</span>`;
    if (action) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = action.label;
      b.addEventListener("click", () => { action.run(); el.remove(); });
      el.appendChild(b);
    }
    const wrap = $("#toasts");
    wrap.appendChild(el);
    while (wrap.children.length > 2) wrap.firstElementChild.remove();
    setTimeout(() => el.remove(), action ? 6000 : 3500);
  }

  function confetti() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = $("#confetti");
    const colors = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"];
    for (let i = 0; i < 80; i++) {
      const p = document.createElement("i");
      p.style.left = Math.random() * 100 + "vw";
      p.style.background = colors[i % colors.length];
      p.style.setProperty("--dx", (Math.random() * 200 - 100).toFixed(0) + "px");
      p.style.setProperty("--rot", (Math.random() * 720 - 360).toFixed(0) + "deg");
      p.style.animationDuration = (1.6 + Math.random() * 1.6).toFixed(2) + "s";
      p.style.animationDelay = (Math.random() * 0.3).toFixed(2) + "s";
      root.appendChild(p);
      setTimeout(() => p.remove(), 3800);
    }
  }

  // ---------- Streaks ----------
  function currentStreak() {
    let k = todayKey();
    if (!hasMeals(k)) k = addDays(k, -1); // today isn't over yet
    let n = 0;
    while (hasMeals(k)) { n++; k = addDays(k, -1); }
    return n;
  }
  function bestStreak() {
    const keys = Object.keys(state.days).filter(hasMeals).sort();
    let best = 0, run = 0, prev = null;
    for (const k of keys) {
      run = prev && addDays(prev, 1) === k ? run + 1 : 1;
      best = Math.max(best, run);
      prev = k;
    }
    return best;
  }

  // ---------- Meal memory ----------
  // Most recent earlier day (within 14 days) that has meals of this type.
  function repeatSource(type, fromKey) {
    for (let i = 1; i <= 14; i++) {
      const k = addDays(fromKey, -i);
      const meals = day(k).meals.filter((m) => m.type === type);
      if (meals.length) return { key: k, meals };
    }
    return null;
  }

  // Unique past meals, newest first. Favorites lead; current meal type next.
  function recentMeals(type, limit = 8) {
    const seen = new Set();
    const out = [];
    for (const f of state.favorites) {
      const n = norm(f.text);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push({ ...f, fav: true });
    }
    const all = [];
    for (const k of Object.keys(state.days).sort().reverse()) {
      for (const m of day(k).meals.slice().reverse()) all.push(m);
    }
    const sameType = all.filter((m) => m.type === type);
    const other = all.filter((m) => m.type !== type);
    for (const m of [...sameType, ...other]) {
      const n = norm(m.text);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(m);
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  // Previously analyzed text → reuse its result instead of calling the AI again.
  function findRemembered(text) {
    const n = norm(text);
    for (const k of Object.keys(state.days).sort().reverse()) {
      const hit = day(k).meals.find((m) => norm(m.text) === n && !m.manual);
      if (hit) return { meal: hit, key: k };
    }
    return null;
  }

  function cloneMeal(m, type) {
    return {
      id: uid(),
      type: type || m.type,
      text: m.text,
      time: Date.now(),
      items: m.items.map((it) => ({ ...it })),
      totals: { ...m.totals },
      notes: m.notes || "",
      manual: !!m.manual,
    };
  }

  function addMeals(meals, k = viewDate, msg) {
    const d = ensureDay(k);
    d.meals.push(...meals);
    save();
    renderAll();
    const ids = meals.map((m) => m.id);
    toast(msg || `Logged ${fmt(meals.reduce((a, m) => a + m.totals.calories, 0))} kcal`, {
      label: "Undo",
      run: () => {
        d.meals = d.meals.filter((m) => !ids.includes(m.id));
        save();
        renderAll();
      },
    });
    checkBadges();
  }

  // ---------- Today view ----------
  function renderGreeting() {
    const h = new Date().getHours();
    const part = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    const name = state.profile.name;
    $("#greeting").textContent = name ? `${part}, ${name} 👋` : `${part} 👋`;
    const t = dayTotals(todayKey());
    const left = state.profile.goal - t.calories;
    let sub = "What's on your plate today?";
    if (t.calories > 0 && left > 0) sub = `${fmt(left)} kcal to go. You've got this.`;
    else if (t.calories > 0 && left <= 0) sub = "Goal reached for today. Nice work!";
    $("#greeting-sub").textContent = sub;

    const s = currentStreak();
    $("#streak-count").textContent = s;
    $("#streak-chip").classList.toggle("hot", s >= 3);
  }

  function renderDateNav() {
    const t = todayKey();
    const isToday = viewDate === t;
    $("#day-label").textContent = isToday ? "Today" : viewDate === addDays(t, -1) ? "Yesterday" : dayName(viewDate);
    $("#day-sub").textContent = parseKey(viewDate).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    $("#day-next").disabled = isToday;
    $("#day-today").hidden = isToday;
  }

  function renderSummary() {
    const t = dayTotals(viewDate);
    const goal = state.profile.goal || 2000;
    const burned = day(viewDate).burned;
    const pct = clamp((t.calories / goal) * 100, 0, 100);
    const fill = $("#ring-fill");
    fill.setAttribute("stroke-dasharray", `${pct} 100`);
    fill.classList.toggle("over", t.calories > goal);
    $("#ring-eaten").textContent = fmt(t.calories);
    $("#ring-goal").textContent = fmt(goal);
    const left = goal - t.calories;
    $("#ring-left").textContent = left >= 0 ? `${fmt(left)} left` : `${fmt(-left)} over`;

    $("#sum-eaten").textContent = `${fmt(t.calories)} kcal`;
    $("#sum-burned").textContent = burned != null ? `${fmt(burned)} kcal` : "—";
    const pill = $("#balance-pill");
    if (burned != null) {
      const net = t.calories - burned;
      $("#sum-net").textContent = `${net > 0 ? "+" : ""}${fmt(net)} kcal`;
      if (net < 0) { pill.className = "balance-pill deficit"; pill.textContent = `▼ ${fmt(-net)} kcal deficit`; }
      else if (net > 0) { pill.className = "balance-pill surplus"; pill.textContent = `▲ ${fmt(net)} kcal surplus`; }
      else { pill.className = "balance-pill neutral"; pill.textContent = "Perfectly balanced ⚖️"; }
    } else {
      $("#sum-net").textContent = "—";
      pill.className = "balance-pill neutral";
      pill.textContent = "Log calories burned to see your balance";
    }

    // Macro targets: protein from settings; carbs/fat from a 50/30 split of the calorie goal.
    const targets = { protein: state.profile.proteinGoal || 100, carbs: (goal * 0.5) / 4, fat: (goal * 0.3) / 9 };
    const vals = { protein: t.protein_g, carbs: t.carbs_g, fat: t.fat_g };
    for (const m of ["protein", "carbs", "fat"]) {
      $(`#m-${m}`).textContent = `${fmt(vals[m])} / ${fmt(targets[m])} g`;
      $(`#mb-${m}`).style.width = clamp((vals[m] / targets[m]) * 100, 0, 100) + "%";
    }
  }

  function renderComposer() {
    $$("[data-meal]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.meal === selectedMeal)));

    // "Same as yesterday" for the selected meal type.
    const src = repeatSource(selectedMeal, viewDate);
    const btn = $("#repeat-btn");
    if (src) {
      const kcal = src.meals.reduce((a, m) => a + m.totals.calories, 0);
      const when = src.key === addDays(viewDate, -1) ? "yesterday" : "on " + dayName(src.key);
      $("#repeat-title").textContent = `Same ${MEALS[selectedMeal].label.toLowerCase()} as ${when}`;
      $("#repeat-sub").textContent = src.meals.map((m) => m.text).join(" + ");
      $("#repeat-kcal").textContent = `${fmt(kcal)} kcal`;
      btn.hidden = false;
      btn.onclick = () => {
        addMeals(src.meals.map((m) => cloneMeal(m, selectedMeal)), viewDate,
          `${MEALS[selectedMeal].emoji} Same ${MEALS[selectedMeal].label.toLowerCase()} logged · ${fmt(kcal)} kcal`);
      };
    } else {
      btn.hidden = true;
    }

    // One-tap recent meals and favorites.
    const recent = recentMeals(selectedMeal);
    const qc = $("#quick-chips");
    qc.innerHTML = "";
    for (const m of recent) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (m.fav ? " fav" : "");
      const label = m.text.length > 34 ? m.text.slice(0, 32) + "…" : m.text;
      b.innerHTML = `${esc(label)}<span class="chip-kcal">${fmt(m.totals.calories)}</span>`;
      b.title = `Log "${m.text}" as ${MEALS[selectedMeal].label}`;
      b.addEventListener("click", () => addMeals([cloneMeal(m, selectedMeal)], viewDate, `Logged "${label}" · ${fmt(m.totals.calories)} kcal`));
      qc.appendChild(b);
    }
    $("#quick-wrap").hidden = recent.length === 0;
    $("#memory").hidden = !src && recent.length === 0;
  }

  function itemRow(it, i, removable) {
    return `<li class="item">
      <span class="item-emoji" aria-hidden="true">${esc(it.emoji || "🍽️")}</span>
      <div><div class="item-name">${esc(it.name)}</div>
        <div class="item-meta">${esc(it.quantity || "")}${it.quantity ? " · " : ""}P ${fmt1(it.protein_g)}g · C ${fmt1(it.carbs_g)}g · F ${fmt1(it.fat_g)}g</div></div>
      <span class="item-kcal">${fmt(it.calories)} kcal</span>
      ${removable ? `<button type="button" class="item-remove" data-remove="${i}" aria-label="Remove ${esc(it.name)}">×</button>` : "<span></span>"}
    </li>`;
  }

  function renderMeals() {
    const d = day(viewDate);
    const list = $("#meal-list");
    list.innerHTML = "";
    $("#meals-empty").hidden = d.meals.length > 0;
    $("#meals-count").textContent = d.meals.length ? `${d.meals.length} logged · ${fmt(dayTotals(viewDate).calories)} kcal` : "";

    // Offer to copy the whole previous day when this day is empty.
    const prevKey = addDays(viewDate, -1);
    const empty = $("#meals-empty");
    let copyBtn = $("#copy-day-btn");
    if (!d.meals.length && hasMeals(prevKey)) {
      if (!copyBtn) {
        copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.id = "copy-day-btn";
        copyBtn.className = "btn copy-day";
        empty.appendChild(copyBtn);
      }
      const prev = day(prevKey).meals;
      copyBtn.textContent = `↺ Copy all ${prev.length} meals from the day before (${fmt(dayTotals(prevKey).calories)} kcal)`;
      copyBtn.onclick = () => addMeals(prev.map((m) => cloneMeal(m)), viewDate, "Copied the day before's meals");
    } else if (copyBtn) {
      copyBtn.remove();
    }

    const favSet = new Set(state.favorites.map((f) => norm(f.text)));
    for (const type of MEAL_ORDER) {
      const meals = d.meals.filter((m) => m.type === type);
      if (!meals.length) continue;
      const kcal = meals.reduce((a, m) => a + m.totals.calories, 0);
      const g = document.createElement("div");
      g.className = "meal-group";
      g.innerHTML = `<div class="meal-group-head"><span>${MEALS[type].emoji} ${MEALS[type].label}</span><span>${fmt(kcal)} kcal</span></div>`;
      for (const m of meals) {
        const isFav = favSet.has(norm(m.text));
        const time = new Date(m.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const e = document.createElement("div");
        e.className = "entry";
        e.innerHTML = `
          <div class="entry-top">
            <div class="entry-text">
              <div class="entry-title">${esc(m.text)}</div>
              <div class="entry-macros">${time} · P ${fmt(m.totals.protein_g)}g · C ${fmt(m.totals.carbs_g)}g · F ${fmt(m.totals.fat_g)}g</div>
            </div>
            <span class="entry-kcal">${fmt(m.totals.calories)} kcal</span>
          </div>
          ${m.items.length > 1 || m.notes ? `<details><summary>${m.items.length} item${m.items.length === 1 ? "" : "s"}</summary>
            <ul class="items">${m.items.map((it, i) => itemRow(it, i, false)).join("")}</ul>
            ${m.notes ? `<p class="note">${esc(m.notes)}</p>` : ""}</details>` : ""}
          <div class="entry-actions">
            <button type="button" data-act="fav" class="${isFav ? "fav-on" : ""}" aria-pressed="${isFav}">${isFav ? "⭐ Favorite" : "☆ Favorite"}</button>
            ${viewDate !== todayKey() ? `<button type="button" data-act="today">↺ Log again today</button>` : `<button type="button" data-act="again">↺ Had it again</button>`}
            <button type="button" data-act="delete">🗑 Delete</button>
          </div>`;
        e.querySelector('[data-act="fav"]').addEventListener("click", () => toggleFavorite(m));
        const again = e.querySelector('[data-act="again"], [data-act="today"]');
        again.addEventListener("click", () => {
          const target = again.dataset.act === "today" ? todayKey() : viewDate;
          addMeals([cloneMeal(m)], target, target === viewDate ? "Logged it again" : "Added to today");
        });
        e.querySelector('[data-act="delete"]').addEventListener("click", () => deleteMeal(m.id));
        g.appendChild(e);
      }
      list.appendChild(g);
    }
  }

  function toggleFavorite(m) {
    const n = norm(m.text);
    const i = state.favorites.findIndex((f) => norm(f.text) === n);
    if (i >= 0) {
      state.favorites.splice(i, 1);
      toast("Removed from favorites");
    } else {
      state.favorites.unshift({ id: uid(), text: m.text, type: m.type, items: m.items, totals: m.totals, notes: m.notes || "", manual: !!m.manual });
      toast("⭐ Saved to favorites for one-tap logging");
    }
    save();
    renderAll();
    checkBadges();
  }

  function deleteMeal(id) {
    const d = ensureDay(viewDate);
    const idx = d.meals.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const [removed] = d.meals.splice(idx, 1);
    save();
    renderAll();
    toast("Meal deleted", {
      label: "Undo",
      run: () => { d.meals.splice(idx, 0, removed); save(); renderAll(); },
    });
  }

  function renderBurned() {
    const b = day(viewDate).burned;
    const input = $("#burned-input");
    if (document.activeElement !== input) input.value = b != null ? b : "";
    const prev = day(addDays(viewDate, -1)).burned;
    $("#burn-copy").hidden = prev == null;
    if (prev != null) $("#burn-copy").textContent = `↺ Same as yesterday (${fmt(prev)})`;
    $("#burn-clear").hidden = b == null;
  }

  function setBurned(v) {
    const d = ensureDay(viewDate);
    d.burned = v == null ? null : clamp(Math.round(v), 0, 10000);
    save();
    renderAll();
    checkBadges();
  }

  // ---------- Analyze ----------
  function showLoading(on) {
    $("#analyzing").hidden = !on;
    $("#analyze-btn").disabled = on;
    clearInterval(loadingTimer);
    if (on) {
      let i = 0;
      $("#analyzing-msg").textContent = LOADING_MSGS[0];
      loadingTimer = setInterval(() => {
        i = (i + 1) % LOADING_MSGS.length;
        $("#analyzing-msg").textContent = LOADING_MSGS[i];
      }, 1700);
    }
  }
  function showError(msg) {
    const el = $("#composer-error");
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  async function analyze(text) {
    showError("");
    hidePreview();

    // Already analyzed this exact meal before? Reuse it instantly.
    const remembered = findRemembered(text);
    if (remembered) {
      const m = remembered.meal;
      showPreview({
        text,
        items: m.items.map((it) => ({ ...it })),
        notes: `Remembered from ${relDay(remembered.key)}, so no AI call needed.`,
      });
      return;
    }

    showLoading(true);
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: ctrl.signal,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
      if (!res.ok || !data) {
        throw new Error((data && data.error) || (res.status === 404
          ? "The AI function isn't available here. Deploy to Netlify (or run `netlify dev`) to analyze meals, or enter it manually."
          : `Something went wrong (${res.status}). Please try again.`));
      }
      showPreview({ text, items: data.items, notes: data.notes });
    } catch (err) {
      showError(err.name === "AbortError" ? "That took too long. Please try again." : err.message);
    } finally {
      clearTimeout(timeout);
      showLoading(false);
    }
  }

  function totalsOf(items) {
    const t = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    for (const it of items) for (const k in t) t[k] += Number(it[k]) || 0;
    t.calories = Math.round(t.calories);
    for (const k of ["protein_g", "carbs_g", "fat_g"]) t[k] = Math.round(t[k] * 10) / 10;
    return t;
  }

  function showPreview(p) {
    pending = p;
    renderPreview();
    $("#preview").hidden = false;
    $("#preview").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function renderPreview() {
    if (!pending) return;
    const t = totalsOf(pending.items);
    $("#preview-total").textContent = `${fmt(t.calories)} kcal`;
    $("#preview-items").innerHTML = pending.items.map((it, i) => itemRow(it, i, pending.items.length > 1)).join("");
    $("#preview-note").hidden = !pending.notes;
    $("#preview-note").textContent = pending.notes || "";
  }
  function hidePreview() {
    pending = null;
    $("#preview").hidden = true;
  }
  function savePreview() {
    if (!pending || !pending.items.length) return;
    const meal = {
      id: uid(),
      type: selectedMeal,
      text: pending.text,
      time: Date.now(),
      items: pending.items,
      totals: totalsOf(pending.items),
      notes: pending.notes || "",
      manual: !!pending.manual,
    };
    hidePreview();
    $("#meal-text").value = "";
    updateCharCount();
    addMeals([meal], viewDate, `${MEALS[meal.type].emoji} ${MEALS[meal.type].label} logged · ${fmt(meal.totals.calories)} kcal`);
  }

  function updateCharCount() {
    $("#char-count").textContent = `${$("#meal-text").value.length} / 1200`;
  }

  // ---------- Trends ----------
  function lastNDays(n, endKey = todayKey()) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(addDays(endKey, -i));
    return out;
  }

  function weekStats() {
    const keys = lastNDays(7);
    const rows = keys.map((k) => {
      const t = dayTotals(k);
      return { key: k, intake: t.calories, burned: day(k).burned, logged: hasMeals(k), ...t };
    });
    const logged = rows.filter((r) => r.logged);
    const withBurn = rows.filter((r) => r.burned != null);
    const both = rows.filter((r) => r.logged && r.burned != null);
    const avg = (arr, f) => (arr.length ? arr.reduce((a, r) => a + f(r), 0) / arr.length : null);
    return {
      rows,
      logged,
      withBurn,
      both,
      avgIntake: avg(logged, (r) => r.intake),
      avgBurned: avg(withBurn, (r) => r.burned),
      avgNet: avg(both, (r) => r.intake - r.burned),
      avgP: avg(logged, (r) => r.protein_g),
      avgC: avg(logged, (r) => r.carbs_g),
      avgF: avg(logged, (r) => r.fat_g),
    };
  }

  function renderTrends() {
    const s = weekStats();
    const keys = s.rows.map((r) => r.key);
    $("#trend-range").textContent =
      `${parseKey(keys[0]).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${parseKey(keys[6]).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

    const empty = !s.logged.length && !s.withBurn.length;
    $("#trends-empty").hidden = !empty;
    $$(".tiles, .chart-card, #view-trends .grid-2").forEach((el) => (el.hidden = empty));
    if (empty) return;

    $("#t-intake").textContent = s.avgIntake != null ? `${fmt(s.avgIntake)}` : "—";
    $("#t-intake-sub").textContent = `kcal/day · ${s.logged.length} of 7 days logged`;
    $("#t-burned").textContent = s.avgBurned != null ? `${fmt(s.avgBurned)}` : "—";
    $("#t-burned-sub").textContent = `kcal/day · ${s.withBurn.length} of 7 days`;

    const tile = $("#t-balance-tile");
    tile.classList.remove("deficit", "surplus");
    if (s.avgNet != null) {
      const net = s.avgNet;
      $("#t-balance").textContent = `${net > 0 ? "+" : net < 0 ? "−" : ""}${fmt(Math.abs(net))}`;
      if (net < 0) { tile.classList.add("deficit"); $("#t-balance-sub").textContent = "▼ Deficit · kcal/day"; }
      else if (net > 0) { tile.classList.add("surplus"); $("#t-balance-sub").textContent = "▲ Surplus · kcal/day"; }
      else $("#t-balance-sub").textContent = "Balanced";
      const perUnit = state.profile.units === "kg" ? 7700 : 3500;
      const change = (net * 7) / perUnit;
      $("#t-weight").textContent = `${change > 0 ? "+" : change < 0 ? "−" : ""}${Math.abs(change).toFixed(1)} ${state.profile.units}`;
    } else {
      $("#t-balance").textContent = "—";
      $("#t-balance-sub").textContent = "Needs meals + burned on the same day";
      $("#t-weight").textContent = "—";
    }

    renderChart();
    renderChartTable(s);
    renderMacroWeek(s);
    renderInsights(s);
  }

  function niceMax(v) {
    if (v <= 0) return 1000;
    const step = v > 3000 ? 1000 : 500;
    return Math.ceil(v / step) * step;
  }

  // Bar with 4px rounded top corners, anchored flat on the baseline.
  function barPath(x, y, w, h) {
    if (h <= 0) return "";
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function renderChart() {
    const host = $("#chart");
    if (!host || host.offsetParent === null) return;
    const s = weekStats();
    const W = Math.max(280, host.clientWidth);
    const H = W < 480 ? 220 : 260;
    const m = { top: 12, right: 8, bottom: 30, left: 44 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;
    const goal = state.profile.goal || 2000;
    const maxV = niceMax(Math.max(goal, ...s.rows.map((r) => Math.max(r.intake, r.burned || 0))) * 1.05);
    const y = (v) => m.top + ih - (v / maxV) * ih;
    const gw = iw / 7;
    const bw = Math.min(26, gw * 0.34);
    const today = todayKey();
    const narrow = W < 420;

    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart of daily calorie intake and calories burned for the last 7 days">`;
    svg += `<g class="grid">`;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (maxV / ticks) * i;
      svg += `<line x1="${m.left}" x2="${W - m.right}" y1="${y(v)}" y2="${y(v)}" />`;
    }
    svg += `</g><g class="axis">`;
    for (let i = 0; i <= ticks; i++) {
      const v = (maxV / ticks) * i;
      svg += `<text x="${m.left - 8}" y="${y(v) + 4}" text-anchor="end">${v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : v}</text>`;
    }
    s.rows.forEach((r, i) => {
      const cx = m.left + gw * i + gw / 2;
      const label = parseKey(r.key).toLocaleDateString(undefined, { weekday: narrow ? "narrow" : "short" });
      svg += `<text class="day-label${r.key === today ? " today" : ""}" x="${cx}" y="${H - 10}" text-anchor="middle">${label}</text>`;
    });
    svg += `</g>`;

    s.rows.forEach((r, i) => {
      const cx = m.left + gw * i + gw / 2;
      const x1 = cx - bw - 1; // 2px gap between the pair
      const x2 = cx + 1;
      if (r.intake > 0) svg += `<path class="bar-intake" d="${barPath(x1, y(r.intake), bw, y(0) - y(r.intake))}" />`;
      if (r.burned) svg += `<path class="bar-burned" d="${barPath(x2, y(r.burned), bw, y(0) - y(r.burned))}" />`;
    });
    svg += `<line class="goal-line" x1="${m.left}" x2="${W - m.right}" y1="${y(goal)}" y2="${y(goal)}" />`;
    s.rows.forEach((r, i) => {
      svg += `<rect class="hit" data-i="${i}" x="${m.left + gw * i}" y="${m.top}" width="${gw}" height="${ih}" rx="6" tabindex="0" aria-label="${esc(dayName(r.key))}: intake ${fmt(r.intake)}, burned ${r.burned != null ? fmt(r.burned) : "not logged"}" />`;
    });
    svg += `</svg>`;
    host.innerHTML = svg;

    const tip = $("#chart-tooltip");
    const card = host.closest(".chart-card");
    const show = (el) => {
      $$(".hit", host).forEach((h) => h.classList.toggle("active", h === el));
      const r = s.rows[Number(el.dataset.i)];
      const net = r.burned != null && r.logged ? r.intake - r.burned : null;
      tip.innerHTML = `<strong>${esc(parseKey(r.key).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }))}</strong>
        <div class="tt-row"><i class="sw sw-intake"></i>Intake<strong>${fmt(r.intake)}</strong></div>
        <div class="tt-row"><i class="sw sw-burned"></i>Burned<strong>${r.burned != null ? fmt(r.burned) : "—"}</strong></div>
        <div class="tt-row">${net == null ? "Balance" : net < 0 ? "▼ Deficit" : "▲ Surplus"}<strong>${net == null ? "—" : fmt(Math.abs(net))}</strong></div>`;
      tip.hidden = false;
      const cr = card.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const tw = tip.offsetWidth;
      let left = er.left - cr.left + er.width / 2 - tw / 2;
      left = clamp(left, 8, cr.width - tw - 8);
      tip.style.left = left + "px";
      tip.style.top = er.top - cr.top + 4 + "px";
    };
    const hide = () => { tip.hidden = true; $$(".hit", host).forEach((h) => h.classList.remove("active")); };
    $$(".hit", host).forEach((h) => {
      h.addEventListener("mouseenter", () => show(h));
      h.addEventListener("focus", () => show(h));
      h.addEventListener("click", () => show(h));
      h.addEventListener("mouseleave", hide);
      h.addEventListener("blur", hide);
    });
  }

  function renderChartTable(s) {
    const rows = s.rows.map((r) => {
      const net = r.burned != null && r.logged ? r.intake - r.burned : null;
      return `<tr><td>${esc(parseKey(r.key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}</td>
        <td>${r.logged ? fmt(r.intake) : "—"}</td><td>${r.burned != null ? fmt(r.burned) : "—"}</td>
        <td>${net == null ? "—" : (net > 0 ? "+" : "") + fmt(net)}</td></tr>`;
    }).join("");
    $("#chart-table").innerHTML = `<table><thead><tr><th>Day</th><th>Intake</th><th>Burned</th><th>Net</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderMacroWeek(s) {
    const p = (s.avgP || 0) * 4, c = (s.avgC || 0) * 4, f = (s.avgF || 0) * 9;
    const total = p + c + f || 1;
    const parts = [
      { name: "Protein", g: s.avgP || 0, kcal: p, color: "var(--protein)" },
      { name: "Carbs", g: s.avgC || 0, kcal: c, color: "var(--carbs)" },
      { name: "Fat", g: s.avgF || 0, kcal: f, color: "var(--fat)" },
    ];
    $("#macro-stack").innerHTML = parts.map((x) => `<span style="width:${(x.kcal / total) * 100}%;background:${x.color}"></span>`).join("");
    $("#macro-legend").innerHTML = parts.map((x) =>
      `<div><i class="sw" style="background:${x.color}"></i>${x.name}<strong>${fmt(x.g)} g · ${Math.round((x.kcal / total) * 100)}%</strong></div>`).join("");
  }

  function renderInsights(s) {
    const out = [];
    const deficitDays = s.both.filter((r) => r.intake < r.burned).length;
    if (s.both.length) out.push(["⚖️", `You were in a deficit on <strong>${deficitDays} of ${s.both.length}</strong> days with full data.`]);
    if (s.logged.length) {
      const top = s.logged.reduce((a, r) => (r.intake > a.intake ? r : a));
      out.push(["🍰", `Biggest eating day: <strong>${esc(dayName(top.key))}</strong> at ${fmt(top.intake)} kcal.`]);
      const onGoal = s.logged.filter((r) => Math.abs(r.intake - state.profile.goal) <= state.profile.goal * 0.1).length;
      out.push(["🎯", `Within 10% of your ${fmt(state.profile.goal)} kcal goal on <strong>${onGoal}</strong> day${onGoal === 1 ? "" : "s"}.`]);
    }
    if (s.avgP != null && state.profile.proteinGoal) {
      const pct = Math.round((s.avgP / state.profile.proteinGoal) * 100);
      out.push(["💪", pct >= 100 ? `Protein crushed: averaging <strong>${fmt(s.avgP)} g</strong> a day (${pct}% of goal).` : `Protein averages <strong>${fmt(s.avgP)} g</strong>, ${pct}% of your ${state.profile.proteinGoal} g goal.`]);
    }
    const missingBurn = s.logged.filter((r) => r.burned == null).length;
    if (missingBurn) out.push(["⌚", `${missingBurn} logged day${missingBurn === 1 ? " is" : "s are"} missing calories burned. Add them for a truer balance.`]);
    out.push(["🔥", `Current streak: <strong>${currentStreak()}</strong> day${currentStreak() === 1 ? "" : "s"} · best ever: ${bestStreak()}.`]);
    $("#insights").innerHTML = out.map(([e, t]) => `<li><span aria-hidden="true">${e}</span><span>${t}</span></li>`).join("");
  }

  // ---------- Badges ----------
  const BADGES = [
    { id: "first", emoji: "🍽️", name: "First Bite", desc: "Log your first meal", test: () => totalMeals() >= 1 },
    { id: "three", emoji: "🎩", name: "Hat Trick", desc: "Log 3 meals in one day", test: () => anyDay((k) => day(k).meals.length >= 3) },
    { id: "burn", emoji: "⌚", name: "Burn Notice", desc: "Log calories burned", test: () => anyDay((k) => day(k).burned != null) },
    { id: "deficit", emoji: "📉", name: "In the Red", desc: "Finish a day in a calorie deficit", test: () => anyDay((k) => hasMeals(k) && day(k).burned != null && dayTotals(k).calories < day(k).burned) },
    { id: "goal", emoji: "🎯", name: "Bullseye", desc: "Land within 5% of your calorie goal", test: () => anyDay((k) => hasMeals(k) && k !== todayKey() && Math.abs(dayTotals(k).calories - state.profile.goal) <= state.profile.goal * 0.05) },
    { id: "protein", emoji: "💪", name: "Protein Pro", desc: "Hit your daily protein goal", test: () => anyDay((k) => state.profile.proteinGoal > 0 && dayTotals(k).protein_g >= state.profile.proteinGoal) },
    { id: "fav", emoji: "⭐", name: "Creature of Habit", desc: "Save a favorite meal", test: () => state.favorites.length > 0 },
    { id: "streak3", emoji: "🔥", name: "On Fire", desc: "Log meals 3 days in a row", test: () => bestStreak() >= 3 },
    { id: "streak7", emoji: "🗓️", name: "Week Warrior", desc: "Log meals 7 days in a row", test: () => bestStreak() >= 7 },
    { id: "meals25", emoji: "📒", name: "Dedicated Logger", desc: "Log 25 meals", test: () => totalMeals() >= 25 },
    { id: "meals100", emoji: "🏅", name: "Centurion", desc: "Log 100 meals", test: () => totalMeals() >= 100 },
    { id: "week", emoji: "🏆", name: "Balanced Week", desc: "7-day average in a deficit with 5+ full days", test: () => { const s = weekStats(); return s.both.length >= 5 && s.avgNet < 0; } },
  ];
  const totalMeals = () => Object.values(state.days).reduce((a, d) => a + d.meals.length, 0);
  const anyDay = (f) => Object.keys(state.days).some(f);

  function checkBadges(silent) {
    const fresh = [];
    for (const b of BADGES) {
      if (!state.badges[b.id] && b.test()) {
        state.badges[b.id] = Date.now();
        fresh.push(b);
      }
    }
    if (fresh.length) {
      save();
      if (!silent) {
        confetti();
        fresh.forEach((b) => toast(`${b.emoji} Badge unlocked: ${b.name}!`, { label: "View", run: () => showTab("badges") }));
      }
      renderBadges();
    }
  }

  function renderBadges() {
    const got = BADGES.filter((b) => state.badges[b.id]).length;
    $("#badge-progress").textContent = `${got} of ${BADGES.length} unlocked`;
    $("#badge-grid").innerHTML = BADGES.map((b) => {
      const at = state.badges[b.id];
      return `<div class="badge ${at ? "unlocked" : "locked"}">
        <span class="badge-emoji" aria-hidden="true">${b.emoji}</span>
        <span class="badge-name">${b.name}</span>
        <span class="badge-desc">${b.desc}</span>
        ${at ? `<span class="badge-date">✓ ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>` : `<span class="badge-desc">🔒 Locked</span>`}
      </div>`;
    }).join("");
  }

  // ---------- Settings & data ----------
  function fillSettings() {
    const p = state.profile;
    $("#s-name").value = p.name || "";
    $("#s-goal").value = p.goal || 2000;
    $("#s-protein").value = p.proteinGoal ?? 100;
    $$('input[name="units"]').forEach((r) => (r.checked = r.value === p.units));
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `plateful-backup-${todayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("Backup downloaded");
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const s = JSON.parse(reader.result);
        if (!s || typeof s !== "object" || typeof s.days !== "object") throw new Error("bad");
        const d = defaultState();
        state = { ...d, ...s, profile: { ...d.profile, ...(s.profile || {}), onboarded: true } };
        save();
        renderAll();
        fillSettings();
        toast("Backup restored ✅");
      } catch (e) {
        toast("That file doesn't look like a Plateful backup.");
      }
    };
    reader.readAsText(file);
  }

  // A realistic past week so new visitors can see every feature.
  function loadSample() {
    const t = todayKey();
    const M = (text, type, items) => ({ id: uid(), type, text, time: Date.now(), items, totals: totalsOf(items), notes: "", manual: false });
    const I = (name, quantity, emoji, calories, protein_g, carbs_g, fat_g) => ({ name, quantity, emoji, calories, protein_g, carbs_g, fat_g });
    const breakfasts = [
      () => M("2 scrambled eggs, 1 slice sourdough with butter, black coffee", "breakfast", [I("Scrambled eggs", "2 large", "🍳", 182, 12.6, 1.6, 13.4), I("Sourdough toast", "1 slice", "🍞", 120, 4.5, 23, 0.8), I("Butter", "1 tsp", "🧈", 34, 0, 0, 3.8), I("Black coffee", "12 oz", "☕", 2, 0.3, 0, 0)]),
      () => M("Greek yogurt with granola and blueberries", "breakfast", [I("Greek yogurt, plain 2%", "1 cup", "🥛", 190, 20, 9, 5), I("Granola", "1/3 cup", "🥣", 160, 4, 26, 5), I("Blueberries", "1/2 cup", "🫐", 42, 0.5, 10.7, 0.2)]),
      () => M("Large oat milk latte and a croissant", "breakfast", [I("Oat milk latte", "16 oz", "☕", 190, 4, 27, 7), I("Butter croissant", "1 medium", "🥐", 272, 5.5, 31, 14)]),
    ];
    const lunches = [
      () => M("Chipotle chicken burrito bowl, no sour cream", "lunch", [I("Cilantro-lime rice", "4 oz", "🍚", 210, 4, 40, 4), I("Chicken", "4 oz", "🍗", 180, 32, 0, 7), I("Black beans", "4 oz", "🫘", 130, 8, 22, 1.5), I("Fajita veggies", "2 oz", "🫑", 20, 1, 5, 0), I("Cheese", "1 oz", "🧀", 110, 6, 1, 8), I("Tomato salsa", "4 oz", "🍅", 25, 0, 4, 0)]),
      () => M("Turkey sandwich on wheat and an apple", "lunch", [I("Turkey sandwich", "1 sandwich", "🥪", 380, 26, 40, 12), I("Apple", "1 medium", "🍎", 95, 0.5, 25, 0.3)]),
      () => M("Caesar salad with grilled chicken", "lunch", [I("Caesar salad with dressing", "2 cups", "🥗", 330, 7, 12, 28), I("Grilled chicken breast", "4 oz", "🍗", 187, 35, 0, 4)]),
    ];
    const dinners = [
      () => M("Salmon fillet, 1 cup brown rice, steamed broccoli", "dinner", [I("Baked salmon", "6 oz", "🐟", 350, 38, 0, 21), I("Brown rice", "1 cup", "🍚", 216, 5, 45, 1.8), I("Steamed broccoli", "1 cup", "🥦", 55, 3.7, 11, 0.6)]),
      () => M("2 slices pepperoni pizza and a side salad", "dinner", [I("Pepperoni pizza", "2 slices", "🍕", 620, 26, 68, 26), I("Side salad with vinaigrette", "1 bowl", "🥗", 120, 2, 8, 9)]),
      () => M("1.5 cups spaghetti bolognese with parmesan", "dinner", [I("Spaghetti bolognese", "1.5 cups", "🍝", 560, 28, 66, 19), I("Parmesan", "2 tbsp", "🧀", 42, 3.8, 0.4, 2.8)]),
    ];
    const snacks = [
      () => M("Banana with 2 tbsp peanut butter", "snack", [I("Banana", "1 medium", "🍌", 105, 1.3, 27, 0.4), I("Peanut butter", "2 tbsp", "🥜", 190, 7, 7, 16)]),
      () => M("Protein bar", "snack", [I("Protein bar", "1 bar", "🍫", 210, 20, 23, 7)]),
    ];
    const burnedVals = [2380, 2150, 2620, 2290, 2510, 2200];
    for (let i = 6; i >= 1; i--) {
      const k = addDays(t, -i);
      const d = { meals: [], burned: burnedVals[i - 1] };
      d.meals.push(breakfasts[i % 3](), lunches[(i + 1) % 3](), dinners[(i + 2) % 3]());
      if (i % 2 === 0) d.meals.push(snacks[(i / 2) % 2]());
      state.days[k] = d;
    }
    state.profile.onboarded = true;
    save();
    checkBadges(true);
    renderAll();
    toast("Sample week loaded. Try “Same breakfast as yesterday”! 🎉");
  }

  // ---------- Render ----------
  function renderAll() {
    renderGreeting();
    renderDateNav();
    renderSummary();
    renderComposer();
    renderMeals();
    renderBurned();
    if (!$("#view-trends").hidden) renderTrends();
    if (!$("#view-badges").hidden) renderBadges();
  }

  // ---------- Events ----------
  function bind() {
    $$("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
    $("#streak-chip").addEventListener("click", () => showTab("badges"));

    $("#day-prev").addEventListener("click", () => { viewDate = addDays(viewDate, -1); hidePreview(); renderAll(); });
    $("#day-next").addEventListener("click", () => { if (viewDate < todayKey()) { viewDate = addDays(viewDate, 1); hidePreview(); renderAll(); } });
    $("#day-today").addEventListener("click", () => { viewDate = todayKey(); hidePreview(); renderAll(); });

    $$("[data-meal]").forEach((b) => b.addEventListener("click", () => { selectedMeal = b.dataset.meal; renderComposer(); }));

    const ex = $("#example-chips");
    EXAMPLES.slice().sort(() => Math.random() - 0.5).slice(0, 4).forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = t;
      b.addEventListener("click", () => {
        $("#meal-text").value = t.replace(/^\S+\s/, "");
        updateCharCount();
        $("#meal-text").focus();
      });
      ex.appendChild(b);
    });

    $("#meal-text").addEventListener("input", updateCharCount);
    $("#meal-text").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#meal-form").requestSubmit();
    });
    $("#meal-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = $("#meal-text").value.trim();
      if (!text) { showError("Tell me what you ate first, e.g. “a bowl of oatmeal with honey”."); return; }
      analyze(text);
    });
    $("#preview-items").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove]");
      if (!btn || !pending) return;
      pending.items.splice(Number(btn.dataset.remove), 1);
      if (!pending.items.length) hidePreview(); else renderPreview();
    });
    $("#preview-save").addEventListener("click", savePreview);
    $("#preview-discard").addEventListener("click", hidePreview);

    // Manual entry
    const manual = $("#manual");
    $("#manual-open").addEventListener("click", () => {
      $("#manual-form").reset();
      $("#mf-name").value = $("#meal-text").value.trim().slice(0, 80);
      manual.showModal();
    });
    $("#manual-cancel").addEventListener("click", () => manual.close());
    $("#manual-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("#mf-name").value.trim();
      const cal = Number($("#mf-cal").value);
      if (!name || !Number.isFinite(cal)) return;
      const item = { name, quantity: "", emoji: "✍️", calories: Math.round(cal), protein_g: Number($("#mf-p").value) || 0, carbs_g: Number($("#mf-c").value) || 0, fat_g: Number($("#mf-f").value) || 0 };
      manual.close();
      hidePreview();
      $("#meal-text").value = "";
      updateCharCount();
      addMeals([{ id: uid(), type: selectedMeal, text: name, time: Date.now(), items: [item], totals: totalsOf([item]), notes: "", manual: true }]);
    });

    // Burned
    $("#burned-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $("#burned-input").value;
      if (v === "") return;
      setBurned(Number(v));
      $("#burned-input").blur();
      toast(`⌚ ${fmt(Number(v))} kcal burned saved`);
    });
    $$("[data-burn-add]").forEach((b) => b.addEventListener("click", () => {
      setBurned((day(viewDate).burned || 0) + Number(b.dataset.burnAdd));
    }));
    $("#burn-copy").addEventListener("click", () => setBurned(day(addDays(viewDate, -1)).burned));
    $("#burn-clear").addEventListener("click", () => setBurned(null));

    // Trends
    $("#chart-table-toggle").addEventListener("click", (e) => {
      const t = $("#chart-table");
      t.hidden = !t.hidden;
      e.currentTarget.textContent = t.hidden ? "Show table" : "Hide table";
      e.currentTarget.setAttribute("aria-pressed", String(!t.hidden));
    });
    let rz;
    window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(renderChart, 120); });
    if (window.ResizeObserver) new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(renderChart, 120); }).observe($("#chart"));

    // Settings
    $("#settings-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const p = state.profile;
      p.name = $("#s-name").value.trim();
      p.goal = clamp(Number($("#s-goal").value) || 2000, 800, 6000);
      p.proteinGoal = clamp(Number($("#s-protein").value) || 0, 0, 400);
      p.units = ($('input[name="units"]:checked') || {}).value || "lb";
      save();
      renderAll();
      fillSettings();
      checkBadges();
      toast("Settings saved ✅");
    });
    $("#export-btn").addEventListener("click", exportData);
    $("#import-input").addEventListener("change", (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ""; });
    $("#reset-btn").addEventListener("click", () => {
      if (!confirm("Erase all meals, settings and badges from this browser? Export a backup first if you want to keep them.")) return;
      state = defaultState();
      save();
      viewDate = todayKey();
      renderAll();
      showTab("today");
      openOnboarding();
    });
    $$('[data-action="sample"]').forEach((b) => b.addEventListener("click", () => {
      const hasData = Object.values(state.days).some((d) => d.meals.length || d.burned != null);
      if (hasData && !confirm("Loading the sample week replaces the last 6 days of your log. Continue?")) return;
      loadSample();
      showTab("trends");
    }));

    // Onboarding
    $$("#ob-goal-chips [data-goal]").forEach((b) => b.addEventListener("click", () => {
      $("#ob-goal").value = b.dataset.goal;
      $$("#ob-goal-chips .chip").forEach((c) => c.classList.toggle("active", c === b));
    }));
    $("#onboarding-form").addEventListener("submit", () => finishOnboarding());
    $("#ob-sample").addEventListener("click", () => { finishOnboarding(); $("#onboarding").close(); loadSample(); });
    $("#onboarding").addEventListener("cancel", () => finishOnboarding());
  }

  function openOnboarding() {
    const d = $("#onboarding");
    $("#ob-name").value = state.profile.name || "";
    $("#ob-title").textContent = state.profile.name ? `Welcome, ${state.profile.name}! 👋` : "Welcome to Plateful";
    $("#ob-goal").value = state.profile.goal || 2000;
    if (typeof d.showModal === "function") d.showModal();
  }
  function finishOnboarding() {
    state.profile.name = $("#ob-name").value.trim();
    state.profile.goal = clamp(Number($("#ob-goal").value) || 2000, 800, 6000);
    state.profile.onboarded = true;
    save();
    renderAll();
    setTimeout(() => $("#meal-text").focus({ preventScroll: true }), 50);
  }

  // ---------- Init ----------
  initTheme();
  bind();
  renderAll();
  renderBadges();
  const hash = location.hash.slice(1);
  if (["today", "trends", "badges", "settings"].includes(hash)) showTab(hash);
  if (!state.profile.onboarded) openOnboarding();

  // Roll over to a new day if the tab stays open past midnight.
  let lastToday = todayKey();
  setInterval(() => {
    const t = todayKey();
    if (t !== lastToday) {
      if (viewDate === lastToday) viewDate = t;
      lastToday = t;
      renderAll();
    }
  }, 60000);
})();
