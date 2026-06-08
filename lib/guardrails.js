// lib/guardrails.js
// Shared input validation + rate limiting for the Accountability Coach.
// Lives outside /api so Vercel never treats it as an endpoint.

const LIMITS = {
  goal: 2000,
  context: 4000,
  email: 254,
  message: 4000, // reused by coach-chat / coach-inbound later
};

// Per-day caps. A "plan" is one expensive Claude generation.
const RATE = {
  perEmailPerDay: 3,
  perIpPerDay: 8,
  windowSeconds: 24 * 60 * 60,
};

function clean(str) {
  return typeof str === "string" ? str.trim() : "";
}

function looksLikeEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Validate the coach intake. Returns { ok, error } or { ok, fields }.
function validateIntake(body) {
  const goal = clean(body.goal);
  const context = clean(body.context);
  const email = clean(body.email).toLowerCase();

  if (!email) return { ok: false, error: "Email is required." };
  if (email.length > LIMITS.email || !looksLikeEmail(email))
    return { ok: false, error: "Please enter a valid email." };
  if (!goal) return { ok: false, error: "A goal is required." };
  if (goal.length > LIMITS.goal)
    return { ok: false, error: `Keep your goal under ${LIMITS.goal} characters.` };
  if (context.length > LIMITS.context)
    return { ok: false, error: `Keep the context under ${LIMITS.context} characters.` };

  return { ok: true, fields: { goal, context, email } };
}

function getIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// Checks the email bucket and the IP bucket. Returns { ok, retryAfterSeconds }.
// Fails OPEN on a DB error so a Supabase hiccup never blocks a real user.
// Your Anthropic billing cap is the hard backstop behind this.
async function checkRateLimit(supabase, { email, ip }) {
  const checks = [
    { bucket: `email:${email}`, max: RATE.perEmailPerDay },
    { bucket: `ip:${ip}`, max: RATE.perIpPerDay },
  ];

  for (const c of checks) {
    const { data, error } = await supabase.rpc("hit_rate_limit", {
      p_bucket: c.bucket,
      p_max: c.max,
      p_window_seconds: RATE.windowSeconds,
    });

    if (error) {
      console.error("rate_limit_error", c.bucket, error.message);
      continue; // fail open
    }
    if (data === false) {
      return { ok: false, retryAfterSeconds: RATE.windowSeconds };
    }
  }
  return { ok: true };
}

module.exports = { LIMITS, RATE, validateIntake, getIp, checkRateLimit };
