// /api/coach-inbound.js — handles a reply that arrives by email.
// Flow: Resend receives the reply and calls this with the email's ID. We fetch
// the body from Resend, run the coach (same brain as the page chat), store both
// sides of the exchange, and email the coach's reply back so the thread continues.
import { chatSystemPrompt } from "../lib/coach-kb.js";

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const RESEND = process.env.RESEND_API_KEY;
const FROM = process.env.COACH_FROM_EMAIL || "Sean's Coach <coach@seanpatrickphelps.com>";
const REPLY_TO = process.env.COACH_REPLY_TO; // the address Resend receives replies on
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

// Pull the plain email address out of a "Name <email>" string.
function parseAddress(from) {
  const m = String(from || "").match(/<([^>]+)>/);
  return (m ? m[1] : String(from || "")).trim().toLowerCase();
}

// Keep just the new reply, drop the quoted history most mail clients tack on below it.
function stripQuoted(text) {
  if (!text) return "";
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^>/.test(line)) break;
    if (/^On .+wrote:$/i.test(line.trim())) break;
    if (/^-{2,} ?Original Message ?-{2,}/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim() || text.trim();
}

// Webhook carries only an ID. Fetch the actual email (HTML, text, headers) from Resend.
async function getReceivedEmail(emailId) {
  const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${RESEND}` },
  });
  if (!r.ok) throw new Error(`Resend receiving ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sendEmail({ to, subject, text }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, text, ...(REPLY_TO ? { reply_to: REPLY_TO } : {}) }),
  });
  if (!r.ok) throw new Error(`Resend send ${r.status}: ${await r.text()}`);
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  try {
    let event = req.body;
    if (typeof event === "string") { try { event = JSON.parse(event); } catch { event = {}; } }

    // Only act on inbound email events. Acknowledge anything else so Resend stops retrying.
    if (!event || event.type !== "email.received") return res.status(200).json({ ok: true, ignored: true });
    const emailId = event.data && event.data.email_id;
    if (!emailId) return res.status(200).json({ ok: true, ignored: "no id" });

    // Fetch the real reply text using the id from the webhook.
    const email = await getReceivedEmail(emailId);
    const fromAddr = parseAddress(email.from || (event.data && event.data.from));
    const subject = email.subject || (event.data && event.data.subject) || "your goal";
    const message = stripQuoted(email.text || "");
    if (!fromAddr || !message) return res.status(200).json({ ok: true, ignored: "empty" });

    // Match the sender to a coach user. Strangers are ignored, so no AI call happens for them.
    const users = await sb(`coach_users?email=eq.${encodeURIComponent(fromAddr)}&select=*`);
    if (!users || !users.length) return res.status(200).json({ ok: true, ignored: "unknown sender" });
    const u = users[0];

    // Same context the page chat uses: goal, current plan, recent history.
    const plans = await sb(`coach_plans?user_id=eq.${u.id}&order=created_at.desc&limit=1&select=plan,week_number`);
    const currentPlan = plans && plans.length ? plans[0].plan : null;
    const prior = await sb(`coach_messages?user_id=eq.${u.id}&order=created_at.desc&limit=20&select=role,content`);
    const history = (prior || []).reverse().map((m) => ({ role: m.role === "coach" ? "assistant" : "user", content: m.content }));
    history.push({ role: "user", content: message });

    // Store the inbound message, tagged as coming from email so it joins the page thread.
    await sb("coach_messages", { method: "POST", body: { user_id: u.id, role: "user", content: message, channel: "email" } });

    const ctx = `${chatSystemPrompt()}
This person's current goal and plan. Use it to run the check-in:
Goal: ${u.goal}
Context they gave: ${u.context || "—"}
Current week: ${u.week_number}
${planSummary(currentPlan)}`;

    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system: ctx, messages: history }),
    });
    if (!ar.ok) throw new Error(`Anthropic ${ar.status}: ${await ar.text()}`);
    const d = await ar.json();
    const reply = (d.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n").trim();

    // Store and email the coach's reply back in the same thread.
    await sb("coach_messages", { method: "POST", body: { user_id: u.id, role: "coach", content: reply, channel: "email" } });
    await sendEmail({ to: fromAddr, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, text: reply });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    // Return 200 so Resend doesn't retry-storm while we debug. Errors are logged in Vercel.
    return res.status(200).json({ ok: false, error: "handled with error" });
  }
}
