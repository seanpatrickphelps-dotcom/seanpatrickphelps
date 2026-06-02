// Vercel Serverless Function — receives a newsletter signup and adds the
// email to a Resend Audience. Runs server-side so your API key stays secret.
//
// Required environment variables (set in Vercel → Settings → Environment Variables):
//   RESEND_API_KEY      — your existing Resend API key
//   RESEND_AUDIENCE_ID  — the Audience to add subscribers to (create one in Resend → Audiences)

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
    const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    if (!valid) {
      return res.status(400).json({ ok: false, error: "Please enter a valid email." });
    }

    if (!process.env.RESEND_API_KEY || !process.env.RESEND_AUDIENCE_ID) {
      console.error("Missing RESEND_API_KEY or RESEND_AUDIENCE_ID");
      return res.status(500).json({ ok: false, error: "Server not configured yet." });
    }

    const resp = await fetch(
      `https://api.resend.com/audiences/${process.env.RESEND_AUDIENCE_ID}/contacts`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, unsubscribed: false }),
      }
    );

    // Resend returns 2xx on success. A duplicate is fine — treat it as success.
    if (resp.ok) {
      return res.status(200).json({ ok: true });
    }

    const detail = await resp.text();
    // If the contact already exists, Resend may return an error — still a "win".
    if (/already|exists|duplicate/i.test(detail)) {
      return res.status(200).json({ ok: true });
    }

    console.error("Resend error:", resp.status, detail);
    return res.status(502).json({ ok: false, error: "Couldn't add you right now — try again in a moment." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Something went wrong." });
  }
}
