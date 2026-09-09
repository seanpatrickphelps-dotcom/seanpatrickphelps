// POST { action: "signup" | "login", email, password }
// Returns { access_token, user } on success. Uses SUPABASE_ANON_KEY for auth calls.
import { json } from "../lib/train.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  const { action, email, password } = req.body || {};
  if (!email || !password) return json(res, 400, { error: "Email and password required." });
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!key) return json(res, 500, { error: "SUPABASE_ANON_KEY is not set." });

  const url = action === "signup" ? `${base}/auth/v1/signup` : `${base}/auth/v1/token?grant_type=password`;
  const r = await fetch(url, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await r.json();
  if (!r.ok) return json(res, r.status, { error: data.msg || data.error_description || data.error || "Auth failed." });
  // Signup with email confirmation on returns a user but no session; tell the client.
  if (!data.access_token) return json(res, 200, { needs_confirmation: true, user: data.user || data });
  return json(res, 200, { access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
}
