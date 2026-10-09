// Netlify Function: /api/analyze-meal
//   POST {text}                 → Claude breaks the meal into items and returns nutrition JSON.
//   POST {text, mode: "recipe"} → Claude totals a whole recipe (per ingredient) and reads its yield.
//   GET          → health check (is the API key configured? which model?).
// The API key never leaves the server: set ANTHROPIC_API_KEY in
// Netlify → Site configuration → Environment variables, then redeploy.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const MAX_INPUT_CHARS = { meal: 2000, recipe: 5000 };

const SYSTEM_PROMPT = `You are a registered-dietitian-grade nutrition estimator inside a calorie tracking app.
The user describes what they ate in plain text. It may be one food, a sentence, a comma-separated list, a bulleted or numbered list, or several lines. Often it is a whole meal with many foods.

Your most important job is completeness: every food and drink the user mentions must appear in your answer. Never merge separate foods into one item and never drop an item, even small ones (a splash of milk, a pat of butter, ketchup, sugar in coffee, a side of fruit).

Work in two steps:
1. "foods_mentioned": list every distinct food or drink in the text, in the order written, using the user's wording. Treat each line, bullet, comma-separated entry, and each food joined by "and", "with", "plus", "&" or "+" as its own food, unless it is clearly one dish (e.g. "peanut butter and jelly sandwich", "mac and cheese", "chicken burrito with rice and beans" is one burrito).
2. "items": one item for every entry in foods_mentioned, in the same order, with its nutrition. items must have at least as many entries as foods_mentioned.

For each item estimate calories (kcal), protein, carbohydrates and fat in grams:
- Respect the amounts the user gives (counts, cups, grams, oz, slices, tbsp, "large", "half"). When an amount is missing, assume a typical single adult serving and state the assumption in "quantity".
- Account for cooking methods and add-ons the user mentions (oil, butter, sauces, dressings, syrup).
- Use standard nutrition references (e.g. USDA FoodData Central) and typical portions for named restaurant or chain items.
- Zero-calorie items (water, black coffee, plain tea) are still listed, with zeros.
- Round calories to whole numbers and macros to one decimal place.
- "emoji" is a single emoji that best represents the item.

"notes" is one short, friendly sentence (under 160 characters): the key assumption you made or a helpful tip.
If the text does not describe anything edible, return empty "foods_mentioned" and "items" arrays and explain briefly in "notes".`;

const NUTRIENTS = {
  calories: { type: "number", description: "Energy in kcal" },
  protein_g: { type: "number", description: "Protein in grams" },
  carbs_g: { type: "number", description: "Carbohydrates in grams" },
  fat_g: { type: "number", description: "Fat in grams" },
};

const SCHEMA = {
  type: "object",
  properties: {
    foods_mentioned: {
      type: "array",
      description: "Every distinct food or drink in the user's text, in order",
      items: { type: "string" },
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short food name, e.g. 'Scrambled eggs'" },
          quantity: { type: "string", description: "Amount eaten, e.g. '2 large'" },
          emoji: { type: "string" },
          ...NUTRIENTS,
        },
        required: ["name", "quantity", "emoji", "calories", "protein_g", "carbs_g", "fat_g"],
        additionalProperties: false,
      },
    },
    notes: { type: "string" },
  },
  required: ["foods_mentioned", "items", "notes"],
  additionalProperties: false,
};

