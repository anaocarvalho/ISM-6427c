// Netlify Function: POST /api/analyze-meal
// Sends a plain-text meal description to Claude and returns structured
// nutrition data (per item + totals). The API key never leaves the server:
// set ANTHROPIC_API_KEY in Netlify → Site configuration → Environment variables.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const MAX_INPUT_CHARS = 1200;

const SYSTEM_PROMPT = `You are a registered-dietitian-grade nutrition estimator inside a calorie tracking app.
The user describes something they ate in plain text, usually with amounts (e.g. "2 eggs scrambled in butter, 1 slice sourdough toast, black coffee").

Break the description into individual food or drink items and estimate, for each item, calories (kcal), protein, carbohydrates and fat in grams.
- Respect the amounts the user gives. When an amount is missing, assume a typical single adult serving and state the assumption in that item's "quantity".
- Account for cooking methods and add-ons the user mentions (oil, butter, sauces, dressings).
- Use standard nutrition references (e.g. USDA FoodData Central) and typical restaurant portions for named chain items.
- Zero-calorie items (water, black coffee, plain tea) may be listed with zeros.
- Round calories to whole numbers and macros to one decimal place.
- "emoji" is a single emoji that best represents the item.
- "notes" is one short, friendly sentence: a key assumption you made or a helpful tip. Keep it under 160 characters.
- If the text does not describe anything edible, return an empty "items" array and explain briefly in "notes".`;

const NUTRIENTS = {
  calories: { type: "number", description: "Energy in kcal" },
  protein_g: { type: "number", description: "Protein in grams" },
  carbs_g: { type: "number", description: "Carbohydrates in grams" },
  fat_g: { type: "number", description: "Fat in grams" },
};

const SCHEMA = {
  type: "object",
  properties: {
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
  required: ["items", "notes"],
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

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(
      { error: "The server is missing its ANTHROPIC_API_KEY. Add it in Netlify's environment variables and redeploy." },
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

  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
      // Nutrition lookup is simple extraction, so low effort keeps it fast and cheap.
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      // If a safety classifier declines, retry on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (error) {
    console.error("Claude API error", error);
    if (error instanceof Anthropic.AuthenticationError) {
      return json({ error: "The server's Anthropic API key was rejected. Check ANTHROPIC_API_KEY." }, 502);
    }
    if (error instanceof Anthropic.RateLimitError) {
      return json({ error: "Too many requests right now. Try again in a moment." }, 429);
    }
    if (error instanceof Anthropic.APIError) {
      return json({ error: "The nutrition AI is having trouble. Please try again." }, 502);
    }
    return json({ error: "Couldn't reach the nutrition AI. Please try again." }, 502);
  }

  if (response.stop_reason === "refusal") {
    return json({ error: "I couldn't analyze that one. Try describing just the food." }, 422);
  }

  const textBlock = response.content.find((b) => b.type === "text");
  let parsed;
  try {
    parsed = JSON.parse(textBlock?.text ?? "");
  } catch {
    return json({ error: "The AI's answer came back garbled. Please try again." }, 502);
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

  return json({ items, totals, notes, model: response.model });
};

export const config = {
  path: "/api/analyze-meal",
  method: "POST",
};
