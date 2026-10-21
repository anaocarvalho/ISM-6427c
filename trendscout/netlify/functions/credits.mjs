// Netlify Function: GET /api/credits
// Returns the Scrape Creators credit balance: { credits: number|null }.
// Cached for 60 seconds so page loads don't each cost an upstream call.
import { cached, callApi, errorResponse, guard, json, missingKey, safeMessage } from "./lib/scrapecreators.mjs";

const FIELDS = ["creditCount", "credit_count", "credits", "creditBalance", "credit_balance", "balance", "remainingCredits", "remaining_credits"];

// The exact field name isn't documented reliably, so try the plausible ones (top level, then `data`).
export function readCredits(body) {
  for (const obj of [body, body?.data]) {
    if (!obj || typeof obj !== "object") continue;
    for (const f of FIELDS) {
      const n = typeof obj[f] === "string" && obj[f].trim() !== "" ? Number(obj[f]) : obj[f];
      if (typeof n === "number" && Number.isFinite(n)) return n;
    }
  }
  return null;
}

export default async (req, context) => {
  const blocked = guard(req, context);
  if (blocked) return blocked;
  const noKey = missingKey();
  if (noKey) return noKey;

  try {
    const credits = await cached(
      "credits",
      async () => readCredits(await callApi("/v1/account/credit-balance", {}, { label: "Scrape Creators" })),
      60 * 1000,
    );
    return json(200, { credits });
  } catch (error) {
    return errorResponse(502, safeMessage(error, "Couldn't load the credit balance"));
  }
};

export const config = { path: "/api/credits" };