const RECIPE_PROMPT = `You are a registered-dietitian-grade nutrition estimator inside a calorie tracking app.
The user pastes a recipe they cooked: usually a title, an ingredient list with amounts, and maybe the yield and method. Estimate the nutrition of the WHOLE batch, ingredient by ingredient.

Work in two steps:
1. "ingredients_mentioned": every ingredient with an amount, in the order written, using the user's wording. Skip pure equipment and instructions.
2. "items": one item per entry in ingredients_mentioned, same order, with the nutrition of the FULL amount used in the recipe (e.g. "3 ripe bananas" → all three bananas).

Rules:
- Respect the exact amounts and units (cups, tbsp, tsp, grams, oz, sticks of butter, "1 large egg"). Convert volumes to weights with standard densities (e.g. 1 cup all-purpose flour ≈ 125 g, 1 cup granulated sugar ≈ 200 g, 1 stick butter = 113 g).
- Ingredients without an amount ("a pinch of salt", "oil for the pan") get a small realistic amount, stated in "quantity".
- Zero- or near-zero-calorie ingredients (baking soda, salt, spices, water) are listed with their small or zero values.
- Use standard references such as USDA FoodData Central. Round calories to whole numbers and macros to one decimal place.
- "name": a short, friendly recipe name (from the title if given, otherwise inferred, e.g. "Banana bread").
- "emoji": one emoji for the dish.
- "servings": the number of portions the recipe says it makes ("makes 12 muffins", "serves 4", "cut into 16 slices"). Use 0 if it isn't stated.
- "serving_label": the singular word for one portion ("slice", "muffin", "cookie", "serving", "bowl", "piece"); "serving" if unclear.
- "notes": one short, friendly sentence (under 160 characters) with a key assumption.
If the text is not a recipe or food, return empty arrays and explain in "notes".`;

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    emoji: { type: "string" },
    servings: { type: "number", description: "Portions the recipe makes; 0 if not stated" },
    serving_label: { type: "string" },
    ingredients_mentioned: { type: "array", items: { type: "string" } },
    items: SCHEMA.properties.items,
    notes: { type: "string" },
  },
  required: ["name", "emoji", "servings", "serving_label", "ingredients_mentioned", "items", "notes"],
  additionalProperties: false,
};

const MODES = {
  meal: { system: SYSTEM_PROMPT, schema: SCHEMA, listKey: "foods_mentioned", intro: "Here is everything I ate:", tag: "meal", noun: "foods" },
  recipe: { system: RECIPE_PROMPT, schema: RECIPE_SCHEMA, listKey: "ingredients_mentioned", intro: "Here is the recipe I made:", tag: "recipe", noun: "ingredients" },
};

const client = new Anthropic();

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const num = (v, digits) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

// Rough split of the user's text into separate entries (lines, bullets,
// semicolons, commas). Given to Claude as a checklist and used to detect
// answers that skipped foods.
function splitEntries(text) {
  return text
    .split(/\r?\n|;|,(?![^(]*\))/)
    .map((s) => s.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "").replace(/^\s*(?:and|plus|also)\s+/i, "").trim())
    .filter((s) => s.length > 1);
}

// The user's saved recipes, so a meal like "a slice of my banana bread and a coffee"
// uses their own numbers instead of a generic estimate.
function recipeNotes(recipes) {
  if (!Array.isArray(recipes) || !recipes.length) return "";
  const lines = recipes.slice(0, 25).map((r) => {
    const n = Math.max(1, Math.round(Number(r?.servings) || 1));
    const t = r?.totals || {};
    const per = (v) => Math.round(((Number(v) || 0) / n) * 10) / 10;
    const label = String(r?.serving_label || "serving").slice(0, 20);
    return `- ${String(r?.name || "Recipe").slice(0, 60)}: makes ${n} ${label}(s). One ${label} = ${per(t.calories)} kcal, ${per(t.protein_g)} g protein, ${per(t.carbs_g)} g carbs, ${per(t.fat_g)} g fat.`;
  });
  return `\n\nMy saved home recipes. If I mention one, use these exact numbers scaled to the amount I ate (e.g. 1/16 of a 16-slice recipe = 1 slice); otherwise ignore them:\n${lines.join("\n")}`;
}

function buildUserMessage(mode, text, entries, retryNote, recipes, lang = "en") {
  const m = MODES[mode];
  let msg = `${m.intro}\n<${m.tag}>\n${text}\n</${m.tag}>`;
  if (entries.length > 1) {
    msg += mode === "recipe"
      ? `\n\nIt has these ${entries.length} lines (some may be a title, yield or instructions rather than ingredients). Make sure every ingredient is covered:\n`
      : `\n\nIt contains at least these ${entries.length} separate entries (an entry can hold more than one food). Make sure every one is covered:\n`;
    msg += entries.map((e, i) => `${i + 1}. ${e}`).join("\n");
  }
  if (mode === "meal") msg += recipeNotes(recipes);
  msg += `\n\n${LANG_NOTE[lang]}`;
  if (retryNote) msg += `\n\n${retryNote}`;
  return msg;
}

// Reply language. Users may write in either language; the log should read in theirs.
const LANG_NOTE = {
  en: "Write every name, quantity, serving_label and notes value in English, even if my text is in another language.",
  pt: "Escreva todos os valores de name, quantity, serving_label e notes em português do Brasil, mesmo que meu texto esteja em outro idioma. Use medidas caseiras brasileiras quando fizer sentido (colher de sopa, xícara, concha, fatia).",
};

