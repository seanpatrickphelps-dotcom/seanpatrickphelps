// POST /api/train-food  (Authorization: Bearer <access_token>)
//   { action:"estimate", text, image, media_type } -> { meal }  (not saved)
//   { action:"confirm", date, items, note }        -> { meal }
//   { action:"update", id, items, note }           -> { meal }
//   { action:"remove", id }                        -> { ok }
//   { action:"hydration", date, ounces }           -> { hydration }
// The Anthropic key stays on the server. Estimate does not write a row.
import { json, db, requireUser, ensureSeeded, cleanMacro, mealsMigrationError, normalizeMealItems, mealTotals, requestMealEstimate } from "../lib/train.js";

const KEY = process.env.ANTHROPIC_API_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  try {
    const user = await requireUser(req);
    await ensureSeeded(user.id);
    const b = req.body || {};
    const uid = user.id;

    if (b.action === "estimate") {
      const result = await requestMealEstimate({ apiKey: KEY, text: b.text, image: b.image, mediaType: b.media_type });
      if (!result.ok) return json(res, result.status, { error: result.error });
      return json(res, 200, { meal: result.meal });
    }

    if (b.action === "confirm") {
      const date = validDate(b.date);
      if (!date) return json(res, 400, { error: "Date must be YYYY-MM-DD." });
      const items = normalizeMealItems(b.items);
      const totals = mealTotals(items);
      const note = String(b.note || "").trim().slice(0, 500);
      try {
        const saved = await db("nutrition_meals", { method: "POST", body: { user_id: uid, log_date: date, items, ...totals, note } });
        return json(res, 200, { meal: shapeMeal(saved[0]) });
      } catch (e) {
        const msg = mealsMigrationError(e);
        if (msg) return json(res, 400, { error: msg });
        throw e;
      }
    }

    if (b.action === "update") {
      const id = Number(b.id);
      const items = normalizeMealItems(b.items);
      const totals = mealTotals(items);
      const note = String(b.note || "").trim().slice(0, 500);
      try {
        const saved = await db(`nutrition_meals?id=eq.${id}&user_id=eq.${uid}`, { method: "PATCH", body: { items, ...totals, note, updated_at: new Date().toISOString() } });
        if (!saved?.length) return json(res, 404, { error: "Meal not found." });
        return json(res, 200, { meal: shapeMeal(saved[0]) });
      } catch (e) {
        const msg = mealsMigrationError(e);
        if (msg) return json(res, 400, { error: msg });
        throw e;
      }
    }

    if (b.action === "remove") {
      const id = Number(b.id);
      try {
        await db(`nutrition_meals?id=eq.${id}&user_id=eq.${uid}`, { method: "DELETE", prefer: "return=minimal" });
        return json(res, 200, { ok: true });
      } catch (e) {
        const msg = mealsMigrationError(e);
        if (msg) return json(res, 400, { error: msg });
        throw e;
      }
    }

    if (b.action === "hydration") {
      const date = validDate(b.date);
      if (!date) return json(res, 400, { error: "Date must be YYYY-MM-DD." });
      const ounces = cleanMacro(b.ounces);
      try {
        if (ounces == null) {
          await db(`hydration_logs?user_id=eq.${uid}&log_date=eq.${date}`, { method: "DELETE", prefer: "return=minimal" });
          return json(res, 200, { hydration: null });
        }
        const saved = await db("hydration_logs?on_conflict=user_id,log_date", {
          method: "POST",
          body: { user_id: uid, log_date: date, ounces, updated_at: new Date().toISOString() },
          prefer: "resolution=merge-duplicates,return=representation",
        });
        const row = saved?.[0] || { log_date: date, ounces };
        return json(res, 200, { hydration: { log_date: row.log_date, ounces: row.ounces } });
      } catch (e) {
        const msg = mealsMigrationError(e);
        if (msg) return json(res, 400, { error: msg });
        throw e;
      }
    }

    return json(res, 400, { error: "Unknown action." });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}

function validDate(v) {
  const date = String(v || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date) return null;
  return date;
}

function shapeMeal(row) {
  return {
    id: row.id, log_date: row.log_date, items: row.items || [], note: row.note || "",
    calories: row.calories, protein: row.protein, carbs: row.carbs, fat: row.fat,
  };
}
