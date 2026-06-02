// /api/coach-start.js — Vercel serverless function
// Onboards a user: generates Week 1 plan (Claude), stores it (Supabase), emails it (Resend).
//
// Required env vars:
//   ANTHROPIC_API_KEY      — your Anthropic API key
//   SUPABASE_URL           — e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY   — Supabase service_role key (server only — keep secret)
//   RESEND_API_KEY         — your Resend key (full access)
//   COACH_FROM_EMAIL       — e.g. "Sean's Coach <coach@seanpatrickphelps.com>" (default: onboarding@resend.dev)
//   APP_URL                — e.g. https://seanpatrickphelps.com (default)

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const RESEND = process.env.RESEND_API_KEY;
const FROM = process.env.COACH_FROM_EMAIL || "Sean's Coach <onboarding@resend.dev>";
const APP_URL = process.env.APP_URL || "https://seanpatrickphelps.com";
const MODEL = "claude-sonnet-4-6"; // swap if you prefer a cheaper/faster model

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const token = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");

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

async function claude(system, userMsg, max_tokens = 900) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages: [{ role: "user", content: userMsg }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

const PLAN_SYSTEM = `You are an accountability coach in the voice of Sean Patrick Phelps: warm but no-nonsense, practical, and grounded. Your stance is "us vs. the goal — not me vs. you." You help people make consistent weekly progress.
Return ONLY valid JSON (no markdown, no code fences) with exactly this shape:
{"greeting":"one short personal line","focus":"the single theme for this week, one sentence","actions":[{"task":"concrete action","why":"one line on why it matters"}],"reflection":"one question worth journaling on","closing":"one encouraging line"}
Give 3-5 actions that are realistic for ONE week. Be specific, not generic.`;

async function generatePlan({ goal, context, timeframe, weekNumber }) {
  const msg = `Goal: ${goal}\nContext: ${context || "—"}\nTimeframe: ${timeframe || "—"}\nThis is week ${weekNumber}.\n\nWrite this week's plan now.`;
  const raw = await claude(PLAN_SYSTEM, msg);
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

function planEmailHtml({ name, plan, link, weekNumber }) {
  const actions = (plan.actions || []).map((a) =>
    `<tr><td style="padding:0 0 14px 0;vertical-align:top;width:26px"><div style="width:9px;height:9px;border-radius:50%;background:#347f9e;margin-top:6px"></div></td><td style="padding:0 0 14px 0"><strong style="color:#17211F">${esc(a.task)}</strong><br><span style="color:#5C636B;font-size:14px">${esc(a.why || "")}</span></td></tr>`
  ).join("");
  return `<div style="background:#F3F1EA;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e7e4da;border-radius:14px;overflow:hidden">
    <div style="background:#17211F;padding:22px 28px;color:#F3F1EA">
      <div style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#347f9e">Week ${weekNumber}</div>
      <div style="font-size:21px;margin-top:4px">Your plan this week</div>
    </div>
    <div style="padding:28px">
      <p style="color:#17211F;font-size:16px;margin:0 0 16px">${esc(plan.greeting || `Hi ${name || "there"} —`)}</p>
      <p style="color:#26302e;font-size:16px;margin:0 0 20px"><strong>This week's focus:</strong> ${esc(plan.focus || "")}</p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 8px">${actions}</table>
      ${plan.reflection ? `<div style="background:#F3F1EA;border-left:3px solid #4E7B53;padding:12px 16px;border-radius:6px;margin:14px 0;color:#26302e;font-size:14.5px"><strong>Reflect:</strong> ${esc(plan.reflection)}</div>` : ""}
      <p style="color:#26302e;font-size:15px;margin:18px 0 22px">${esc(plan.closing || "Let's go. One week at a time.")}</p>
      <a href="${esc(link)}" style="display:inline-block;background:#B0542F;color:#fff;text-decoration:none;font-weight:600;padding:13px 26px;border-radius:6px;font-size:15px">Open your coach page →</a>
      <p style="color:#787e84;font-size:12.5px;margin:22px 0 0">Reply to this email anytime to check in, or use your coach page above. — Sean</p>
    </div>
  </div></div>`;
}

async function sendEmail(to, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  try {
    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
    const name = (b.name || "").trim();
    const email = (b.email || "").trim().toLowerCase();
    const goal = (b.goal || "").trim();
    const context = (b.context || "").trim();
    const timeframe = (b.timeframe || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !goal)
      return res.status(400).json({ ok: false, error: "Add your email and a goal to get started." });

    const tok = token();
    const plan = await generatePlan({ goal, context, timeframe, weekNumber: 1 });
    const [user] = await sb("coach_users", {
      method: "POST", prefer: "return=representation",
      body: { email, name, token: tok, goal, context, timeframe, week_number: 1, status: "active" },
    });
    await sb("coach_plans", { method: "POST", body: { user_id: user.id, week_number: 1, plan } });

    const link = `${APP_URL}/coach.html?t=${tok}`;
    await sendEmail(email, `Week 1: ${goal.slice(0, 60)}`, planEmailHtml({ name, plan, link, weekNumber: 1 }));

    return res.status(200).json({ ok: true, token: tok });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Couldn't start your plan right now — try again in a moment." });
  }
}
