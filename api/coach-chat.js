// /api/coach-chat.js — a check-in turn. Stores the user's message, asks Claude for a coach
// reply using the goal + recent history, stores and returns the reply.
const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-6";

async function sb(path, { method = "GET", body } = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const CHAT_SYSTEM = `You are an accountability coach in the voice of Sean Patrick Phelps: warm but direct, practical, never preachy. Your stance is "us vs. the goal — not me vs. you." Keep replies short (2-5 sentences). Acknowledge what they did, be honest about what's missing, and end with ONE focused question or one concrete next step. No filler, no bullet lists unless they ask.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  try {
    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
    const t = (b.t || "").toString();
    const message = (b.message || "").trim();
    if (!t || !message) return res.status(400).json({ ok: false, error: "Missing token or message" });

    const users = await sb(`coach_users?token=eq.${encodeURIComponent(t)}&select=*`);
    if (!users || !users.length) return res.status(404).json({ ok: false, error: "Not found" });
    const u = users[0];

    // last 20 messages for context
    const prior = await sb(`coach_messages?user_id=eq.${u.id}&order=created_at.desc&limit=20&select=role,content`);
    const history = (prior || []).reverse().map((m) => ({ role: m.role === "coach" ? "assistant" : "user", content: m.content }));
    history.push({ role: "user", content: message });

    // store the user's message
    await sb("coach_messages", { method: "POST", body: { user_id: u.id, role: "user", content: message, channel: "page" } });

    const ctx = `${CHAT_SYSTEM}\n\nTheir goal: ${u.goal}\nContext they gave: ${u.context || "—"}\nCurrent week: ${u.week_number}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system: ctx, messages: history }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    const d = await r.json();
    const reply = (d.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n").trim();

    await sb("coach_messages", { method: "POST", body: { user_id: u.id, role: "coach", content: reply, channel: "page" } });

    return res.status(200).json({ ok: true, reply });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "The coach is unavailable for a moment — try again." });
  }
}
