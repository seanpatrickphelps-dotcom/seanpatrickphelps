// /lib/guardrails.js  (ESM — matches coach-start's export default)
// Input validation + rate limiting for the Accountability Coach.
// Lives outside /api so Vercel never routes it as an endpoint.

export const LIMITS = {
  name: 120,
  email: 254,
  goal: 2000,
  context: 4000,
  timeframe: 200,
};

// Per-day caps. A "plan" is one billed Claude generation.
export const RATE = {
  perEmailPerDay: 3,
  perIpPerDay: 8,
  windowSeconds: 24 * 60 * 60,
};

const clean = (s) => (typeof s === "string" ? s.trim() : "");
const looksLikeEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// Returns { ok, error } or { ok, fields }. Field names match coach_users.
export function validateIntake(b = {}) {
  const name = clean(b.name);
  const email = clean(b.email).toLowerCase();
  const goal = clean(b.goal);
  const context = clean(b.context);
  const timeframe = clean(b.timeframe);

  if (!email || email.length > LIMITS.email || !looksLikeEmail(email))
    return { ok: false, error: "Add a valid email to get started." };
  if (!goal) return { ok: false, error: "Add a goal to get started." };
  if (goal.length > LIMITS.goal)
    return { ok: false, error: `Keep your goal under ${LIMITS.goal} characters.` };
  if (context.length > LIMITS.context)
    return { ok: false, error: `Keep the context under ${LIMITS.context} characters.` };
  if (timeframe.length > LIMITS.timeframe)
    return { ok: false, error: "Keep the timeframe short." };
  if (name.length > LIMITS.name)
    return { ok: false, error: "That name is too long." };

  return { ok: true, fields: { name, email, goal, context, timeframe } };
}

export function getIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// Calls the hit_rate_limit Postgres function over Supabase REST.
// Pass your existing SUPABASE_URL and SUPABASE_SERVICE_KEY.
// Fails OPEN on any infra error so a Supabase hiccup never blocks a real
// user. Your Anthropic billing cap is the hard backstop behind this.
export async function checkRateLimit({ url, key }, { email, ip }) {
  const checks = [
    { bucket: `email:${email}`, max: RATE.perEmailPerDay },
    { bucket: `ip:${ip}`, max: RATE.perIpPerDay },
  ];

  for (const c of checks) {
    try {
      const r = await fetch(`${url}/rest/v1/rpc/hit_rate_limit`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_bucket: c.bucket,
          p_max: c.max,
          p_window_seconds: RATE.windowSeconds,
        }),
      });

      if (!r.ok) {
        console.error("rate_limit_http", c.bucket, r.status, await r.text());
        continue; // fail open
      }

      // PostgREST returns the scalar boolean; handle wrapped shapes too.
      let out = await r.json();
      if (Array.isArray(out)) out = out[0];
      const allowed =
        out && typeof out === "object" ? out.hit_rate_limit ?? Object.values(out)[0] : out;

      if (allowed === false) return { ok: false, retryAfterSeconds: RATE.windowSeconds };
    } catch (e) {
      console.error("rate_limit_error", c.bucket, e.message); // fail open
    }
  }

  return { ok: true };
}
