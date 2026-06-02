// Vercel Serverless Function — newsletter signup → Resend Audience.
// Runs server-side so your API key stays secret.
//
// Required environment variable (Vercel → Settings → Environment Variables):
//   RESEND_API_KEY      — your Resend key (must be "Full access", not sending-only)
//
// Optional:
//   RESEND_AUDIENCE_ID  — a specific audience. If you leave this out, the function
//                         automatically uses your account's default (first) audience,
//                         so you don't have to hunt for the ID.

const RESEND = "https://api.resend.com";

async function resolveAudienceId(key) {
  if (process.env.RESEND_AUDIENCE_ID) return process.env.RESEND_AUDIENCE_ID;
  const r = await fetch(`${RESEND}/audiences`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  const list = (j && j.data) || [];
  return list.length ? list[0].id : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const email = ((body && body.email) || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: "Please enter a valid email." });
    }

    const key = process.env.RESEND_API_KEY;
    if (!key) {
      console.error("Missing RESEND_API_KEY");
      return res.status(500).json({ ok: false, error: "Server not configured yet." });
    }

    const audienceId = await resolveAudienceId(key);
    if (!audienceId) {
      console.error("No audience found. Create one in Resend, or set RESEND_AUDIENCE_ID.");
      return res.status(500).json({ ok: false, error: "No audience configured yet." });
    }

    const resp = await fetch(`${RESEND}/audiences/${audienceId}/contacts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, unsubscribed: false }),
    });

    if (resp.ok) return res.status(200).json({ ok: true });

    const detail = await resp.text();
    if (/already|exists|duplicate/i.test(detail)) {
      return res.status(200).json({ ok: true }); // already subscribed = success
    }

    console.error("Resend error:", resp.status, detail);
    return res.status(502).json({ ok: false, error: "Couldn't add you right now — try again in a moment." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Something went wrong." });
  }
}
