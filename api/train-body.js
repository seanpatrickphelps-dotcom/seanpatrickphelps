// POST /api/train-body  (Authorization: Bearer <access_token>)
//   { action:"save", scan_date, ...fields }  -> { scan, scans, physique }
//   { action:"extract", image, media_type }  -> { ok, fields } or a note to type the scan
// Extract never writes. The person confirms the form before save.
import { json, db, requireUser, ensureSeeded, normalizeScan, requestScanExtract, physiqueView, SCAN_KEY_MESSAGE, bodyMigrationError, SCAN_FIELDS } from "../lib/train.js";

const KEY = process.env.ANTHROPIC_API_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  try {
    const user = await requireUser(req);
    await ensureSeeded(user.id);
    const b = req.body || {};
    const uid = user.id;

    if (b.action === "extract") {
      if (!KEY) return json(res, 200, { ok: false, message: SCAN_KEY_MESSAGE });
      const result = await requestScanExtract({ apiKey: KEY, image: b.image, mediaType: b.media_type });
      if (!result.ok) return json(res, 200, { ok: false, message: result.message });
      return json(res, 200, { ok: true, fields: result.fields });
    }

    if (b.action === "save") {
      let row;
      try { row = normalizeScan(b); }
      catch (e) { return json(res, e.status || 400, { error: e.message }); }
      try {
        const saved = await db("body_scans?on_conflict=user_id,scan_date", {
          method: "POST",
          body: { user_id: uid, ...row },
          prefer: "resolution=merge-duplicates,return=representation",
        });
        const scans = await db(`body_scans?user_id=eq.${uid}&select=*&order=scan_date.asc`) || [];
        const profile = (await db(`profiles?user_id=eq.${uid}&select=*`))[0] || null;
        const latest = (await db(`weigh_ins?user_id=eq.${uid}&select=log_date,pounds&order=log_date.desc&limit=1`))[0] || null;
        const scan = (saved && saved[0]) || scans.find((s) => String(s.scan_date).slice(0, 10) === row.scan_date) || { ...row };
        return json(res, 200, { scan: shapeScan(scan), scans: scans.map(shapeScan), physique: physiqueView({ profile, scans, latestWeighIn: latest }) });
      } catch (e) {
        const msg = bodyMigrationError(e);
        if (msg) return json(res, 400, { error: msg });
        throw e;
      }
    }

    return json(res, 400, { error: "Unknown action." });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}

function shapeScan(row) {
  const out = { id: row.id, scan_date: String(row.scan_date).slice(0, 10), source: row.source || "starfit", notes: row.notes || "" };
  for (const k of SCAN_FIELDS) out[k] = row[k] == null ? null : Number(row[k]);
  return out;
}