// User-facing error messages.
const ERR = {
  en: {
    noKey: "The server is missing its ANTHROPIC_API_KEY. Add it in Netlify → Site configuration → Environment variables, then redeploy.",
    badJson: "Send JSON like {\"text\": \"2 eggs and toast\"}.",
    emptyMeal: "Tell me what you ate first.",
    emptyRecipe: "Paste your recipe first.",
    tooLong: "That's a lot of text! Keep it under {n} characters.",
    refusal: "I couldn't analyze that one. Try describing just the food.",
    garbled: "The AI's answer came back garbled. Please try again.",
    auth: "The server's Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Netlify and redeploy.",
    perm: "This API key can't use the model. Check your Anthropic account, or set ANTHROPIC_MODEL in Netlify.",
    model: "Model \"{m}\" wasn't found for this API key. Set ANTHROPIC_MODEL in Netlify.",
    rate: "Too many requests, or the account is out of credits. Try again in a moment.",
    api: "The nutrition AI returned an error. Please try again.",
    network: "Couldn't reach the nutrition AI. Please try again.",
    noFood: "I couldn't find any food in that description.",
    noIngredients: "I couldn't find any ingredients in that recipe.",
  },
  pt: {
    noKey: "O servidor está sem a ANTHROPIC_API_KEY. Adicione em Netlify → Site configuration → Environment variables e publique de novo.",
    badJson: "Envie JSON como {\"text\": \"2 ovos e torrada\"}.",
    emptyMeal: "Primeiro me conte o que você comeu.",
    emptyRecipe: "Primeiro cole a sua receita.",
    tooLong: "É muito texto! Use menos de {n} caracteres.",
    refusal: "Não consegui analisar isso. Tente descrever só a comida.",
    garbled: "A resposta da IA veio com problema. Tente de novo.",
    auth: "A chave da API da Anthropic foi recusada. Confira a ANTHROPIC_API_KEY na Netlify e publique de novo.",
    perm: "Esta chave da API não pode usar o modelo. Confira sua conta da Anthropic ou defina ANTHROPIC_MODEL na Netlify.",
    model: "O modelo \"{m}\" não foi encontrado para esta chave. Defina ANTHROPIC_MODEL na Netlify.",
    rate: "Muitas solicitações, ou a conta está sem créditos. Tente de novo em instantes.",
    api: "A IA de nutrição retornou um erro. Tente de novo.",
    network: "Não foi possível acessar a IA de nutrição. Tente de novo.",
    noFood: "Não encontrei nenhum alimento nessa descrição.",
    noIngredients: "Não encontrei ingredientes nessa receita.",
  },
};

let fallbackSupported = true;

