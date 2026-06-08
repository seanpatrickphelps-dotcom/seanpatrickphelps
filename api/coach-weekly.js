// /api/coach-weekly.js — daily cron. Finds users about a week past their last
// touch and emails them "did you hit last week's goal?" Their reply is handled
// by coach-inbound, which runs the diagnostic. Vercel triggers this with a GET.
//
// Test mode: visit /api/coach-weekly?test=you@example.com to send yourself one
// check-in right now, ignoring the due check. (Disabled once CRON_SECRET is set,
// since a browser GET won't carry the secret.)

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND = process.env.RESEND_API_KEY;
const FROM = process.env.COACH_FROM_EMAIL || "Sean's Coach <coach@seanpatrickphelps.com>";
const REPLY_TO = process.env.COACH_REPLY_TO; // the address Resend receives replies on
const CRON_SECRET = process.env.CRON_SECRET; // optional; if set, required to run
const DUE_DAYS = 7;
const MAX_USERS = 300; // safety cap per run

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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

function askEmailHtml({ name, goal }) {
  return `<div style="background:#F3F1EA;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e7e4da;border-radius:14px;overflow:hidden">
    <div style="background:#17211F;padding:22px 28px;color:#F3F1EA">
      <div style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#347f9e">Weekly check-in</div>
      <div style="font-size:21px;margin-top:4px">How did last week go?</div>
    </div>
    <div style="padding:28px">
      <p style="color:#17211F;font-size:16px;margin:0 0 16px">Hey ${esc(name) || "there"}, quick check-in.</p>
      <p style="color:#26302e;font-size:16px;margin:0 0 18px"><strong>Last week your goal was:</strong> ${esc(goal)}</p>
      <p style="color:#26302e;font-size:15px;margin:0 0 18px">Did you hit it? Just reply to this email and tell me, yes or no, and a sentence on how it went. If you hit it, we set the next one. If you didn't, no judgment, we figure out why together and build this week around getting you a win.</p>
      <p style="color:#26302e;font-size:15px;margin:18px 0 0">Either way, we keep the loop going. — Sean</p>
    </div>
  </div></div>`;
}

async function sendEmail({ to, subject, html }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html, ...(REPLY_TO ? { reply_to: REPLY_TO } : {}) }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return r.json();
}

export default async function handler(req, res) {
  // If CRON_SECRET is set, require it. Vercel sends it as "Authorization: Bearer <secret>".
  if (CRON_SECRET) {
    const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (provided !== CRON_SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    // TEST MODE: send one check-in to a specific address, skip the due check.
    const testTo = req.query && req.query.test ? String(req.query.test).trim().toLowerCase() : "";
    if (testTo) {
      const found = await sb(`coach_users?email=eq.${encodeURIComponent(testTo)}&select=name,goal&limit=1`);
      const user = found && found.length ? found[0] : { name: "", goal: "your goal" };
      await sendEmail({ to: testTo, subject: "Last week's goal, how did it go?", html: askEmailHtml(user) });
      return res.status(200).json({ ok: true, mode: "test", sentTo: testTo });
    }

    // NORMAL RUN: find active users who haven't been touched in DUE_DAYS.
    const users = await sb(`coach_users?status=eq.active&select=id,email,name,goal&limit=${MAX_USERS}`);
    const cutoff = Date.now() - DUE_DAYS * 24 * 60 * 60 * 1000;
    let asked = 0;
    let skipped = 0;

    for (const u of users || []) {
      try {
        const plans = await sb(`coach_plans?user_id=eq.${u.id}&order=created_at.desc&limit=1&select=created_at`);
        const weeklies = await sb(`coach_messages?user_id=eq.${u.id}&channel=eq.weekly&order=created_at.desc&limit=1&select=created_at`);
        const times = [];
        if (plans && plans[0]) times.push(new Date(plans[0].created_at).getTime());
        if (weeklies && weeklies[0]) times.push(new Date(weeklies[0].created_at).getTime());
        if (!times.length) { skipped++; continue; } // never had a plan, nothing to check in on
        if (Math.max(...times) > cutoff) { skipped++; continue; } // touched within the last week

        await sendEmail({ to: u.email, subject: "Last week's goal, how did it go?", html: askEmailHtml(u) });
        await sb("coach_messages", {
          method: "POST",
          body: { user_id: u.id, role: "coach", channel: "weekly", content: `Weekly check-in sent: did you hit your goal? (${u.goal})` },
        });
        asked++;
      } catch (perUser) {
        console.error("weekly user error", u.email, perUser.message);
      }
    }

    return res.status(200).json({ ok: true, mode: "run", asked, skipped });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "weekly run failed" });
  }
}
