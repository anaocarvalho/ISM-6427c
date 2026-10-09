/* Plateful: AI calorie tracker.
 * All data lives in localStorage. Meal and recipe text is sent to /api/analyze-meal
 * (a Netlify Function that calls the Claude API) and comes back as JSON.
 * UI text lives in i18n.js (English and Brazilian Portuguese). */
(function () {
  "use strict";

  // ---------- Constants ----------
  const STORE_KEY = "plateful.v1";
  const THEME_KEY = "plateful.theme";
  const API_URL = "/api/analyze-meal";
  // Bump when the AI parsing improves so older cached results aren't reused.
  const PARSER_VERSION = 2;
  const MEAL_EMOJI = { breakfast: "🌅", lunch: "🥪", dinner: "🍝", snack: "🍎" };
  const MEAL_ORDER = ["breakfast", "lunch", "dinner", "snack"];
  const DICT = window.PLATEFUL_I18N;

  // ---------- Helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const deaccent = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
  const norm = (s) => deaccent(String(s).toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim();
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Language ----------
  let LANG = "en";
  const LOC = () => (LANG === "pt" ? "pt-BR" : "en-US");
  const fmt = (n) => Math.round(n).toLocaleString(LOC());
  const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString(LOC());
  function t(key, vars) {
    let s = DICT[LANG][key];
    if (s === undefined) s = DICT.en[key];
    if (s === undefined) return key;
    if (typeof s === "string" && vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
    return s;
  }
  const tn = (key, n, vars = {}) => t(key + (n === 1 ? "_one" : "_other"), { n: fmt(n), ...vars });
  const mealName = (type) => t("meal." + type);
  const mealLower = (type) => t("mealLower." + type);

  // Plural of a portion word ("slice" → "slices", "fatia" → "fatias", "porção" → "porções").
  function plural(label, n, lang = LANG) {
    if ((n > 0 && n <= 1) || !label) return label;
    if (lang === "pt") {
      if (/ão$/.test(label)) return label.replace(/ão$/, "ões");
      if (/m$/.test(label)) return label.replace(/m$/, "ns");
      if (/[rz]$/.test(label)) return label + "es";
      if (/al$/.test(label)) return label.replace(/al$/, "ais");
      if (/el$/.test(label)) return label.replace(/el$/, "éis");
      if (/ol$/.test(label)) return label.replace(/ol$/, "óis");
      if (/s$/.test(label)) return label;
      return label + "s";
    }
    if (/(s|x|ch|sh)$/.test(label)) return label + "es";
    if (/[^aeiou]y$/.test(label)) return label.slice(0, -1) + "ies";
    return label + "s";
  }

  function applyStaticText() {
    document.documentElement.lang = LANG === "pt" ? "pt-BR" : "en";
    document.title = t("meta.title");
    $$("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    $$("[data-i18n-html]").forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml)));
    $$("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    $$("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
    $$("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
    $$("[data-lang-opt]").forEach((el) => el.classList.toggle("on", el.dataset.langOpt === LANG));
    $$("[data-ob-lang]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.obLang === LANG)));
    $("#label-options").innerHTML = t("labelOptions").map((o) => `<option value="${esc(o)}">`).join("");
    $("#chart-table-toggle").textContent = $("#chart-table").hidden ? t("tr.showTable") : t("tr.hideTable");
    renderExamples();
  }

  function setLang(lang, { persist = true } = {}) {
    LANG = lang === "pt" ? "pt" : "en";
    if (persist) { state.profile.lang = LANG; save(); }
    applyStaticText();
    renderAll();
    renderBadges();
    renderRecipes();
    if (!$("#view-settings").hidden) fillSettings();
    if ($("#onboarding").open) updateOnboardingTitle();
  }

  // Count a number up/down to its new value.
  function animateNumber(el, to) {
    const from = Number(el.dataset.n || 0);
    el.dataset.n = to;
    if (reduceMotion() || from === to) { el.textContent = fmt(to); return; }
    const start = performance.now();
    const dur = 650;
    cancelAnimationFrame(el._raf);
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }

  const pad = (n) => String(n).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return dateKey(d); };
  const todayKey = () => dateKey(new Date());
  const fmtDate = (k, opts) => parseKey(k).toLocaleDateString(LOC(), opts);
  const dayName = (k) => fmtDate(k, { weekday: "long" });
  // "yesterday" / "on Monday" (en), "ontem" / "segunda-feira" (pt), relative to today.
  function whenText(k, base = todayKey()) {
    if (k === base) return t("when.today");
    if (k === addDays(base, -1)) return t("when.yesterday");
    return t("when.day", { day: dayName(k) });
  }

  // ---------- State ----------
  const detectLang = () => ((navigator.language || "").toLowerCase().startsWith("pt") ? "pt" : "en");
  const defaultState = () => ({
    profile: { name: "Ana Cecília", goal: 2000, proteinGoal: 100, units: "lb", onboarded: false, lang: null },
    days: {},
    favorites: [],
    recipes: [],
    badges: {},
  });

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);
      const d = defaultState();
      const merged = { ...d, ...s, profile: { ...d.profile, ...(s.profile || {}) } };
      if (!Array.isArray(merged.recipes)) merged.recipes = [];
      if (!Array.isArray(merged.favorites)) merged.favorites = [];
      return merged;
    } catch (e) {
      return defaultState();
    }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage full or blocked */ }
  }

  let state = load();
  LANG = state.profile.lang || detectLang();
  let viewDate = todayKey();
  let selectedMeal = guessMealType();
  let pending = null; // the just-logged meal whose breakdown is on screen
  let loadingTimer = null;

  const day = (k) => state.days[k] || { meals: [], burned: null };
  function ensureDay(k) {
    if (!state.days[k]) state.days[k] = { meals: [], burned: null };
    return state.days[k];
  }
  function dayTotals(k) {
    const tot = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    for (const m of day(k).meals) for (const key in tot) tot[key] += m.totals[key] || 0;
    return tot;
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
    let th = "system";
    try { th = localStorage.getItem(THEME_KEY) || "system"; } catch (e) {}
    applyTheme(th);
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
    if (name === "recipes") renderRecipes();
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
    if (reduceMotion()) return;
    const root = $("#confetti");
    const colors = ["#ff7a45", "#e2366f", "#a43ad6", "#1baf7a", "#eda100", "#2a78d6"];
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

  // Previously analyzed text (in the current language) → reuse its result instead of calling the AI.
  function findRemembered(text) {
    const n = norm(text);
    for (const k of Object.keys(state.days).sort().reverse()) {
      const hit = day(k).meals.find((m) => norm(m.text) === n && !m.manual && !m.recipeId &&
        (m.v || 0) >= PARSER_VERSION && (m.lang || "en") === LANG);
      if (hit) return { meal: hit, key: k };
    }
    return null;
  }

  function cloneMeal(m, type) {
    return {
      id: uid(),
      v: m.v,
      lang: m.lang,
      type: type || m.type,
      text: m.text,
      time: Date.now(),
      items: m.items.map((it) => ({ ...it })),
      totals: { ...m.totals },
      notes: m.notes || "",
      manual: !!m.manual,
      recipeId: m.recipeId,
    };
  }

  function addMeals(meals, k = viewDate, msg) {
    const d = ensureDay(k);
    d.meals.push(...meals);
    save();
    renderAll();
    const ids = meals.map((m) => m.id);
    toast(msg || t("toast.logged", { n: fmt(meals.reduce((a, m) => a + m.totals.calories, 0)) }), {
      label: t("toast.undo"),
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
    const part = h < 5 ? t("greet.late") : h < 12 ? t("greet.morning") : h < 17 ? t("greet.afternoon") : t("greet.evening");
    const name = state.profile.name;
    $("#greeting").textContent = name ? `${part}, ${name} 👋` : `${part} 👋`;
    const tot = dayTotals(todayKey());
    const left = state.profile.goal - tot.calories;
    let sub = t("greet.sub");
    if (tot.calories > 0 && left > 0) sub = t("greet.toGo", { n: fmt(left) });
    else if (tot.calories > 0 && left <= 0) sub = t("greet.done");
    $("#greeting-sub").textContent = sub;

    $("#hero").dataset.tod = h < 5 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
    $("#hero-kicker").textContent = new Date().toLocaleDateString(LOC(), { weekday: "long", month: "long", day: "numeric" });

    const s = currentStreak();
    $("#streak-text").textContent = tn("streak", s);
    $("#streak-chip").classList.toggle("hot", s >= 3);
  }

  function renderDateNav() {
    const today = todayKey();
    const isToday = viewDate === today;
    $("#day-label").textContent = isToday ? t("day.today") : viewDate === addDays(today, -1) ? t("day.yesterday") : cap(dayName(viewDate));
    $("#day-sub").textContent = fmtDate(viewDate, { month: "long", day: "numeric", year: "numeric" });
    $("#day-next").disabled = isToday;
    $("#day-today").hidden = isToday;
  }

  function renderSummary() {
    const tot = dayTotals(viewDate);
    const goal = state.profile.goal || 2000;
    const burned = day(viewDate).burned;
    const pct = clamp((tot.calories / goal) * 100, 0, 100);
    const fill = $("#ring-fill");
    fill.setAttribute("stroke-dasharray", `${pct} 100`);
    fill.classList.toggle("over", tot.calories > goal);
    const left = goal - tot.calories;
    animateNumber($("#ring-eaten"), tot.calories);
    animateNumber($("#hs-eaten"), tot.calories);
    $("#hs-left-label").textContent = left >= 0 ? t("hs.left") : t("hs.over");
    animateNumber($("#hs-left"), Math.abs(left));
    if (burned != null) animateNumber($("#hs-burned"), burned);
    else { $("#hs-burned").textContent = "—"; $("#hs-burned").dataset.n = 0; }
    $("#ring-goal").textContent = fmt(goal);
    $("#ring-left").textContent = left >= 0 ? t("sum.left", { n: fmt(left) }) : t("sum.over", { n: fmt(-left) });

    $("#sum-eaten").textContent = `${fmt(tot.calories)} kcal`;
    $("#sum-burned").textContent = burned != null ? `${fmt(burned)} kcal` : "—";
    const pill = $("#balance-pill");
    if (burned != null) {
      const net = tot.calories - burned;
      $("#sum-net").textContent = `${net > 0 ? "+" : ""}${fmt(net)} kcal`;
      if (net < 0) { pill.className = "balance-pill deficit"; pill.textContent = t("bal.deficit", { n: fmt(-net) }); }
      else if (net > 0) { pill.className = "balance-pill surplus"; pill.textContent = t("bal.surplus", { n: fmt(net) }); }
      else { pill.className = "balance-pill neutral"; pill.textContent = t("bal.even"); }
    } else {
      $("#sum-net").textContent = "—";
      pill.className = "balance-pill neutral";
      pill.textContent = t("bal.none");
    }

    // Macro targets: protein from settings; carbs/fat from a 50/30 split of the calorie goal.
    const targets = { protein: state.profile.proteinGoal || 100, carbs: (goal * 0.5) / 4, fat: (goal * 0.3) / 9 };
    const vals = { protein: tot.protein_g, carbs: tot.carbs_g, fat: tot.fat_g };
    for (const m of ["protein", "carbs", "fat"]) {
      $(`#m-${m}`).textContent = `${fmt(vals[m])} / ${fmt(targets[m])} g`;
      $(`#mb-${m}`).style.width = clamp((vals[m] / targets[m]) * 100, 0, 100) + "%";
    }
  }

  function renderExamples() {
    const ex = $("#example-chips");
    ex.innerHTML = "";
    t("examples").slice().sort(() => Math.random() - 0.5).slice(0, 4).forEach((text) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = text;
      b.addEventListener("click", () => {
        $("#meal-text").value = text.replace(/^\S+\s/, "");
        updateCharCount();
        $("#meal-text").focus();
      });
      ex.appendChild(b);
    });
  }

  function renderComposer() {
    $$("[data-meal]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.meal === selectedMeal)));

    // "Same as yesterday" for the selected meal type.
    const src = repeatSource(selectedMeal, viewDate);
    const btn = $("#repeat-btn");
    if (src) {
      const kcal = src.meals.reduce((a, m) => a + m.totals.calories, 0);
      $("#repeat-title").textContent = t("repeat.title", { meal: mealLower(selectedMeal), when: whenText(src.key, viewDate) });
      $("#repeat-sub").textContent = src.meals.map((m) => m.text).join(" + ");
      $("#repeat-kcal").textContent = `${fmt(kcal)} kcal`;
      btn.hidden = false;
      btn.onclick = () => {
        addMeals(src.meals.map((m) => cloneMeal(m, selectedMeal)), viewDate,
          t("repeat.logged", { emoji: MEAL_EMOJI[selectedMeal], meal: mealLower(selectedMeal), n: fmt(kcal) }));
      };
    } else {
      btn.hidden = true;
    }

    // One-tap recipes, favorites and recent meals.
    const recent = recentMeals(selectedMeal);
    const qc = $("#quick-chips");
    qc.innerHTML = "";
    for (const r of state.recipes.slice(0, 4)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip recipe-chip";
      b.innerHTML = `${esc(r.emoji)} ${esc(r.name)} · 1 ${esc(r.label)}<span class="chip-kcal">${fmt(r.totals.calories / r.servings)}</span>`;
      b.title = t("quick.recipeTitle", { name: r.name });
      b.addEventListener("click", () => openPortion(r.id));
      qc.appendChild(b);
    }
    for (const m of recent) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (m.fav ? " fav" : "");
      const label = m.text.length > 34 ? m.text.slice(0, 32) + "…" : m.text;
      b.innerHTML = `${esc(label)}<span class="chip-kcal">${fmt(m.totals.calories)}</span>`;
      b.title = t("quick.title", { text: m.text, meal: mealName(selectedMeal) });
      b.addEventListener("click", () => addMeals([cloneMeal(m, selectedMeal)], viewDate, t("quick.logged", { text: label, n: fmt(m.totals.calories) })));
      qc.appendChild(b);
    }
    const anyQuick = recent.length > 0 || state.recipes.length > 0;
    $("#quick-wrap").hidden = !anyQuick;
    $("#memory").hidden = !src && !anyQuick;
  }

  const macroLine = (o, f = fmt1) => `${t("macro.p")} ${f(o.protein_g)}g · ${t("macro.c")} ${f(o.carbs_g)}g · ${t("macro.f")} ${f(o.fat_g)}g`;
  const macroPills = (o) =>
    `<span class="mp mp-p">${t("macro.p")} ${fmt1(o.protein_g)}g</span><span class="mp mp-c">${t("macro.c")} ${fmt1(o.carbs_g)}g</span><span class="mp mp-f">${t("macro.f")} ${fmt1(o.fat_g)}g</span>`;

  function itemRow(it, i, removable) {
    return `<li class="item">
      <span class="item-emoji" aria-hidden="true">${esc(it.emoji || "🍽️")}</span>
      <div><div class="item-name">${esc(it.name)}</div>
        <div class="item-meta">${esc(it.quantity || "")}${it.quantity ? " · " : ""}${macroLine(it)}</div></div>
      <span class="item-kcal">${fmt(it.calories)} kcal</span>
      ${removable ? `<button type="button" class="item-remove" data-remove="${i}" aria-label="${esc(t("item.remove", { name: it.name }))}">×</button>` : "<span></span>"}
    </li>`;
  }

  function renderMeals() {
    const d = day(viewDate);
    const list = $("#meal-list");
    list.innerHTML = "";
    $("#meals-empty").hidden = d.meals.length > 0;
    $("#meals-count").textContent = d.meals.length ? tn("meals.count", d.meals.length, { kcal: fmt(dayTotals(viewDate).calories) }) : "";

    // Offer to copy the whole previous day when this day is empty.
    const prevKey = addDays(viewDate, -1);
    let copyBtn = $("#copy-day-btn");
    if (!d.meals.length && hasMeals(prevKey)) {
      if (!copyBtn) {
        copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.id = "copy-day-btn";
        copyBtn.className = "btn copy-day";
        $("#meals-empty").appendChild(copyBtn);
      }
      const prev = day(prevKey).meals;
      copyBtn.textContent = tn("meals.copyDay", prev.length, { kcal: fmt(dayTotals(prevKey).calories) });
      copyBtn.onclick = () => addMeals(prev.map((m) => cloneMeal(m)), viewDate, t("meals.copied"));
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
      g.innerHTML = `<div class="meal-group-head"><span>${MEAL_EMOJI[type]} ${esc(mealName(type))}</span><span>${fmt(kcal)} kcal</span></div>`;
      for (const m of meals) {
        const isFav = favSet.has(norm(m.text));
        const time = new Date(m.time).toLocaleTimeString(LOC(), { hour: "numeric", minute: "2-digit" });
        const e = document.createElement("div");
        e.className = "entry";
        e.innerHTML = `
          <div class="entry-top">
            <div class="entry-text">
              <div class="entry-title">${esc(m.text)}</div>
              <div class="entry-macros">${time} · ${macroLine(m.totals, fmt)}</div>
            </div>
            <span class="entry-kcal">${fmt(m.totals.calories)} kcal</span>
          </div>
          ${m.items.length > 1 || m.notes ? `<details><summary>${tn("entry.items", m.items.length)}</summary>
            <ul class="items">${m.items.map((it, i) => itemRow(it, i, false)).join("")}</ul>
            ${m.notes ? `<p class="note">${esc(m.notes)}</p>` : ""}</details>` : ""}
          <div class="entry-actions">
            <button type="button" data-act="fav" class="${isFav ? "fav-on" : ""}" aria-pressed="${isFav}">${isFav ? t("entry.favOn") : t("entry.fav")}</button>
            ${viewDate !== todayKey() ? `<button type="button" data-act="today">${t("entry.againToday")}</button>` : `<button type="button" data-act="again">${t("entry.again")}</button>`}
            <button type="button" data-act="delete">${t("entry.delete")}</button>
          </div>`;
        e.querySelector('[data-act="fav"]').addEventListener("click", () => toggleFavorite(m));
        const again = e.querySelector('[data-act="again"], [data-act="today"]');
        again.addEventListener("click", () => {
          const target = again.dataset.act === "today" ? todayKey() : viewDate;
          addMeals([cloneMeal(m)], target, target === viewDate ? t("entry.loggedAgain") : t("entry.addedToday"));
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
      toast(t("fav.removed"));
    } else {
      state.favorites.unshift({ id: uid(), text: m.text, type: m.type, items: m.items, totals: m.totals, notes: m.notes || "", manual: !!m.manual, lang: m.lang, v: m.v, recipeId: m.recipeId });
      toast(t("fav.saved"));
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
    toast(t("meal.deleted"), {
      label: t("toast.undo"),
      run: () => { d.meals.splice(idx, 0, removed); save(); renderAll(); },
    });
  }

  function renderBurned() {
    const b = day(viewDate).burned;
    const input = $("#burned-input");
    if (document.activeElement !== input) input.value = b != null ? b : "";
    const prev = day(addDays(viewDate, -1)).burned;
    $("#burn-copy").hidden = prev == null;
    if (prev != null) $("#burn-copy").textContent = t("burn.same", { n: fmt(prev) });
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
      const msgs = t("loading");
      let i = 0;
      $("#analyzing-msg").textContent = msgs[0];
      loadingTimer = setInterval(() => {
        i = (i + 1) % msgs.length;
        $("#analyzing-msg").textContent = msgs[i];
      }, 1700);
    }
  }
  function showError(msg) {
    const el = $("#composer-error");
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  async function postAI(body) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, lang: LANG }),
        signal: ctrl.signal,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
      if (!res.ok || !data || !Array.isArray(data.items)) {
        let msg = (data && data.error) || (res.status === 404
          ? (body.mode === "recipe" ? t("rec.notDeployed") : t("err.notDeployed"))
          : t("err.generic", { n: res.status }));
        if (data && data.detail) msg += " " + t("err.details", { d: data.detail });
        throw new Error(msg);
      }
      return data;
    } catch (err) {
      if (err.name === "AbortError") throw new Error(t("err.timeout"));
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function analyze(text, { skipMemory = false } = {}) {
    showError("");
    hidePreview();

    // Mentions a saved recipe and nothing else? Do the exact math locally.
    const fromRecipe = skipMemory ? null : matchRecipePortion(text);
    if (fromRecipe) {
      const { recipe, servings } = fromRecipe;
      logAnalysis(text, [portionItem(recipe, servings)],
        t("prev.fromRecipe", { portion: describePortion(recipe, servings), frac: fmtFraction(servings / recipe.servings) }), false, recipe.id);
      return;
    }

    // Already analyzed this exact meal before? Reuse it instantly.
    const remembered = skipMemory ? null : findRemembered(text);
    if (remembered) {
      logAnalysis(text, remembered.meal.items.map((it) => ({ ...it })), t("prev.remembered", { when: whenText(remembered.key) }), true);
      return;
    }

    showLoading(true);
    try {
      const data = await postAI({ text, recipes: recipeContext() });
      logAnalysis(text, data.items, data.notes, false);
    } catch (err) {
      showError(err.message);
    } finally {
      showLoading(false);
    }
  }

  function totalsOf(items) {
    const tot = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    for (const it of items) for (const k in tot) tot[k] += Number(it[k]) || 0;
    tot.calories = Math.round(tot.calories);
    for (const k of ["protein_g", "carbs_g", "fat_g"]) tot[k] = Math.round(tot[k] * 10) / 10;
    return tot;
  }

  // Save the analyzed meal straight to the log, then show its breakdown with
  // the option to remove items, undo, or re-analyze.
  function logAnalysis(text, items, notes, remembered, recipeId) {
    const meal = {
      id: uid(),
      v: PARSER_VERSION,
      lang: LANG,
      type: selectedMeal,
      text,
      time: Date.now(),
      items,
      totals: totalsOf(items),
      notes: notes || "",
      manual: false,
      recipeId,
    };
    const k = viewDate;
    ensureDay(k).meals.push(meal);
    save();
    $("#meal-text").value = "";
    updateCharCount();
    pending = { mealId: meal.id, dayKey: k, text, remembered };
    renderAll();
    renderPreview();
    $("#preview").hidden = false;
    $("#preview").scrollIntoView({ behavior: "smooth", block: "nearest" });
    toast(tn("toast.mealLogged", items.length, { emoji: MEAL_EMOJI[meal.type], meal: mealName(meal.type), kcal: fmt(meal.totals.calories) }));
    checkBadges();
  }

  function pendingMeal() {
    if (!pending) return null;
    return day(pending.dayKey).meals.find((m) => m.id === pending.mealId) || null;
  }
  function renderPreview() {
    const m = pendingMeal();
    if (!m) { hidePreview(); return; }
    $("#preview-title").textContent = tn("prev.logged", m.items.length, { meal: mealName(m.type) });
    $("#preview-total").textContent = `${fmt(m.totals.calories)} kcal`;
    $("#preview-items").innerHTML = m.items.map((it, i) => itemRow(it, i, m.items.length > 1)).join("");
    $("#preview-note").hidden = !m.notes;
    $("#preview-note").textContent = m.notes || "";
    $("#preview-reanalyze").hidden = !pending.remembered;
  }
  function hidePreview() {
    pending = null;
    $("#preview").hidden = true;
  }
  function removePendingItem(i) {
    const m = pendingMeal();
    if (!m) return;
    m.items.splice(i, 1);
    m.totals = totalsOf(m.items);
    if (!m.items.length) { undoPending(); return; }
    save();
    renderAll();
    renderPreview();
  }
  function undoPending() {
    if (!pending) return;
    const d = ensureDay(pending.dayKey);
    const m = pendingMeal();
    d.meals = d.meals.filter((x) => x.id !== pending.mealId);
    save();
    if (m) { $("#meal-text").value = m.text; updateCharCount(); }
    hidePreview();
    renderAll();
    toast(t("toast.removed"));
  }

  function updateCharCount() {
    $("#char-count").textContent = `${$("#meal-text").value.length} / 2000`;
  }

  // ---------- Trends ----------
  function lastNDays(n, endKey = todayKey()) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(addDays(endKey, -i));
    return out;
  }

  function weekStats() {
    const rows = lastNDays(7).map((k) => {
      const tot = dayTotals(k);
      return { key: k, intake: tot.calories, burned: day(k).burned, logged: hasMeals(k), ...tot };
    });
    const logged = rows.filter((r) => r.logged);
    const withBurn = rows.filter((r) => r.burned != null);
    const both = rows.filter((r) => r.logged && r.burned != null);
    const avg = (arr, f) => (arr.length ? arr.reduce((a, r) => a + f(r), 0) / arr.length : null);
    return {
      rows, logged, withBurn, both,
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
    $("#trend-range").textContent = `${fmtDate(keys[0], { month: "short", day: "numeric" })} – ${fmtDate(keys[6], { month: "short", day: "numeric" })}`;

    const empty = !s.logged.length && !s.withBurn.length;
    $("#trends-empty").hidden = !empty;
    $$(".tiles, .chart-card, #view-trends .grid-2").forEach((el) => (el.hidden = empty));
    if (empty) return;

    $("#t-intake").textContent = s.avgIntake != null ? fmt(s.avgIntake) : "—";
    $("#t-intake-sub").textContent = t("tr.intakeSub", { n: s.logged.length });
    $("#t-burned").textContent = s.avgBurned != null ? fmt(s.avgBurned) : "—";
    $("#t-burned-sub").textContent = t("tr.burnedSub", { n: s.withBurn.length });

    const tile = $("#t-balance-tile");
    tile.classList.remove("deficit", "surplus");
    if (s.avgNet != null) {
      const net = s.avgNet;
      $("#t-balance").textContent = `${net > 0 ? "+" : net < 0 ? "−" : ""}${fmt(Math.abs(net))}`;
      if (net < 0) { tile.classList.add("deficit"); $("#t-balance-sub").textContent = t("tr.deficit"); }
      else if (net > 0) { tile.classList.add("surplus"); $("#t-balance-sub").textContent = t("tr.surplus"); }
      else $("#t-balance-sub").textContent = t("tr.balanced");
      const perUnit = state.profile.units === "kg" ? 7700 : 3500;
      const change = (net * 7) / perUnit;
      $("#t-weight").textContent = `${change > 0 ? "+" : change < 0 ? "−" : ""}${Math.abs(change).toLocaleString(LOC(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${state.profile.units}`;
    } else {
      $("#t-balance").textContent = "—";
      $("#t-balance-sub").textContent = t("tr.needsBoth");
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

    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("tr.chartLabel"))}">`;
    svg += `<g class="grid">`;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (maxV / ticks) * i;
      svg += `<line x1="${m.left}" x2="${W - m.right}" y1="${y(v)}" y2="${y(v)}" />`;
    }
    svg += `</g><g class="axis">`;
    for (let i = 0; i <= ticks; i++) {
      const v = (maxV / ticks) * i;
      const label = v >= 1000 ? (v / 1000).toLocaleString(LOC(), { maximumFractionDigits: 1 }) + "k" : v;
      svg += `<text x="${m.left - 8}" y="${y(v) + 4}" text-anchor="end">${label}</text>`;
    }
    s.rows.forEach((r, i) => {
      const cx = m.left + gw * i + gw / 2;
      const label = fmtDate(r.key, { weekday: narrow ? "narrow" : "short" }).replace(".", "");
      svg += `<text class="day-label${r.key === today ? " today" : ""}" x="${cx}" y="${H - 10}" text-anchor="middle">${esc(label)}</text>`;
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
      const lbl = t("tr.hitLabel", { day: dayName(r.key), i: fmt(r.intake), b: r.burned != null ? fmt(r.burned) : t("tr.notLogged") });
      svg += `<rect class="hit" data-i="${i}" x="${m.left + gw * i}" y="${m.top}" width="${gw}" height="${ih}" rx="6" tabindex="0" aria-label="${esc(lbl)}" />`;
    });
    svg += `</svg>`;
    host.innerHTML = svg;

    const tip = $("#chart-tooltip");
    const card = host.closest(".chart-card");
    const show = (el) => {
      $$(".hit", host).forEach((h) => h.classList.toggle("active", h === el));
      const r = s.rows[Number(el.dataset.i)];
      const net = r.burned != null && r.logged ? r.intake - r.burned : null;
      tip.innerHTML = `<strong>${esc(cap(fmtDate(r.key, { weekday: "long", month: "short", day: "numeric" })))}</strong>
        <div class="tt-row"><i class="sw sw-intake"></i>${t("tr.intake")}<strong>${fmt(r.intake)}</strong></div>
        <div class="tt-row"><i class="sw sw-burned"></i>${t("tr.burned")}<strong>${r.burned != null ? fmt(r.burned) : "—"}</strong></div>
        <div class="tt-row">${net == null ? t("tr.balanceRow") : net < 0 ? t("tr.deficitRow") : t("tr.surplusRow")}<strong>${net == null ? "—" : fmt(Math.abs(net))}</strong></div>`;
      tip.hidden = false;
      const cr = card.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const tw = tip.offsetWidth;
      tip.style.left = clamp(er.left - cr.left + er.width / 2 - tw / 2, 8, cr.width - tw - 8) + "px";
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
      return `<tr><td>${esc(fmtDate(r.key, { weekday: "short", month: "short", day: "numeric" }))}</td>
        <td>${r.logged ? fmt(r.intake) : "—"}</td><td>${r.burned != null ? fmt(r.burned) : "—"}</td>
        <td>${net == null ? "—" : (net > 0 ? "+" : "") + fmt(net)}</td></tr>`;
    }).join("");
    $("#chart-table").innerHTML = `<table><thead><tr><th>${t("tr.day")}</th><th>${t("tr.intake")}</th><th>${t("tr.burned")}</th><th>${t("tr.net")}</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderMacroWeek(s) {
    const p = (s.avgP || 0) * 4, c = (s.avgC || 0) * 4, f = (s.avgF || 0) * 9;
    const total = p + c + f || 1;
    const parts = [
      { name: t("macro.protein"), g: s.avgP || 0, kcal: p, color: "var(--protein)" },
      { name: t("macro.carbs"), g: s.avgC || 0, kcal: c, color: "var(--carbs)" },
      { name: t("macro.fat"), g: s.avgF || 0, kcal: f, color: "var(--fat)" },
    ];
    $("#macro-stack").innerHTML = parts.map((x) => `<span style="width:${(x.kcal / total) * 100}%;background:${x.color}"></span>`).join("");
    $("#macro-legend").innerHTML = parts.map((x) =>
      `<div><i class="sw" style="background:${x.color}"></i>${x.name}<strong>${fmt(x.g)} g · ${Math.round((x.kcal / total) * 100)}%</strong></div>`).join("");
  }

  function renderInsights(s) {
    const out = [];
    const deficitDays = s.both.filter((r) => r.intake < r.burned).length;
    if (s.both.length) out.push(["⚖️", t("ins.deficit", { a: deficitDays, b: s.both.length })]);
    if (s.logged.length) {
      const top = s.logged.reduce((a, r) => (r.intake > a.intake ? r : a));
      out.push(["🍰", t("ins.top", { day: esc(dayName(top.key)), n: fmt(top.intake) })]);
      const onGoal = s.logged.filter((r) => Math.abs(r.intake - state.profile.goal) <= state.profile.goal * 0.1).length;
      out.push(["🎯", tn("ins.goal", onGoal, { goal: fmt(state.profile.goal) })]);
    }
    if (s.avgP != null && state.profile.proteinGoal) {
      const pct = Math.round((s.avgP / state.profile.proteinGoal) * 100);
      out.push(["💪", pct >= 100 ? t("ins.proteinHit", { n: fmt(s.avgP), pct }) : t("ins.protein", { n: fmt(s.avgP), pct, goal: state.profile.proteinGoal })]);
    }
    const missingBurn = s.logged.filter((r) => r.burned == null).length;
    if (missingBurn) out.push(["⌚", tn("ins.missing", missingBurn)]);
    out.push(["🔥", tn("ins.streak", currentStreak(), { best: bestStreak() })]);
    $("#insights").innerHTML = out.map(([e, txt]) => `<li><span aria-hidden="true">${e}</span><span>${txt}</span></li>`).join("");
  }

  // ---------- Badges ----------
  const BADGES = [
    { id: "first", emoji: "🍽️", test: () => totalMeals() >= 1 },
    { id: "three", emoji: "🎩", test: () => anyDay((k) => day(k).meals.length >= 3) },
    { id: "burn", emoji: "⌚", test: () => anyDay((k) => day(k).burned != null) },
    { id: "deficit", emoji: "📉", test: () => anyDay((k) => hasMeals(k) && day(k).burned != null && dayTotals(k).calories < day(k).burned) },
    { id: "goal", emoji: "🎯", test: () => anyDay((k) => hasMeals(k) && k !== todayKey() && Math.abs(dayTotals(k).calories - state.profile.goal) <= state.profile.goal * 0.05) },
    { id: "protein", emoji: "💪", test: () => anyDay((k) => state.profile.proteinGoal > 0 && dayTotals(k).protein_g >= state.profile.proteinGoal) },
    { id: "fav", emoji: "⭐", test: () => state.favorites.length > 0 },
    { id: "chef", emoji: "👩‍🍳", test: () => state.recipes.length > 0 },
    { id: "streak3", emoji: "🔥", test: () => bestStreak() >= 3 },
    { id: "streak7", emoji: "🗓️", test: () => bestStreak() >= 7 },
    { id: "meals25", emoji: "📒", test: () => totalMeals() >= 25 },
    { id: "meals100", emoji: "🏅", test: () => totalMeals() >= 100 },
    { id: "week", emoji: "🏆", test: () => { const s = weekStats(); return s.both.length >= 5 && s.avgNet < 0; } },
  ];
  const badgeText = (b) => t("badge." + b.id); // [name, description]
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
        fresh.forEach((b) => toast(t("bd.unlocked", { emoji: b.emoji, name: badgeText(b)[0] }), { label: t("bd.view"), run: () => showTab("badges") }));
      }
      renderBadges();
    }
  }

  function renderBadges() {
    const got = BADGES.filter((b) => state.badges[b.id]).length;
    $("#badge-progress").textContent = t("bd.progress", { a: got, b: BADGES.length });
    $("#badge-grid").innerHTML = BADGES.map((b, i) => {
      const at = state.badges[b.id];
      const [name, desc] = badgeText(b);
      return `<div class="badge ${at ? "unlocked" : "locked"}" style="--i:${i}">
        <span class="badge-emoji" aria-hidden="true">${b.emoji}</span>
        <span class="badge-name">${esc(name)}</span>
        <span class="badge-desc">${esc(desc)}</span>
        ${at ? `<span class="badge-date">✓ ${new Date(at).toLocaleDateString(LOC(), { month: "short", day: "numeric" })}</span>` : `<span class="badge-desc">${t("bd.locked")}</span>`}
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
    $$('input[name="lang"]').forEach((r) => (r.checked = r.value === LANG));
  }

  async function testConnection() {
    const out = $("#test-ai-result");
    out.hidden = false;
    out.textContent = t("test.checking");
    try {
      const res = await fetch(API_URL, { method: "GET" });
      const data = await res.json().catch(() => null);
      if (res.status === 404 || !data) out.textContent = t("test.notDeployed");
      else if (!data.hasKey) out.textContent = t("test.noKey");
      else out.textContent = t("test.ok", { model: data.model });
    } catch (e) {
      out.textContent = t("test.offline");
    }
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
    toast(t("set.exported"));
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const s = JSON.parse(reader.result);
        if (!s || typeof s !== "object" || typeof s.days !== "object") throw new Error("bad");
        const d = defaultState();
        state = { ...d, ...s, profile: { ...d.profile, ...(s.profile || {}), onboarded: true } };
        if (!Array.isArray(state.recipes)) state.recipes = [];
        save();
        setLang(state.profile.lang || LANG);
        fillSettings();
        toast(t("set.restored"));
      } catch (e) {
        toast(t("set.badFile"));
      }
    };
    reader.readAsText(file);
  }

  // A realistic past week (in the current language) so new visitors can see every feature.
  function loadSample() {
    const today = todayKey();
    const L = (en, pt) => (LANG === "pt" ? pt : en);
    const M = (text, type, items) => ({ id: uid(), v: PARSER_VERSION, lang: LANG, type, text, time: Date.now(), items, totals: totalsOf(items), notes: "", manual: false });
    const I = (name, quantity, emoji, calories, protein_g, carbs_g, fat_g) => ({ name, quantity, emoji, calories, protein_g, carbs_g, fat_g });
    const breakfasts = [
      () => M(L("2 scrambled eggs, 1 slice sourdough with butter, black coffee", "2 ovos mexidos, 1 fatia de pão de fermentação natural com manteiga, café preto"), "breakfast", [
        I(L("Scrambled eggs", "Ovos mexidos"), L("2 large", "2 grandes"), "🍳", 182, 12.6, 1.6, 13.4),
        I(L("Sourdough toast", "Pão de fermentação natural"), L("1 slice", "1 fatia"), "🍞", 120, 4.5, 23, 0.8),
        I(L("Butter", "Manteiga"), L("1 tsp", "1 colher (chá)"), "🧈", 34, 0, 0, 3.8),
        I(L("Black coffee", "Café preto"), L("12 oz", "350 ml"), "☕", 2, 0.3, 0, 0)]),
      () => M(L("Greek yogurt with granola and blueberries", "Iogurte grego com granola e mirtilos"), "breakfast", [
        I(L("Greek yogurt, plain 2%", "Iogurte grego natural"), L("1 cup", "1 pote (240 g)"), "🥛", 190, 20, 9, 5),
        I("Granola", L("1/3 cup", "1/3 xícara"), "🥣", 160, 4, 26, 5),
        I(L("Blueberries", "Mirtilos"), L("1/2 cup", "1/2 xícara"), "🫐", 42, 0.5, 10.7, 0.2)]),
      () => M(L("Large oat milk latte and a croissant", "Café com leite de aveia grande e um croissant"), "breakfast", [
        I(L("Oat milk latte", "Café com leite de aveia"), L("16 oz", "470 ml"), "☕", 190, 4, 27, 7),
        I(L("Butter croissant", "Croissant de manteiga"), L("1 medium", "1 médio"), "🥐", 272, 5.5, 31, 14)]),
    ];
    const lunches = [
      () => M(L("Chicken burrito bowl with rice and black beans", "Arroz, feijão, frango grelhado e salada"), "lunch", [
        I(L("Cilantro-lime rice", "Arroz branco"), L("4 oz", "4 colheres (sopa)"), "🍚", 210, 4, 40, 4),
        I(L("Grilled chicken", "Frango grelhado"), L("4 oz", "1 filé (115 g)"), "🍗", 180, 32, 0, 7),
        I(L("Black beans", "Feijão"), L("4 oz", "1 concha"), "🫘", 130, 8, 22, 1.5),
        I(L("Side salad", "Salada de folhas e tomate"), L("1 cup", "1 prato de sobremesa"), "🥗", 45, 1.5, 6, 2)]),
      () => M(L("Turkey sandwich on wheat and an apple", "Sanduíche de peru no pão integral e uma maçã"), "lunch", [
        I(L("Turkey sandwich", "Sanduíche de peru"), L("1 sandwich", "1 sanduíche"), "🥪", 380, 26, 40, 12),
        I(L("Apple", "Maçã"), L("1 medium", "1 média"), "🍎", 95, 0.5, 25, 0.3)]),
      () => M(L("Caesar salad with grilled chicken", "Salada Caesar com frango grelhado"), "lunch", [
        I(L("Caesar salad with dressing", "Salada Caesar com molho"), L("2 cups", "1 prato"), "🥗", 330, 7, 12, 28),
        I(L("Grilled chicken breast", "Peito de frango grelhado"), L("4 oz", "115 g"), "🍗", 187, 35, 0, 4)]),
    ];
    const dinners = [
      () => M(L("Salmon fillet, 1 cup brown rice, steamed broccoli", "Filé de salmão, 1 xícara de arroz integral e brócolis no vapor"), "dinner", [
        I(L("Baked salmon", "Salmão assado"), L("6 oz", "170 g"), "🐟", 350, 38, 0, 21),
        I(L("Brown rice", "Arroz integral"), L("1 cup", "1 xícara"), "🍚", 216, 5, 45, 1.8),
        I(L("Steamed broccoli", "Brócolis no vapor"), L("1 cup", "1 xícara"), "🥦", 55, 3.7, 11, 0.6)]),
      () => M(L("2 slices pepperoni pizza and a side salad", "2 fatias de pizza de calabresa e uma salada"), "dinner", [
        I(L("Pepperoni pizza", "Pizza de calabresa"), L("2 slices", "2 fatias"), "🍕", 620, 26, 68, 26),
        I(L("Side salad with vinaigrette", "Salada com vinagrete"), L("1 bowl", "1 tigela"), "🥗", 120, 2, 8, 9)]),
      () => M(L("1.5 cups spaghetti bolognese with parmesan", "1 prato de espaguete à bolonhesa com parmesão"), "dinner", [
        I(L("Spaghetti bolognese", "Espaguete à bolonhesa"), L("1.5 cups", "1 prato fundo"), "🍝", 560, 28, 66, 19),
        I(L("Parmesan", "Parmesão"), L("2 tbsp", "2 colheres (sopa)"), "🧀", 42, 3.8, 0.4, 2.8)]),
    ];
    const snacks = [
      () => M(L("Banana with 2 tbsp peanut butter", "Banana com 2 colheres de pasta de amendoim"), "snack", [
        I("Banana", L("1 medium", "1 média"), "🍌", 105, 1.3, 27, 0.4),
        I(L("Peanut butter", "Pasta de amendoim"), L("2 tbsp", "2 colheres (sopa)"), "🥜", 190, 7, 7, 16)]),
      () => M(L("Protein bar", "Barra de proteína"), "snack", [I(L("Protein bar", "Barra de proteína"), L("1 bar", "1 barra"), "🍫", 210, 20, 23, 7)]),
    ];
    const burnedVals = [2380, 2150, 2620, 2290, 2510, 2200];
    for (let i = 6; i >= 1; i--) {
      const k = addDays(today, -i);
      const d = { meals: [], burned: burnedVals[i - 1] };
      d.meals.push(breakfasts[i % 3](), lunches[(i + 1) % 3](), dinners[(i + 2) % 3]());
      if (i % 2 === 0) d.meals.push(snacks[(i / 2) % 2]());
      state.days[k] = d;
    }
    state.profile.onboarded = true;
    save();
    checkBadges(true);
    renderAll();
    toast(t("set.sampleLoaded"));
  }

  // ---------- Recipes ----------
  let recipeDraft = null;
  let portionState = null;

  const fmtAmount = (n) => (n === 0.5 ? "½" : n === 0.25 ? "¼" : n === 0.75 ? "¾" : n.toLocaleString(LOC(), { maximumFractionDigits: 2 }));
  function gcd(a, b) { return b ? gcd(b, a % b) : a; }
  function fmtFraction(f) {
    for (const d of [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32]) {
      const n = Math.round(f * d);
      if (n > 0 && Math.abs(n / d - f) < 1e-6) {
        const g = gcd(n, d);
        return `${n / g}/${d / g}`;
      }
    }
    return `${(Math.round(f * 1000) / 10).toLocaleString(LOC())}%`;
  }
  const recipeLabel = (r, n) => plural(r.label, n, r.lang || LANG);
  const describePortion = (r, servings) => t("portion.of", { amount: fmtAmount(servings), label: recipeLabel(r, servings), name: r.name });

  function scaleTotals(r, servings) {
    const f = servings / r.servings;
    return {
      calories: Math.round(r.totals.calories * f),
      protein_g: Math.round(r.totals.protein_g * f * 10) / 10,
      carbs_g: Math.round(r.totals.carbs_g * f * 10) / 10,
      fat_g: Math.round(r.totals.fat_g * f * 10) / 10,
    };
  }
  function portionItem(r, servings) {
    return {
      name: r.name,
      quantity: t("portion.qty", { amount: fmtAmount(servings), label: recipeLabel(r, servings), frac: fmtFraction(servings / r.servings) }),
      emoji: r.emoji,
      ...scaleTotals(r, servings),
    };
  }

  // Number words in English and Portuguese (accents already stripped).
  const WORD_NUM = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, half: 0.5, quarter: 0.25,
    um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, meia: 0.5, meio: 0.5, "um quarto": 0.25,
  };
  // Parse "1/16", "1 1/2", "0.5", "1,5", "½", "a", "two", "meia".
  function parseNum(str) {
    if (str == null) return null;
    const s = deaccent(String(str).trim().toLowerCase()).replace("½", "1/2").replace("¼", "1/4").replace("¾", "3/4").replace(/(\d),(\d)/g, "$1.$2");
    if (s in WORD_NUM) return WORD_NUM[s];
    let m = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
    if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
    m = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
    m = s.match(/^\d+(?:\.\d+)?$/);
    return m ? Number(s) : null;
  }

  const NAME_STOP = ["the", "and", "with", "homemade", "my", "de", "do", "da", "com", "meu", "minha", "caseiro", "caseira"];
  const recipeWords = (r) => norm(r.name).split(" ").filter((w) => w.length > 2 && !NAME_STOP.includes(w));
  function findRecipeIn(text) {
    const n = " " + norm(text) + " ";
    const words = n.trim().split(" ");
    const stem = (w) => w.replace(/(es|s)$/, "");
    let best = null;
    for (const r of state.recipes) {
      const name = norm(r.name);
      const rw = recipeWords(r);
      const hit = n.includes(" " + name + " ") || (rw.length && rw.every((w) => words.some((x) => stem(x) === stem(w))));
      if (hit && (!best || name.length > norm(best.name).length)) best = r;
    }
    return best;
  }

  const UNIT_WORDS = ["slices?", "servings?", "pieces?", "portions?", "squares?", "bars?", "muffins?", "cookies?", "bowls?", "cups?",
    "fatias?", "porcao", "porcoes", "pedacos?", "unidades?", "biscoitos?", "barras?", "tigelas?", "xicaras?", "quadrados?", "copos?"];
  const FILLER = ["i", "ate", "had", "have", "having", "a", "an", "of", "the", "my", "this", "that", "some", "homemade", "for", "today", "just", "about", "around", "s",
    "slice", "slices", "serving", "servings", "piece", "pieces", "portion", "portions", "half", "quarter", "third", "whole", "entire", "all",
    "one", "two", "three", "four", "five", "six", "breakfast", "lunch", "dinner", "snack",
    "eu", "comi", "comendo", "tomei", "um", "uma", "de", "do", "da", "dos", "das", "o", "os", "as", "meu", "minha", "no", "na", "hoje", "so", "apenas", "cerca",
    "esse", "essa", "este", "esta", "caseiro", "caseira", "fatia", "fatias", "porcao", "porcoes", "pedaco", "pedacos", "unidade", "unidades",
    "metade", "meia", "meio", "quarto", "terco", "inteiro", "inteira", "todo", "toda", "dois", "duas", "tres", "quatro", "cinco", "seis", "lanche", "almoco", "jantar"];

  // "1/16 of the banana bread", "2 slices of banana bread", "uma fatia do bolo de banana", "metade do bolo".
  // Returns null if the text mentions other foods too (those go to the AI with the recipe as context).
  function matchRecipePortion(text) {
    const r = findRecipeIn(text);
    if (!r) return null;
    const s = deaccent(text.toLowerCase())
      .replace(/[½¼¾]/g, (c) => ({ "½": " 1/2", "¼": " 1/4", "¾": " 3/4" })[c])
      .replace(/(\d),(\d)/g, "$1.$2");
    const lbl = deaccent(r.label.toLowerCase());
    const lblPl = deaccent(recipeLabel(r, 2).toLowerCase());
    const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const unit = `(?:${[escRe(lblPl), escRe(lbl), ...UNIT_WORDS].join("|")})`;
    const num = "(\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+(?:\\.\\d+)?\\s*/\\s*\\d+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?|um quarto(?:\\s+de)?(?:\\s+uma?)?|quarter(?:\\s+of)?(?:\\s+an?)?|half(?:\\s+an?)?|an?|one|two|three|four|five|six|uma?|dois|duas|tres|quatro|cinco|seis|meia|meio)";
    let servings = null;
    const m1 = s.match(new RegExp("(?:^|\\s)" + num + "\\s*(?:(?:of|de)\\s+)?(?:(?:an?|uma?)\\s+)?" + unit + "\\b"));
    if (m1) servings = parseNum(m1[1].replace(/(\s+(?:of|an?|de|uma?))+$/, ""));
    if (servings == null) {
      const m2 = s.match(/(\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?)/);
      if (m2) servings = parseNum(m2[1]) * r.servings;
      else if (/\b(whole|entire|all of|inteir[oa]|tod[oa])\b/.test(s)) servings = r.servings;
      else if (/\b(half|metade)\b/.test(s)) servings = r.servings / 2;
      else if (/\b(quarter|quarto)\b/.test(s)) servings = r.servings / 4;
      else if (/\b(third|terco)\b/.test(s)) servings = r.servings / 3;
      else servings = 1;
    }
    if (!servings || servings <= 0) return null;

    // Anything left besides the recipe and portion words? Then it's a mixed meal.
    const nameWords = norm(r.name).split(" ");
    const leftover = norm(s).split(" ").filter((w) => w && !nameWords.includes(w) && !/^\d+$/.test(w) && !FILLER.includes(w) && w !== lbl && w !== lblPl);
    if (leftover.length > 1) return null;
    return { recipe: r, servings };
  }

  // Saved recipes, sent with mixed meals so the AI uses the user's own numbers.
  function recipeContext() {
    return state.recipes.slice(0, 25).map((r) => ({ name: r.name, servings: r.servings, serving_label: r.label, totals: r.totals }));
  }

  async function analyzeRecipe(text) {
    $("#recipe-error").hidden = true;
    $("#recipe-draft").hidden = true;
    $("#recipe-analyzing").hidden = false;
    $("#recipe-analyze-btn").disabled = true;
    try {
      const data = await postAI({ text, mode: "recipe" });
      recipeDraft = { text, ...data };
      showRecipeDraft();
    } catch (err) {
      $("#recipe-error").textContent = err.message;
      $("#recipe-error").hidden = false;
    } finally {
      $("#recipe-analyzing").hidden = true;
      $("#recipe-analyze-btn").disabled = false;
    }
  }

  function showRecipeDraft() {
    const d = recipeDraft;
    $("#rd-emoji").value = d.emoji || "🍲";
    $("#rd-name").value = d.name || t("rec.defaultName");
    $("#rd-servings").value = d.servings || 8;
    $("#rd-label").value = d.serving_label || t("rec.defaultLabel");
    $("#rd-items").innerHTML = d.items.map((it, i) => itemRow(it, i, false)).join("");
    $("#rd-count").textContent = t("rec.ingredients", { n: d.items.length });
    $("#rd-note").hidden = !(d.notes || !d.servings);
    $("#rd-note").textContent = (d.servings ? "" : t("rec.guessed")) + (d.notes || "");
    updateDraftTotals();
    $("#recipe-draft").hidden = false;
    $("#recipe-draft").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function updateDraftTotals() {
    if (!recipeDraft) return;
    const n = Math.max(1, Math.round(Number($("#rd-servings").value) || 1));
    const label = ($("#rd-label").value || t("rec.defaultLabel")).trim().toLowerCase();
    const tot = recipeDraft.totals;
    const per = { calories: tot.calories / n, protein_g: tot.protein_g / n, carbs_g: tot.carbs_g / n, fat_g: tot.fat_g / n };
    $("#rd-totals").innerHTML = `
      <div class="dt"><span class="dt-label">${t("rec.whole")}</span><span class="dt-big">${fmt(tot.calories)}</span><span class="dt-sub">kcal · ${macroLine(tot, fmt)}</span></div>
      <div class="dt dt-accent"><span class="dt-label">${esc(t("rec.per", { label }))}</span><span class="dt-big">${fmt(per.calories)}</span><span class="dt-sub">kcal · ${macroLine(per)}</span></div>`;
  }
  function saveRecipeDraft() {
    if (!recipeDraft) return;
    const r = {
      id: uid(),
      lang: LANG,
      name: ($("#rd-name").value || t("rec.defaultName")).trim().slice(0, 60),
      emoji: ($("#rd-emoji").value || "🍲").trim().slice(0, 4) || "🍲",
      servings: clamp(Math.round(Number($("#rd-servings").value) || 1), 1, 500),
      label: ($("#rd-label").value || t("rec.defaultLabel")).trim().toLowerCase().slice(0, 20) || t("rec.defaultLabel"),
      text: recipeDraft.text,
      items: recipeDraft.items,
      totals: recipeDraft.totals,
      notes: recipeDraft.notes || "",
      created: Date.now(),
    };
    state.recipes.unshift(r);
    save();
    recipeDraft = null;
    $("#recipe-draft").hidden = true;
    $("#recipe-text").value = "";
    renderRecipes();
    renderComposer();
    toast(t("rec.saved", { emoji: r.emoji, name: r.name, n: fmt(r.totals.calories / r.servings), label: r.label }));
    checkBadges();
  }

  function renderRecipes() {
    $("#recipes-empty").hidden = state.recipes.length > 0;
    $("#recipe-list").innerHTML = state.recipes.map((r, i) => {
      const per = scaleTotals(r, 1);
      return `<article class="card recipe-card" style="--i:${i}" data-id="${r.id}">
        <div class="recipe-top">
          <span class="recipe-emoji" aria-hidden="true">${esc(r.emoji)}</span>
          <div class="recipe-meta">
            <h3>${esc(r.name)}</h3>
            <p class="muted small">${esc(t("rec.makesLine", { n: r.servings, label: recipeLabel(r, r.servings), kcal: fmt(r.totals.calories) }))}</p>
          </div>
          <div class="recipe-kcal"><strong>${fmt(per.calories)}</strong><span class="muted small">${esc(t("rec.kcalPer", { label: r.label }))}</span></div>
        </div>
        <div class="macro-pills">${macroPills(per)}</div>
        <div class="recipe-actions">
          <button type="button" class="btn btn-primary" data-ract="log">${esc(t("rec.logOne", { label: r.label }))}</button>
          <button type="button" class="btn" data-ract="portion">${t("rec.other")}</button>
          <details class="recipe-more"><summary class="btn" aria-label="${esc(t("rec.more"))}">⋯</summary>
            <div class="recipe-more-menu">
              <button type="button" data-ract="ingredients">${t("rec.showIngredients")}</button>
              <button type="button" data-ract="servings">${t("rec.changeYield")}</button>
              <button type="button" data-ract="delete">${t("rec.delete")}</button>
            </div>
          </details>
        </div>
        <ul class="items recipe-ingredients" hidden>${r.items.map((it, j) => itemRow(it, j, false)).join("")}</ul>
      </article>`;
    }).join("");
  }

  function recipeAction(id, act, card) {
    const r = state.recipes.find((x) => x.id === id);
    if (!r) return;
    if (act === "log") {
      addMeals([recipeMeal(r, 1, selectedMeal)], viewDate, t("rec.loggedOne", { emoji: r.emoji, label: r.label, name: r.name, n: fmt(r.totals.calories / r.servings) }));
    } else if (act === "portion") {
      openPortion(id);
    } else if (act === "ingredients") {
      const ul = card.querySelector(".recipe-ingredients");
      ul.hidden = !ul.hidden;
      card.querySelector("details").open = false;
    } else if (act === "servings") {
      card.querySelector("details").open = false;
      const v = prompt(t("rec.yieldPrompt", { label: recipeLabel(r, 2), name: r.name }), r.servings);
      const n = Math.round(Number(v));
      if (n >= 1 && n <= 500) {
        r.servings = n;
        save();
        renderRecipes();
        renderComposer();
        toast(t("rec.yieldSet", { n: fmt(r.totals.calories / n), label: r.label }));
      }
    } else if (act === "delete") {
      const idx = state.recipes.indexOf(r);
      state.recipes.splice(idx, 1);
      save();
      renderRecipes();
      renderComposer();
      toast(t("rec.deleted", { name: r.name }), { label: t("toast.undo"), run: () => { state.recipes.splice(idx, 0, r); save(); renderRecipes(); renderComposer(); } });
    }
  }

  function recipeMeal(r, servings, type) {
    const item = portionItem(r, servings);
    return {
      id: uid(),
      v: PARSER_VERSION,
      lang: LANG,
      type,
      text: describePortion(r, servings),
      time: Date.now(),
      items: [item],
      totals: totalsOf([item]),
      notes: t("portion.note", { frac: fmtFraction(servings / r.servings), name: r.name }),
      manual: false,
      recipeId: r.id,
    };
  }

  // ----- Portion dialog -----
  function openPortion(id) {
    const r = state.recipes.find((x) => x.id === id);
    if (!r) return;
    portionState = { r, mode: "servings", meal: selectedMeal };
    $("#pt-emoji").textContent = r.emoji;
    $("#portion-title").textContent = r.name;
    $("#pt-sub").textContent = t("portion.sub", { n: r.servings, label: recipeLabel(r, r.servings), kcal: fmt(r.totals.calories / r.servings) });
    $("#pt-mode-servings").textContent = t("portion.by", { label: r.label });
    $("#pt-amount").value = 1;
    $("#pt-fraction").value = `1/${r.servings}`;
    const quick = [0.5, 1, 2].map((n) => ({ label: `${fmtAmount(n)} ${recipeLabel(r, n)}`, servings: n }));
    for (const d of [8, 4, 2]) if (d < r.servings) quick.push({ label: t("portion.quickFrac", { d }), servings: r.servings / d });
    $("#pt-quick").innerHTML = quick.map((q, i) => `<button type="button" class="chip" data-q="${i}">${esc(q.label)}</button>`).join("");
    $$("#pt-quick [data-q]").forEach((b) => b.addEventListener("click", () => {
      const q = quick[Number(b.dataset.q)];
      portionState.mode = "servings";
      $("#pt-amount").value = Math.round(q.servings * 100) / 100;
      updatePortion();
    }));
    updatePortion();
    $("#portion").showModal();
  }
  function portionServings() {
    if (!portionState) return 0;
    const { r, mode } = portionState;
    if (mode === "fraction") {
      const f = parseNum($("#pt-fraction").value);
      return f && f > 0 ? f * r.servings : 0;
    }
    const n = Number($("#pt-amount").value);
    return n > 0 ? n : 0;
  }
  function updatePortion() {
    const { r, mode, meal } = portionState;
    $$("[data-pmode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.pmode === mode)));
    $$("[data-pmeal]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.pmeal === meal)));
    $("#pt-servings-row").hidden = mode !== "servings";
    $("#pt-fraction-row").hidden = mode !== "fraction";
    $("#pt-unit").textContent = recipeLabel(r, Number($("#pt-amount").value) || 0);
    const sv = portionServings();
    if (!sv) {
      $("#pt-result").innerHTML = `<span class="muted">${t("portion.enter")}</span>`;
      $("#pt-log").disabled = true;
      return;
    }
    const tot = scaleTotals(r, sv);
    $("#pt-result").innerHTML = `<span class="pr-big">${fmt(tot.calories)} kcal</span>
      <span class="pr-sub">${esc(t("portion.result", { portion: describePortion(r, sv), frac: fmtFraction(sv / r.servings) }))}</span>
      <span class="macro-pills">${macroPills(tot)}</span>`;
    $("#pt-log").disabled = false;
  }
  function logPortion() {
    const sv = portionServings();
    if (!portionState || !sv) return;
    const { r, meal } = portionState;
    $("#portion").close();
    const m = recipeMeal(r, sv, meal);
    addMeals([m], viewDate, t("portion.logged", { emoji: r.emoji, portion: describePortion(r, sv), n: fmt(m.totals.calories) }));
    portionState = null;
  }

  function bindRecipes() {
    $("#recipe-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = $("#recipe-text").value.trim();
      if (!text) { $("#recipe-error").textContent = t("rec.needText"); $("#recipe-error").hidden = false; return; }
      analyzeRecipe(text);
    });
    $("#recipe-example").addEventListener("click", () => { $("#recipe-text").value = t("recipeExample"); $("#recipe-text").focus(); });
    ["#rd-servings", "#rd-label"].forEach((sel) => $(sel).addEventListener("input", updateDraftTotals));
    $("#rd-save").addEventListener("click", saveRecipeDraft);
    $("#rd-cancel").addEventListener("click", () => { recipeDraft = null; $("#recipe-draft").hidden = true; });
    $("#recipe-list").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ract]");
      if (!b) return;
      const card = b.closest(".recipe-card");
      recipeAction(card.dataset.id, b.dataset.ract, card);
    });
    $$("[data-pmode]").forEach((b) => b.addEventListener("click", () => {
      portionState.mode = b.dataset.pmode;
      if (b.dataset.pmode === "fraction") $("#pt-fraction").value = fmtFraction((Number($("#pt-amount").value) || 1) / portionState.r.servings);
      else { const f = parseNum($("#pt-fraction").value); if (f) $("#pt-amount").value = Math.round(f * portionState.r.servings * 100) / 100; }
      updatePortion();
    }));
    $$("[data-pmeal]").forEach((b) => b.addEventListener("click", () => { portionState.meal = b.dataset.pmeal; updatePortion(); }));
    $("#pt-minus").addEventListener("click", () => {
      const v = Number($("#pt-amount").value) || 1;
      $("#pt-amount").value = Math.max(0.25, v - (v > 1 ? 1 : 0.25));
      updatePortion();
    });
    $("#pt-plus").addEventListener("click", () => {
      const v = Number($("#pt-amount").value) || 0;
      $("#pt-amount").value = v < 1 ? v + 0.25 : v + 1;
      updatePortion();
    });
    $("#pt-amount").addEventListener("input", updatePortion);
    $("#pt-fraction").addEventListener("input", updatePortion);
    $("#pt-cancel").addEventListener("click", () => $("#portion").close());
    $("#portion-form").addEventListener("submit", (e) => { e.preventDefault(); logPortion(); });
  }

  // ---------- Install as an app ----------
  let deferredInstall = null;
  function initInstall() {
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    if (standalone) $("#install-card").hidden = true;
    let dismissed = false;
    try { dismissed = localStorage.getItem("plateful.installDismissed") === "1"; } catch (e) {}
    if (isIOS && !standalone && !dismissed) setTimeout(() => ($("#install-banner").hidden = false), 2500);
    $("#install-dismiss").addEventListener("click", () => {
      $("#install-banner").hidden = true;
      try { localStorage.setItem("plateful.installDismissed", "1"); } catch (e) {}
    });
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstall = e;
      $("#install-btn").hidden = false;
    });
    $("#install-btn").addEventListener("click", async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      await deferredInstall.userChoice.catch(() => null);
      deferredInstall = null;
      $("#install-btn").hidden = true;
    });
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
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
    if (pending) renderPreview();
  }

  // ---------- Events ----------
  function bind() {
    $$("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
    $("#streak-chip").addEventListener("click", () => showTab("badges"));
    $("#lang-toggle").addEventListener("click", () => setLang(LANG === "pt" ? "en" : "pt"));

    $("#day-prev").addEventListener("click", () => { viewDate = addDays(viewDate, -1); hidePreview(); renderAll(); });
    $("#day-next").addEventListener("click", () => { if (viewDate < todayKey()) { viewDate = addDays(viewDate, 1); hidePreview(); renderAll(); } });
    $("#day-today").addEventListener("click", () => { viewDate = todayKey(); hidePreview(); renderAll(); });

    $$("[data-meal]").forEach((b) => b.addEventListener("click", () => { selectedMeal = b.dataset.meal; renderComposer(); }));

    $("#meal-text").addEventListener("input", updateCharCount);
    $("#meal-text").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#meal-form").requestSubmit();
    });
    $("#meal-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = $("#meal-text").value.trim();
      if (!text) { showError(t("comp.empty")); return; }
      analyze(text);
    });
    $("#preview-items").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove]");
      if (btn) removePendingItem(Number(btn.dataset.remove));
    });
    $("#preview-done").addEventListener("click", hidePreview);
    $("#preview-undo").addEventListener("click", undoPending);
    $("#preview-reanalyze").addEventListener("click", () => {
      const text = pending && pending.text;
      if (!text) return;
      const d = ensureDay(pending.dayKey);
      d.meals = d.meals.filter((x) => x.id !== pending.mealId);
      save();
      hidePreview();
      renderAll();
      analyze(text, { skipMemory: true });
    });

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
      addMeals([{ id: uid(), lang: LANG, type: selectedMeal, text: name, time: Date.now(), items: [item], totals: totalsOf([item]), notes: "", manual: true }]);
    });

    // Burned
    $("#burned-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $("#burned-input").value;
      if (v === "") return;
      setBurned(Number(v));
      $("#burned-input").blur();
      toast(t("burn.saved", { n: fmt(Number(v)) }));
    });
    $$("[data-burn-add]").forEach((b) => b.addEventListener("click", () => {
      setBurned((day(viewDate).burned || 0) + Number(b.dataset.burnAdd));
    }));
    $("#burn-copy").addEventListener("click", () => setBurned(day(addDays(viewDate, -1)).burned));
    $("#burn-clear").addEventListener("click", () => setBurned(null));

    // Trends
    $("#chart-table-toggle").addEventListener("click", (e) => {
      const tbl = $("#chart-table");
      tbl.hidden = !tbl.hidden;
      e.currentTarget.textContent = tbl.hidden ? t("tr.showTable") : t("tr.hideTable");
      e.currentTarget.setAttribute("aria-pressed", String(!tbl.hidden));
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
      const lang = ($('input[name="lang"]:checked') || {}).value || LANG;
      save();
      setLang(lang);
      checkBadges();
      toast(t("set.saved"));
    });
    $$('input[name="lang"]').forEach((r) => r.addEventListener("change", () => setLang(r.value)));
    $("#export-btn").addEventListener("click", exportData);
    $("#test-ai-btn").addEventListener("click", testConnection);
    $("#import-input").addEventListener("change", (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ""; });
    $("#reset-btn").addEventListener("click", () => {
      if (!confirm(t("set.eraseConfirm"))) return;
      const lang = LANG;
      state = defaultState();
      state.profile.lang = lang;
      save();
      viewDate = todayKey();
      renderAll();
      renderRecipes();
      renderBadges();
      showTab("today");
      openOnboarding();
    });
    $$('[data-action="sample"]').forEach((b) => b.addEventListener("click", () => {
      const hasData = Object.values(state.days).some((d) => d.meals.length || d.burned != null);
      if (hasData && !confirm(t("set.sampleConfirm"))) return;
      loadSample();
      showTab("trends");
    }));

    // Onboarding
    $$("[data-ob-lang]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.obLang === "pt" && state.profile.units === "lb") state.profile.units = "kg";
      if (b.dataset.obLang === "en" && state.profile.units === "kg") state.profile.units = "lb";
      setLang(b.dataset.obLang);
    }));
    $$("#ob-goal-chips [data-goal]").forEach((b) => b.addEventListener("click", () => {
      $("#ob-goal").value = b.dataset.goal;
      $$("#ob-goal-chips .chip").forEach((c) => c.classList.toggle("active", c === b));
    }));
    $("#ob-name").addEventListener("input", updateOnboardingTitle);
    $("#onboarding-form").addEventListener("submit", () => finishOnboarding());
    $("#ob-sample").addEventListener("click", () => { finishOnboarding(); $("#onboarding").close(); loadSample(); });
    $("#onboarding").addEventListener("cancel", () => finishOnboarding());
  }

  function updateOnboardingTitle() {
    const name = $("#ob-name").value.trim();
    $("#ob-title").textContent = name ? t("ob.welcome", { name }) : t("ob.welcomeAnon");
  }
  function openOnboarding() {
    const d = $("#onboarding");
    $("#ob-name").value = state.profile.name || "";
    $("#ob-goal").value = state.profile.goal || 2000;
    updateOnboardingTitle();
    if (typeof d.showModal === "function") d.showModal();
  }
  function finishOnboarding() {
    state.profile.name = $("#ob-name").value.trim();
    state.profile.goal = clamp(Number($("#ob-goal").value) || 2000, 800, 6000);
    state.profile.lang = LANG;
    state.profile.onboarded = true;
    save();
    renderAll();
    setTimeout(() => $("#meal-text").focus({ preventScroll: true }), 50);
  }

  // ---------- Init ----------
  initTheme();
  bind();
  bindRecipes();
  initInstall();
  applyStaticText();
  renderAll();
  renderBadges();
  renderRecipes();
  const hash = location.hash.slice(1);
  if (["today", "trends", "recipes", "badges", "settings"].includes(hash)) showTab(hash);
  if (!state.profile.onboarded) openOnboarding();

  // Roll over to a new day if the tab stays open past midnight.
  let lastToday = todayKey();
  setInterval(() => {
    const now = todayKey();
    if (now !== lastToday) {
      if (viewDate === lastToday) viewDate = now;
      lastToday = now;
      renderAll();
    }
  }, 60000);
})();