async function callClaude(mode, userMessage) {
  const base = {
    model: MODEL,
    max_tokens: 16000,
    system: MODES[mode].system,
    messages: [{ role: "user", content: userMessage }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: MODES[mode].schema } },
  };
  if (fallbackSupported) {
    try {
      // If a safety classifier declines, retry on Anthropic's recommended fallback model.
      return await client.beta.messages.create({
        ...base,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (error) {
      if (!(error instanceof Anthropic.BadRequestError)) throw error;
      console.warn("Request with fallbacks was rejected; retrying without them:", error.message);
      fallbackSupported = false;
    }
  }
  return client.messages.create(base);
}

function parseResponse(response) {
  if (response.stop_reason === "refusal") return { refusal: true };
  const textBlock = response.content.find((b) => b.type === "text");
  try {
    return { data: JSON.parse(textBlock?.text ?? "") };
  } catch {
    return { garbled: true, stop_reason: response.stop_reason };
  }
}

export default async (req) => {
  if (req.method === "GET") {
    return json({ ok: Boolean(process.env.ANTHROPIC_API_KEY), hasKey: Boolean(process.env.ANTHROPIC_API_KEY), model: MODEL });
  }
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let text = "";
  let mode = "meal";
  let recipes = [];
  let lang = "en";
  let body = null;
  try { body = await req.json(); } catch { /* handled below */ }
  if (body?.lang === "pt") lang = "pt";
  const E = ERR[lang];

  if (!process.env.ANTHROPIC_API_KEY) return json({ error: E.noKey }, 500);

  try {
    if (!body || typeof body !== "object") throw new Error("bad body");
    if (Array.isArray(body?.recipes)) recipes = body.recipes;
    text = String(body?.text ?? "").trim();
    if (body?.mode === "recipe") mode = "recipe";
  } catch {
    return json({ error: E.badJson }, 400);
  }
  if (!text) return json({ error: mode === "recipe" ? E.emptyRecipe : E.emptyMeal }, 400);
  if (text.length > MAX_INPUT_CHARS[mode]) {
    return json({ error: E.tooLong.replace("{n}", MAX_INPUT_CHARS[mode]) }, 400);
  }

  const entries = splitEntries(text);
  const listKey = MODES[mode].listKey;
  let parsed;
  let model = MODEL;
  try {
    let response = await callClaude(mode, buildUserMessage(mode, text, entries, "", recipes, lang));
    let result = parseResponse(response);
    model = response.model;

    // Retry once if the answer was unusable or clearly skipped foods. Recipe text
    // includes titles and steps, so only the model's own ingredient list counts there.
    const tooFew = (r) => r.data && Array.isArray(r.data.items) &&
      r.data.items.length < Math.max(mode === "meal" ? entries.length : 0, (r.data[listKey] || []).length);
    if (result.garbled || tooFew(result)) {
      const got = result.data?.items?.length ?? 0;
      const note = result.garbled
        ? "Your previous answer was not valid JSON. Answer again following the schema."
        : `Your previous answer only had ${got} item(s), but the text lists more ${MODES[mode].noun}. Include a separate item for every one.`;
      const retry = parseResponse(await callClaude(mode, buildUserMessage(mode, text, entries, note, recipes, lang)));
      const better = retry.data && (!result.data || (retry.data.items?.length ?? 0) > got);
      if (better) result = retry;
    }

    if (result.refusal) return json({ error: E.refusal }, 422);
    if (!result.data) return json({ error: E.garbled }, 502);
    parsed = result.data;
  } catch (error) {
    console.error("Claude API error:", error?.status, error?.message);
    const detail = error instanceof Anthropic.APIError ? `${error.status ?? ""} ${error.message}`.trim().slice(0, 300) : String(error?.message || error).slice(0, 300);
    if (error instanceof Anthropic.AuthenticationError) {
      return json({ error: E.auth, detail }, 502);
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      return json({ error: E.perm, detail }, 502);
    }
    if (error instanceof Anthropic.NotFoundError) {
      return json({ error: E.model.replace("{m}", MODEL), detail }, 502);
    }
    if (error instanceof Anthropic.RateLimitError) {
      return json({ error: E.rate, detail }, 429);
    }
    if (error instanceof Anthropic.APIError) {
      return json({ error: E.api, detail }, 502);
    }
    return json({ error: E.network, detail }, 502);
  }

  const items = (Array.isArray(parsed.items) ? parsed.items : []).map((it) => ({
    name: String(it.name || "Food").slice(0, 80),
    quantity: String(it.quantity || "").slice(0, 80),
    emoji: String(it.emoji || "🍽️").slice(0, 8),
    calories: num(it.calories, 0),
    protein_g: num(it.protein_g, 1),
    carbs_g: num(it.carbs_g, 1),
    fat_g: num(it.fat_g, 1),
  }));

  const notes = String(parsed.notes || "").slice(0, 300);
  if (items.length === 0) {
    return json({ error: notes || (mode === "recipe" ? E.noIngredients : E.noFood), items: [] }, 422);
  }

  // Totals are summed here (not trusted from the model) so they always match the items.
  const sum = (k, d) => num(items.reduce((acc, it) => acc + it[k], 0), d);
  const totals = {
    calories: sum("calories", 0),
    protein_g: sum("protein_g", 1),
    carbs_g: sum("carbs_g", 1),
    fat_g: sum("fat_g", 1),
  };

  if (mode === "recipe") {
    const servings = Math.round(Number(parsed.servings) || 0);
    return json({
      name: String(parsed.name || (lang === "pt" ? "Minha receita" : "My recipe")).slice(0, 60),
      emoji: String(parsed.emoji || "🍲").slice(0, 8),
      servings: servings > 0 && servings <= 500 ? servings : 0,
      serving_label: String(parsed.serving_label || (lang === "pt" ? "porção" : "serving")).toLowerCase().slice(0, 20),
      items, totals, notes, model,
    });
  }
  return json({ items, totals, notes, model });
};

export const config = {
  path: "/api/analyze-meal",
  method: ["GET", "POST"],
};
