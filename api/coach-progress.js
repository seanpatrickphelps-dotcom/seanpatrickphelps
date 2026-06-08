// /api/coach-progress.js — saves which plan actions a user has checked off.
// Called when someone taps a checkbox on the coach page. Progress is stored on
// the user's latest plan so it syncs across devices and the coach can read it.

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// How many actions the plan has, so we can reject out-of-range indexes.
function actionCount(plan) {
  let p = plan;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { return 0; } }
  return p && Array.isArray(p.actions) ? p.actions.length : 0;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  try {
    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
    const t = (b.t || "").toString();
    const index = Number(b.index);
    const done = b.done === true || b.done === "1" || b.done === 1;
    if (!t || !Number.isInteger(index) || index < 0) return res.status(400).json({ ok: false, error: "Bad request" });

    const users = await sb(`coach_users?token=eq.${encodeURIComponent(t)}&select=id`);
    if (!users || !users.length) return res.status(404).json({ ok: false, error: "Not found" });
    const u = users[0];

    // The same "latest plan" the coach page shows.
    const plans = await sb(`coach_plans?user_id=eq.${u.id}&order=week_number.desc&limit=1&select=id,plan,progress`);
    if (!plans || !plans.length) return res.status(404).json({ ok: false, error: "No plan" });
    const plan = plans[0];

    const total = actionCount(plan.plan);
    if (total && index >= total) return res.status(400).json({ ok: false, error: "Index out of range" });

    const progress = plan.progress && typeof plan.progress === "object" ? plan.progress : {};
    if (done) progress[String(index)] = true; else delete progress[String(index)];

    await sb(`coach_plans?id=eq.${plan.id}`, { method: "PATCH", body: { progress }, prefer: "return=minimal" });

    const doneCount = Object.keys(progress).filter((k) => progress[k]).length;
    return res.status(200).json({ ok: true, progress, done: doneCount, total });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Could not save progress" });
  }
}
