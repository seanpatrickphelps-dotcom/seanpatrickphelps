// POST /api/train-log  (Authorization: Bearer <access_token>)
//   { action:"start",  day, bodyweight, sleep, energy, soreness, deload }        -> { session_id, readiness }
//   { action:"set",    session_id, exercise_id, set_number, side, set_kind, load, reps, rir, seconds, pain, assist_load, completed } -> { ok }
//   { action:"prehab", session_id, prehab_done, pain_before, pain_after }        -> { ok }
//   { action:"finish", session_id }                                              -> { readout, next }
//   { action:"goal",   exercise_id, start_load, start_reps, increment, goal_load, goal_reps, goal_date } -> { ok }
//   { action:"profile", display_name, goal_date, goal_bodyweight, start_bodyweight, target_calories, target_protein, target_carbs, target_fat } -> { ok }
//   { action:"swap",   session_id, planned_exercise_id, replacement_name|null }  -> { suggestion }
//   { action:"nutrition", date, calories, protein, carbs, fat }                  -> { nutrition }
import { json, db, requireUser, ensureSeeded, suggest, historyByExercise, readiness, sessionStats, buildSlotSuggestion, substitutionOptions, normalizeName, replacementKind, cleanMacro, migrationError, saveSetRow } from "../lib/train.js";
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
      // sets_unique_v2 rejects a second insert for the same slot. Update in place,
      // and if a concurrent Complete set already inserted, patch that row.
      await saveSetRow(db, row);
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
      const exercises = all.filter((e) => e.workout_day === sess.workout_day && !e.is_library);
      const sets = await db(`sets?user_id=eq.${uid}&select=*,sessions(session_date,finished)&order=logged_at.desc&limit=1500`);
      const hist = historyByExercise(sets.filter((s) => s.sessions?.finished));
      const strengthBench = hist[all.find((e) => e.name === "Barbell Bench Press" && !e.is_library)?.id] || [];
      const next = exercises.map((ex) => suggest(ex, (hist[ex.id] || []).slice(0, 3), { strengthBench }));
      let swaps = [];
      try { swaps = await db(`session_swaps?user_id=eq.${uid}&session_id=eq.${sid}&select=planned_exercise_id,replacement_exercise_id`); }
      catch (e) { const msg = migrationError(e); if (!msg) throw e; }
      const byId = Object.fromEntries(all.map((e) => [e.id, e]));
      const todays = exercises.map((ex) => {
        const sw = swaps.find((s) => s.planned_exercise_id === ex.id);
        const performed = sw && byId[sw.replacement_exercise_id] ? byId[sw.replacement_exercise_id] : ex;
        return {
          ex, performed,
          st: sessionStats(performed, sets.filter((s) => s.session_id === sid && s.exercise_id === performed.id)),
          own: performed.id === ex.id ? null : sessionStats(ex, sets.filter((s) => s.session_id === sid && s.exercise_id === ex.id)),
        };
      });
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
      const targetKeys = ["target_calories", "target_protein", "target_carbs", "target_fat", "target_hydration_oz"];
      let targets = null;
      if (targetKeys.some((k) => b[k] !== undefined)) {
        targets = {};
        for (const k of targetKeys) if (b[k] !== undefined) targets[k] = cleanMacro(b[k]);
      }
      const patch = { user_id: uid };
      for (const k of ["display_name", "goal_date", "goal_bodyweight", "start_bodyweight"]) if (b[k] !== undefined) patch[k] = b[k] === "" ? null : b[k];
      await db("profiles?on_conflict=user_id", { method: "POST", body: patch, prefer: "resolution=merge-duplicates,return=minimal" });
      if (targets) {
        try {
          await db("profiles?on_conflict=user_id", { method: "POST", body: { user_id: uid, ...targets }, prefer: "resolution=merge-duplicates,return=minimal" });
        } catch (e) {
          const msg = migrationError(e);
          const anyValue = Object.values(targets).some((v) => v != null);
          if (msg && !anyValue) return json(res, 200, { ok: true });
          if (msg) return json(res, 400, { error: "Body goals saved. " + msg });
          throw e;
        }
      }
      return json(res, 200, { ok: true });
    }

    if (b.action === "nutrition") {
      const date = String(b.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date) return json(res, 400, { error: "Date must be YYYY-MM-DD." });
      const row = { user_id: uid, log_date: date, calories: cleanMacro(b.calories), protein: cleanMacro(b.protein), carbs: cleanMacro(b.carbs), fat: cleanMacro(b.fat), updated_at: new Date().toISOString() };
      try {
        if ([row.calories, row.protein, row.carbs, row.fat].every((v) => v == null)) {
          await db(`nutrition_logs?user_id=eq.${uid}&log_date=eq.${date}`, { method: "DELETE", prefer: "return=minimal" });
          return json(res, 200, { ok: true, nutrition: null });
        }
        const saved = await db("nutrition_logs?on_conflict=user_id,log_date", { method: "POST", body: row, prefer: "resolution=merge-duplicates,return=representation" });
        const n = saved?.[0] || row;
        return json(res, 200, { ok: true, nutrition: { log_date: n.log_date, calories: n.calories, protein: n.protein, carbs: n.carbs, fat: n.fat } });
      } catch (e) {
        const msg = migrationError(e);
        if (msg) return json(res, 400, { error: msg });
        throw e;
      }
    }

    if (b.action === "swap") {
      const sid = Number(b.session_id);
      const pid = Number(b.planned_exercise_id);
      const sess = (await db(`sessions?id=eq.${sid}&user_id=eq.${uid}&select=*`))[0];
      if (!sess) return json(res, 403, { error: "Not your session." });
      if (sess.finished) return json(res, 400, { error: "This session is already finished." });
      const planned = (await db(`exercises?id=eq.${pid}&user_id=eq.${uid}&select=*`))[0];
      if (!planned || planned.is_library || Number(planned.workout_day) !== Number(sess.workout_day)) return json(res, 400, { error: "That exercise is not on this session." });
      const undo = b.replacement_name == null || String(b.replacement_name).trim() === "";
      try {
        if (undo) {
          await db(`session_swaps?user_id=eq.${uid}&session_id=eq.${sid}&planned_exercise_id=eq.${pid}`, { method: "DELETE", prefer: "return=minimal" });
          const suggestion = await slotSuggestion(uid, sess, planned, null);
          return json(res, 200, { ok: true, suggestion });
        }
        const option = substitutionOptions(planned.name).options.find((o) => normalizeName(o.name) === normalizeName(b.replacement_name));
        if (!option) return json(res, 400, { error: substitutionOptions(planned.name).note || "That is not a substitute for this exercise." });
        const repl = await ensureReplacement(uid, planned, option);
        if (repl.id === planned.id) return json(res, 400, { error: "That is already the planned exercise." });
        const existing = await db(`session_swaps?user_id=eq.${uid}&session_id=eq.${sid}&planned_exercise_id=eq.${pid}&select=id`);
        if (existing.length) await db(`session_swaps?id=eq.${existing[0].id}&user_id=eq.${uid}`, { method: "PATCH", body: { replacement_exercise_id: repl.id }, prefer: "return=minimal" });
        else {
          try { await db("session_swaps", { method: "POST", body: { user_id: uid, session_id: sid, planned_exercise_id: pid, replacement_exercise_id: repl.id }, prefer: "return=minimal" }); }
          catch (e) {
            if (!/23505|duplicate key/i.test(String(e.message))) throw e;
            await db(`session_swaps?user_id=eq.${uid}&session_id=eq.${sid}&planned_exercise_id=eq.${pid}`, { method: "PATCH", body: { replacement_exercise_id: repl.id }, prefer: "return=minimal" });
          }
        }
        const suggestion = await slotSuggestion(uid, sess, planned, repl);
        return json(res, 200, { ok: true, suggestion });
      } catch (e) {
        const msg = migrationError(e);
        if (msg) return json(res, 400, { error: msg });
        throw e;
      }
    }

    return json(res, 400, { error: "Unknown action." });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}

