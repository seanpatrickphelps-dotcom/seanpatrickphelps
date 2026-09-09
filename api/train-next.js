// GET /api/train-next?day=1   -> today's prescription for that day, prehab, readiness-adjusted, plus deload check
// GET /api/train-next?board=1 -> dashboard and trend scoreboard for every exercise with a goal
// Header: Authorization: Bearer <access_token>
import { json, db, requireUser, ensureSeeded, suggest, applyToday, scoreboard, deloadCheck, historyByExercise, readiness, sessionStats, PREHAB } from "../lib/train.js";

export default async function handler(req, res) {
  try {
    const user = await requireUser(req);
    await ensureSeeded(user.id);
    const uid = user.id;
    const day = Number(req.query.day || 0);
    const board = req.query.board === "1";
    const today = new Date().toISOString().slice(0, 10);

    const all = await db(`exercises?user_id=eq.${uid}&select=*&order=workout_day,sort_order`);
    const sets = await db(`sets?user_id=eq.${uid}&select=*,sessions(session_date,finished)&order=logged_at.desc&limit=1500`);
    const hist = historyByExercise(sets.filter((s) => s.sessions?.finished));
    const sessions = await db(`sessions?user_id=eq.${uid}&select=*&order=session_date.desc,id.desc&limit=30`);
    const profile = (await db(`profiles?user_id=eq.${uid}&select=*`))[0] || null;
    const lastBw = sessions.find((s) => s.bodyweight)?.bodyweight ?? profile?.start_bodyweight ?? null;
    const byName = (n) => all.find((e) => e.name === n);
    const strengthBench = hist[byName("Barbell Bench Press")?.id] || [];

    // Deload: primaries plus readiness history
    const primaries = all.filter((e) => e.kind === "primary").map((ex) => ({ ex, hist: hist[ex.id] || [] }));
    const deload = deloadCheck(primaries, sessions.filter((s) => s.finished));

    // Dashboard
    const startDate = all.map((e) => e.start_date).filter(Boolean).sort()[0] || today;
    const week = Math.min(16, Math.max(1, Math.floor((new Date(today) - new Date(startDate)) / 6048e5) + 1));
    const card = (n) => { const ex = byName(n); return ex ? scoreboard(ex, hist[ex.id] || [], lastBw) : null; };
    const todaySets = sets.filter((s) => s.sessions?.session_date === today);
    const dashboard = {
      week, weeks: 16, body: { start: profile?.start_bodyweight ?? null, now: lastBw, goal: profile?.goal_bodyweight ?? 225 },
      bench: card("Barbell Bench Press"), pullups: card("Pull-Up"), pushups: card("Push-Ups"), rdl: card("Romanian Deadlift"),
      pain_today: todaySets.length ? Math.max(0, ...todaySets.map((s) => Number(s.pain || 0))) : null,
    };

    if (board) {
      const cards = all.filter((e) => e.goal_load || e.goal_reps).map((ex) => scoreboard(ex, hist[ex.id] || [], lastBw));
      return json(res, 200, { user: { id: uid, email: user.email }, profile, last_bodyweight: lastBw, dashboard, cards, deload, exercises: all });
    }

    const exercises = all.filter((e) => e.workout_day === day);
    const open = sessions.find((s) => s.workout_day === day && !s.finished) || null;
    const ready = open ? readiness(open.sleep, open.energy, open.soreness) : null;
    const suggestions = exercises.map((ex) => {
      const s = suggest(ex, (hist[ex.id] || []).slice(0, 3), { strengthBench });
      return open ? applyToday(s, ex, ready.level, open.deload) : s;
    });
    return json(res, 200, { user: { id: uid, email: user.email }, profile, last_bodyweight: lastBw, dashboard, deload, prehab: PREHAB[day] || null, open_session: open, readiness: ready, exercises, suggestions });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
