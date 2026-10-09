// Netlify Function: /api/analyze-meal
//   POST {text}  → Claude breaks the meal into items and returns nutrition JSON.
//   GET          → health check (is the API key configured? which model?).
// The API key never leaves the server: set ANTHROPIC_API_KEY in
// Netlify → Site configuration → Environment variables, then redeploy.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const MAX_INPUT_CHARS = 2000;

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

function buildUserMessage(text, entries, retryNote) {
  let msg = `Here is everything I ate:\n<meal>\n${text}\n</meal>`;
  if (entries.length > 1) {
    msg += `\n\nIt contains at least these ${entries.length} separate entries (an entry can hold more than one food). Make sure every one is covered:\n`;
    msg += entries.map((e, i) => `${i + 1}. ${e}`).join("\n");
  }
  if (retryNote) msg += `\n\n${retryNote}`;
  return msg;
}

let fallbackSupported = true;

async function callClaude(userMessage) {
  const base = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
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

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(
      { error: "The server is missing its ANTHROPIC_API_KEY. Add it in Netlify → Site configuration → Environment variables, then redeploy." },
      500,
    );
  }

  let text = "";
  try {
    const body = await req.json();
    text = String(body?.text ?? "").trim();
  } catch {
    return json({ error: "Send JSON like {\"text\": \"2 eggs and toast\"}." }, 400);
  }
  if (!text) return json({ error: "Tell me what you ate first." }, 400);
  if (text.length > MAX_INPUT_CHARS) {
    return json({ error: `That's a feast! Keep it under ${MAX_INPUT_CHARS} characters.` }, 400);
  }

  const entries = splitEntries(text);
  let parsed;
  let model = MODEL;
  try {
    let response = await callClaude(buildUserMessage(text, entries));
    let result = parseResponse(response);
    model = response.model;

    // Retry once if the answer was unusable or clearly skipped foods.
    const tooFew = (r) => r.data && Array.isArray(r.data.items) &&
      r.data.items.length < Math.max(entries.length, (r.data.foods_mentioned || []).length);
    if (result.garbled || tooFew(result)) {
      const got = result.data?.items?.length ?? 0;
      const note = result.garbled
        ? "Your previous answer was not valid JSON. Answer again following the schema."
        : `Your previous answer only had ${got} item(s), but the meal lists more foods. Include a separate item for every food and drink.`;
      const retry = parseResponse(await callClaude(buildUserMessage(text, entries, note)));
      const better = retry.data && (!result.data || (retry.data.items?.length ?? 0) > got);
      if (better) result = retry;
    }

    if (result.refusal) return json({ error: "I couldn't analyze that one. Try describing just the food." }, 422);
    if (!result.data) return json({ error: "The AI's answer came back garbled. Please try again." }, 502);
    parsed = result.data;
  } catch (error) {
    console.error("Claude API error:", error?.status, error?.message);
    const detail = error instanceof Anthropic.APIError ? `${error.status ?? ""} ${error.message}`.trim().slice(0, 300) : String(error?.message || error).slice(0, 300);
    if (error instanceof Anthropic.AuthenticationError) {
      return json({ error: "The server's Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Netlify and redeploy.", detail }, 502);
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      return json({ error: "This API key can't use the model. Check your Anthropic account, or set ANTHROPIC_MODEL in Netlify.", detail }, 502);
    }
    if (error instanceof Anthropic.NotFoundError) {
      return json({ error: `Model "${MODEL}" wasn't found for this API key. Set ANTHROPIC_MODEL in Netlify.`, detail }, 502);
    }
    if (error instanceof Anthropic.RateLimitError) {
      return json({ error: "Too many requests, or the account is out of credits. Try again in a moment.", detail }, 429);
    }
    if (error instanceof Anthropic.APIError) {
      return json({ error: "The nutrition AI returned an error. Please try again.", detail }, 502);
    }
    return json({ error: "Couldn't reach the nutrition AI. Please try again.", detail }, 502);
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
    return json({ error: notes || "I couldn't find any food in that description.", items: [] }, 422);
  }

  // Totals are summed here (not trusted from the model) so they always match the items.
  const sum = (k, d) => num(items.reduce((acc, it) => acc + it[k], 0), d);
  const totals = {
    calories: sum("calories", 0),
    protein_g: sum("protein_g", 1),
    carbs_g: sum("carbs_g", 1),
    fat_g: sum("fat_g", 1),
  };

  return json({ items, totals, notes, model });
};

export const config = {
  path: "/api/analyze-meal",
  method: ["GET", "POST"],
};