const num = (v) => (v === "" || v == null ? null : Number(v));
async function own(uid, sid) { return (await db(`sessions?id=eq.${Number(sid)}&user_id=eq.${uid}&select=id`)).length > 0; }

function setLine(ex, st) {
  return st.sets ? `${ex.name}: ${st.load ?? "bw"} x ${st.reps.join("/")}${st.avg_rir != null ? ", avg RIR " + Math.round(st.avg_rir * 10) / 10 : ""}, pain ${st.max_pain}${st.heavy ? `, heavy ${st.heavy.load} x ${st.heavy.reps}` : ""}${st.asymmetry != null ? `, L/R gap ${st.asymmetry}%` : ""}` : `${ex.name}: not logged`;
}

async function slotSuggestion(uid, sess, planned, replacement) {
  const all = await db(`exercises?user_id=eq.${uid}&select=*&order=workout_day,sort_order`);
  const sets = await db(`sets?user_id=eq.${uid}&select=*,sessions(session_date,finished)&order=logged_at.desc&limit=1500`);
  const hist = historyByExercise(sets.filter((s) => s.sessions?.finished));
  const strengthBench = hist[all.find((e) => e.name === "Barbell Bench Press" && !e.is_library)?.id] || [];
  const todayAdj = { level: readiness(sess.sleep, sess.energy, sess.soreness).level, deload: !!sess.deload };
  return buildSlotSuggestion(planned, (hist[planned.id] || []).slice(0, 3), { strengthBench }, todayAdj, replacement, replacement ? (hist[replacement.id] || []).slice(0, 3) : []);
}

async function ensureReplacement(uid, planned, option) {
  const all = await db(`exercises?user_id=eq.${uid}&select=*&order=workout_day,sort_order`);
  const want = normalizeName(option.name);
  const matches = all.filter((e) => normalizeName(e.name) === want);
  const existing = matches.find((e) => !e.is_library) || matches[0];
  if (existing) return existing;
  const row = {
    user_id: uid, template_id: null, workout_day: null, sort_order: 900, name: option.name,
    kind: replacementKind(option, planned), unilateral: !!option.unilateral, heavy_offset: null, subordinate_to: null,
    sets: planned.sets, rep_low: planned.rep_low, rep_high: planned.rep_high, start_load: null, start_reps: planned.rep_low,
    increment: planned.increment ?? 5, goal_load: null, goal_reps: null, goal_date: null, is_library: true,
    note: `Session substitute for ${planned.name}. Not part of the seeded plan.`,
  };
  if (planned.rule != null) row.rule = planned.rule;
  const created = await db("exercises", { method: "POST", body: row });
  return created[0];
}

async function coachReadout(sess, todays, next) {
  const lines = todays.map(({ ex, performed, st, own }) => {
    const line = setLine(performed || ex, st);
    if (!performed || performed.id === ex.id) return line;
    const also = own?.sets ? ` Also on ${ex.name}: ${setLine(ex, own).replace(ex.name + ": ", "")}` : "";
    return `${line} (in place of ${ex.name}, this session only.)${also}`;
  });
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
