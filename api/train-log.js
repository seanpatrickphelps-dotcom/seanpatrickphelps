// POST /api/train-log  (Authorization: Bearer <access_token>)
//   { action:"start",  day, bodyweight }
//   { action:"set",    session_id, exercise_id, set_number, load, reps, rir, seconds, pain_flag }
//   { action:"finish", session_id }
//   { action:"goal",   exercise_id, start_load, increment, goal_load, goal_reps, goal_date }
//   { action:"profile", display_name, goal_date, goal_bodyweight, start_bodyweight }
import { json, db, requireUser, ensureSeeded, suggest, historyByExercise } from "../lib/train.js";
import { PERSONA, VOICE } from "../lib/coach-kb.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  try {
    const user = await requireUser(req);
    await ensureSeeded(user.id);
    const b = req.body || {};
    const uid = user.id;

    if (b.action === "start") {
      const open = await db(`sessions?user_id=eq.${uid}&workout_day=eq.${Number(b.day)}&finished=eq.false&select=id&order=id.desc&limit=1`);
      if (open.length) {
        if (b.bodyweight) await db(`sessions?id=eq.${open[0].id}&user_id=eq.${uid}`, { method: "PATCH", body: { bodyweight: b.bodyweight }, prefer: "return=minimal" });
        return json(res, 200, { session_id: open[0].id, resumed: true });
      }
      const row = await db("sessions", { method: "POST", body: { user_id: uid, workout_day: Number(b.day), bodyweight: b.bodyweight || null } });
      return json(res, 200, { session_id: row[0].id });
    }

    if (b.action === "set") {
      const own = await db(`sessions?id=eq.${Number(b.session_id)}&user_id=eq.${uid}&select=id`);
      if (!own.length) return json(res, 403, { error: "Not your session." });
      const row = {
        user_id: uid, session_id: Number(b.session_id), exercise_id: Number(b.exercise_id), set_number: Number(b.set_number),
        load: num(b.load), reps: num(b.reps), rir: num(b.rir), seconds: num(b.seconds), pain_flag: !!b.pain_flag, logged_at: new Date().toISOString(),
      };
      await db("sets?on_conflict=session_id,exercise_id,set_number", { method: "POST", body: row, prefer: "resolution=merge-duplicates,return=minimal" });
      return json(res, 200, { ok: true });
    }

    if (b.action === "finish") {
      const sid = Number(b.session_id);
      const sess = (await db(`sessions?id=eq.${sid}&user_id=eq.${uid}&select=*`))[0];
      if (!sess) return json(res, 403, { error: "Not your session." });
      await db(`sessions?id=eq.${sid}`, { method: "PATCH", body: { finished: true }, prefer: "return=minimal" });

      const exercises = await db(`exercises?user_id=eq.${uid}&workout_day=eq.${sess.workout_day}&select=*&order=sort_order`);
      const ids = exercises.map((e) => e.id).join(",");
      const sets = await db(`sets?user_id=eq.${uid}&exercise_id=in.(${ids})&select=*,sessions(session_date,finished)&order=logged_at.desc&limit=400`);
      const hist = historyByExercise(sets.filter((s) => s.sessions?.finished));
      const next = exercises.map((ex) => ({ name: ex.name, ...suggest(ex, (hist[ex.id] || []).slice(0, 2)) }));
      const todays = sets.filter((s) => s.session_id === sid);

      const readout = await coachReadout(user, sess, exercises, todays, next);
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

// One short readout in the coach voice. Falls back to a plain summary if the API is unavailable.
async function coachReadout(user, sess, exercises, todays, next) {
  const lines = exercises.map((ex) => {
    const s = todays.filter((t) => t.exercise_id === ex.id).sort((a, b) => a.set_number - b.set_number);
    if (!s.length) return `${ex.name}: not logged`;
    return `${ex.name}: ` + s.map((t) => `${t.load ?? "bw"}x${t.reps ?? t.seconds + "s"}${t.rir != null ? " @RIR" + t.rir : ""}${t.pain_flag ? " PAIN" : ""}`).join(", ");
  });
  const paced = next.filter((n) => n.pace).map((n) => `${n.name}: ${n.pace.status} (${n.pace.now} vs ${n.pace.expected} expected, goal ${n.pace.goal} ${n.pace.unit}, ${n.pace.weeks_left} wks left)`);
  const fallback = `Session logged. ${paced.length ? paced.join(". ") + "." : ""} Next: ${next.slice(0, 3).map((n) => `${n.name} ${n.load ?? ""}${n.reps ? " x " + n.reps : ""}`).join("; ")}.`;
  if (!process.env.ANTHROPIC_API_KEY) return fallback;

  const prompt = `${PERSONA}

${VOICE}

You are reading out one strength session from the Phase II training block. The goal is us vs. the goal: the lifter and you against the number at the end of the block.
Today was Workout ${sess.workout_day}${sess.bodyweight ? `, bodyweight ${sess.bodyweight}` : ""}.
Sets logged:
${lines.join("\n")}
Pace against end goals:
${paced.join("\n") || "none tracked"}
Next session suggestions:
${next.map((n) => `${n.name}: ${n.load ?? "bodyweight"}${n.reps ? " x " + n.reps : ""}${n.seconds ? " for " + n.seconds + "s" : ""} (${n.status}: ${n.why})`).join("\n")}

Write three sentences, no more: what today earned, where the lifter stands against the goal, and the one thing to do next session. If any set has PAIN, the third sentence is about protecting it, not pushing.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.COACH_MODEL || "claude-sonnet-5", max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}
