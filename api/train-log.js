// POST /api/train-log  (Authorization: Bearer <access_token>)
//   { action:"start",  day, bodyweight, sleep, energy, soreness, deload }        -> { session_id, readiness }
//   { action:"set",    session_id, exercise_id, set_number, side, set_kind, load, reps, rir, seconds, pain, assist_load, completed } -> { ok }
//   { action:"prehab", session_id, prehab_done, pain_before, pain_after }        -> { ok }
//   { action:"finish", session_id }                                              -> { readout, next }
//   { action:"goal",   exercise_id, start_load, start_reps, increment, goal_load, goal_reps, goal_date } -> { ok }
//   { action:"profile", display_name, goal_date, goal_bodyweight, start_bodyweight } -> { ok }
import { json, db, requireUser, ensureSeeded, suggest, historyByExercise, readiness, sessionStats } from "../lib/train.js";
import { PERSONA, VOICE } from "../lib/coach-kb.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  try {
    const user = await requireUser(req);
    await ensureSeeded(user.id);
    const b = req.body || {};
    const uid = user.id;

    if (b.action === "start") {
      const patch = { bodyweight: num(b.bodyweight), sleep: num(b.sleep), energy: num(b.energy), soreness: num(b.soreness), deload: !!b.deload };
      patch.readiness = readiness(patch.sleep, patch.energy, patch.soreness).level;
      const open = await db(`sessions?user_id=eq.${uid}&workout_day=eq.${Number(b.day)}&finished=eq.false&select=id&order=id.desc&limit=1`);
      let sid;
      if (open.length) { sid = open[0].id; await db(`sessions?id=eq.${sid}&user_id=eq.${uid}`, { method: "PATCH", body: patch, prefer: "return=minimal" }); }
      else { const row = await db("sessions", { method: "POST", body: { user_id: uid, workout_day: Number(b.day), ...patch } }); sid = row[0].id; }
      return json(res, 200, { session_id: sid, resumed: !!open.length, readiness: readiness(patch.sleep, patch.energy, patch.soreness) });
    }

    if (b.action === "set") {
      if (!(await own(uid, b.session_id))) return json(res, 403, { error: "Not your session." });
      const row = {
        user_id: uid, session_id: Number(b.session_id), exercise_id: Number(b.exercise_id), set_number: Number(b.set_number),
        side: b.side || null, set_kind: b.set_kind || "work",
        load: num(b.load), reps: num(b.reps), rir: num(b.rir), seconds: num(b.seconds), pain: num(b.pain) ?? 0, pain_flag: (num(b.pain) ?? 0) >= 3,
        assist_load: num(b.assist_load), completed: b.completed !== false, logged_at: new Date().toISOString(),
      };
      // Upsert on the V2 key: delete any existing row for this slot, then insert.
      await db(`sets?session_id=eq.${row.session_id}&exercise_id=eq.${row.exercise_id}&set_number=eq.${row.set_number}&set_kind=eq.${row.set_kind}&side=${row.side ? "eq." + row.side : "is.null"}`, { method: "DELETE", prefer: "return=minimal" });
      await db("sets", { method: "POST", body: row, prefer: "return=minimal" });
      return json(res, 200, { ok: true });
    }

    if (b.action === "prehab") {
      if (!(await own(uid, b.session_id))) return json(res, 403, { error: "Not your session." });
      const patch = {};
      if (b.prehab_done !== undefined) patch.prehab_done = !!b.prehab_done;
      if (b.pain_before !== undefined) patch.pain_before = b.pain_before;
      if (b.pain_after !== undefined) patch.pain_after = b.pain_after;
      await db(`sessions?id=eq.${Number(b.session_id)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
      return json(res, 200, { ok: true });
    }

    if (b.action === "finish") {
      const sid = Number(b.session_id);
      const sess = (await db(`sessions?id=eq.${sid}&user_id=eq.${uid}&select=*`))[0];
      if (!sess) return json(res, 403, { error: "Not your session." });
      await db(`sessions?id=eq.${sid}`, { method: "PATCH", body: { finished: true }, prefer: "return=minimal" });
      const all = await db(`exercises?user_id=eq.${uid}&select=*&order=workout_day,sort_order`);
      const exercises = all.filter((e) => e.workout_day === sess.workout_day);
      const sets = await db(`sets?user_id=eq.${uid}&select=*,sessions(session_date,finished)&order=logged_at.desc&limit=1500`);
      const hist = historyByExercise(sets.filter((s) => s.sessions?.finished));
      const strengthBench = hist[all.find((e) => e.name === "Barbell Bench Press")?.id] || [];
      const next = exercises.map((ex) => suggest(ex, (hist[ex.id] || []).slice(0, 3), { strengthBench }));
      const todays = exercises.map((ex) => ({ ex, st: sessionStats(ex, sets.filter((s) => s.session_id === sid && s.exercise_id === ex.id)) }));
      const readout = await coachReadout(sess, todays, next);
      await db(`sessions?id=eq.${sid}`, { method: "PATCH", body: { readout }, prefer: "return=minimal" });
      return json(res, 200, { readout, next });
    }

    if (b.action === "goal") {
      const patch = {};
      for (const k of ["start_load", "start_reps", "increment", "goal_load", "goal_reps", "goal_date", "start_date"]) if (b[k] !== undefined) patch[k] = b[k] === "" ? null : b[k];
      await db(`exercises?id=eq.${Number(b.exercise_id)}&user_id=eq.${uid}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
      return json(res, 200, { ok: true });
    }

    if (b.action === "profile") {
      const patch = { user_id: uid };
      for (const k of ["display_name", "goal_date", "goal_bodyweight", "start_bodyweight"]) if (b[k] !== undefined) patch[k] = b[k] === "" ? null : b[k];
      await db("profiles?on_conflict=user_id", { method: "POST", body: patch, prefer: "resolution=merge-duplicates,return=minimal" });
      return json(res, 200, { ok: true });
    }

    return json(res, 400, { error: "Unknown action." });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}

