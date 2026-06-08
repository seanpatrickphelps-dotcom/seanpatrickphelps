// /api/coach-state.js — returns a user's goal, latest plan, saved progress, and message history (by token).
const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
async function sb(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
export default async function handler(req, res) {
  try {
    const t = (req.query.t || "").toString();
    if (!t) return res.status(400).json({ ok: false, error: "Missing token" });
    const users = await sb(`coach_users?token=eq.${encodeURIComponent(t)}&select=*`);
    if (!users || !users.length) return res.status(404).json({ ok: false, error: "Not found" });
    const u = users[0];
    const plans = await sb(`coach_plans?user_id=eq.${u.id}&order=week_number.desc&limit=1`);
    const msgs = await sb(`coach_messages?user_id=eq.${u.id}&order=created_at.asc&select=role,content,created_at`);
    const latest = plans && plans[0] ? plans[0] : null;
    return res.status(200).json({
      ok: true,
      name: u.name || "",
      goal: u.goal,
      week: u.week_number,
      plan: (latest && latest.plan) || null,
      progress: (latest && latest.progress) || {},
      messages: msgs || [],
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
