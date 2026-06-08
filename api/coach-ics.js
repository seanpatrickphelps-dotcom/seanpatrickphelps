// /api/coach-ics.js — returns a calendar file (.ics) with a daily reminder of
// the user's goal for the week. Linked from the plan email as "Add a daily
// reminder." Tapping it lets Apple, Google, or Outlook add a recurring reminder.

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

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

const pad = (n) => String(n).padStart(2, "0");
// Escape per the iCalendar spec: backslash, comma, semicolon, newline.
const ics = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\r?\n/g, "\\n");

function buildIcs({ goal, plan }) {
  let p = plan;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
  const focus = p && p.focus ? p.focus : goal;
  const actions = p && Array.isArray(p.actions) ? p.actions.map((a) => `- ${a.task}`).join("\n") : "";

  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  // Floating local time so the reminder fires at 8:00am on the person's own device.
  const startDate = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T080000`;
  const uid = `${Date.now()}-${Math.random().toString(16).slice(2)}@seanpatrickphelps.com`;

  const summary = ics(`Work your goal: ${focus}`);
  const description = ics(`Your goal: ${goal}\n\nThis week:\n${actions}\n\nReply to your coach email anytime to check in.`);

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sean Patrick Phelps//Accountability Coach//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${startDate}`,
    "DURATION:PT15M",
    "RRULE:FREQ=DAILY;COUNT=7",
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT0M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${summary}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export default async function handler(req, res) {
  try {
    const t = req.query && req.query.t ? String(req.query.t) : "";
    if (!t) return res.status(400).send("Missing token");

    const users = await sb(`coach_users?token=eq.${encodeURIComponent(t)}&select=id,goal`);
    if (!users || !users.length) return res.status(404).send("Not found");
    const u = users[0];

    const plans = await sb(`coach_plans?user_id=eq.${u.id}&order=created_at.desc&limit=1&select=plan`);
    const plan = plans && plans.length ? plans[0].plan : null;

    const body = buildIcs({ goal: u.goal, plan });
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="goal-reminder.ics"');
    return res.status(200).send(body);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Could not build the reminder.");
  }
}