const num = (v) => (v === "" || v == null ? null : Number(v));
async function own(uid, sid) { return (await db(`sessions?id=eq.${Number(sid)}&user_id=eq.${uid}&select=id`)).length > 0; }

async function coachReadout(sess, todays, next) {
  const lines = todays.map(({ ex, st }) => st.sets ? `${ex.name}: ${st.load ?? "bw"} x ${st.reps.join("/")}${st.avg_rir != null ? ", avg RIR " + Math.round(st.avg_rir * 10) / 10 : ""}, pain ${st.max_pain}${st.heavy ? `, heavy ${st.heavy.load} x ${st.heavy.reps}` : ""}${st.asymmetry != null ? `, L/R gap ${st.asymmetry}%` : ""}` : `${ex.name}: not logged`);
  const ready = readiness(sess.sleep, sess.energy, sess.soreness);
  const nextLines = next.map((n) => `${n.name}: ${n.load ?? "bodyweight"}${n.reps ? " x " + n.reps : ""}${n.seconds ? " for " + n.seconds + "s" : ""} (${n.status}: ${n.why})`);
  const fallback = `Session logged. Next: ${next.slice(0, 3).map((n) => `${n.name} ${n.load ?? ""}${n.reps ? " x " + n.reps : ""}`).join("; ")}.`;
  if (!process.env.ANTHROPIC_API_KEY) return fallback;
  const prompt = `${PERSONA}

${VOICE}

You are reading out one strength session from the Phase II training block. Us vs. the goal: you and the lifter against the number at the end of the block. Reward successful training, not heavier training.
Workout ${sess.workout_day}${sess.bodyweight ? `, bodyweight ${sess.bodyweight}` : ""}. Readiness ${ready.label}${ready.score ? ` (${ready.score}/15)` : ""}${sess.deload ? ", deload week" : ""}.
Pain before: ${JSON.stringify(sess.pain_before || {})}. Pain after: ${JSON.stringify(sess.pain_after || {})}.
Sets logged:
${lines.join("\n")}
Next session:
${nextLines.join("\n")}

Write three sentences, no more: what today earned, the one thing that decides next session, and one line of perspective. If any pain is 3 or higher, the second sentence is about protecting it, not pushing. If a left/right gap is over 10 percent, mention symmetry. Never call an estimated number a lift that actually happened.`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.COACH_MODEL || "claude-sonnet-5", max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    return text || fallback;
  } catch { return fallback; }
}
