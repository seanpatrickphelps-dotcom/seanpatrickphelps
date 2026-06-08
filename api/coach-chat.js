// /api/coach-chat.js — a check-in turn. Stores the user's message, asks Claude for a coach
// reply using the goal + current plan + recent history, stores and returns the reply.
import { chatSystemPrompt } from "../lib/coach-kb.js";

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

// Render the stored plan (JSON object or JSON string) into context the coach can use.
function planSummary(plan) {
  if (!plan) return "Current plan: none on file yet.";
  let p = plan;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { return `Current plan: ${plan}`; } }
  const lines = ["This week's plan they committed to:"];
  if (p.focus) lines.push(`Focus: ${p.focus}`);
  if (Array.isArray(p.actions) && p.actions.length) {
    lines.push("Actions:");
    for (const a of p.actions) lines.push(`- ${a.task}${a.why ? ` (${a.why})` : ""}`);
  }
  return lines.length > 1 ? lines.join("\n") : "Current plan: on file but no details.";
}

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

    // current plan they committed to (latest), so the check-in diagnostic has something to work with
    const plans = await sb(`coach_plans?user_id=eq.${u.id}&order=created_at.desc&limit=1&select=plan,week_number`);
    const currentPlan = plans && plans.length ? plans[0].plan : null;

    // last 20 messages for context
    const prior = await sb(`coach_messages?user_id=eq.${u.id}&order=created_at.desc&limit=20&select=role,content`);
    const history = (prior || []).reverse().map((m) => ({ role: m.role === "coach" ? "assistant" : "user", content: m.content }));
    history.push({ role: "user", content: message });

    // store the user's message
    await sb("coach_messages", { method: "POST", body: { user_id: u.id, role: "user", content: message, channel: "page" } });

    const ctx = `${chatSystemPrompt()}

This person's current goal and plan. Use it to run the check-in:
Goal: ${u.goal}
Context they gave: ${u.context || "—"}
Current week: ${u.week_number}
${planSummary(currentPlan)}`;

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
