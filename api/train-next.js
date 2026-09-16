// GET /api/train-next?day=1   -> today's prescription for that day, prehab, readiness-adjusted, plus deload check
// GET /api/train-next?board=1 -> dashboard and trend scoreboard for every exercise with a goal
// Header: Authorization: Bearer <access_token>
import { json, db, requireUser, ensureSeeded, suggest, applyToday, scoreboard, deloadCheck, historyByExercise, readiness, sessionStats, PREHAB } from "../lib/train.js";

// Consecutive planned sessions finished without missing two in a row (Rule 07: never miss twice).
function streakOf(sessions) {
  const done = sessions.filter((s) => s.finished).map((s) => s.session_date).sort().reverse();
  if (!done.length) return { count: 0, last: null };
  const uniq = [...new Set(done)];
  let count = 1;
  for (let i = 1; i < uniq.length; i++) {
    const gap = (new Date(uniq[i - 1]) - new Date(uniq[i])) / 864e5;
    if (gap <= 4) count++; else break;   // a normal week has gaps of 1 to 3 days; 4+ breaks it
  }
  return { count, last: uniq[0] };
}

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
      const openAny = sessions.find((s) => !s.finished) || null;
      return json(res, 200, { user: { id: uid, email: user.email }, profile, last_bodyweight: lastBw, dashboard, cards, deload, exercises: all, open_session: openAny, streak: streakOf(sessions) });
    }

    // Calendar: every session in a month, one line each.
    if (req.query.month) {
      const [y, m] = String(req.query.month).split("-").map(Number);
      const from = `${y}-${String(m).padStart(2, "0")}-01`;
      const to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
      const rows = await db(`sessions?user_id=eq.${uid}&session_date=gte.${from}&session_date=lt.${to}&select=id,workout_day,session_date,bodyweight,finished,readiness,deload&order=session_date`);
      const ids = rows.map((r) => r.id);
      const counts = {};
      if (ids.length) {
        const ss = await db(`sets?user_id=eq.${uid}&session_id=in.(${ids.join(",")})&select=session_id,pain,load,reps`);
        for (const x of ss) {
          const c = (counts[x.session_id] ||= { sets: 0, pain: 0, volume: 0 });
          c.sets++; c.pain = Math.max(c.pain, Number(x.pain || 0)); c.volume += Number(x.load || 0) * Number(x.reps || 0);
        }
      }
      return json(res, 200, { month: `${y}-${String(m).padStart(2, "0")}`, days: rows.map((r) => ({ ...r, ...(counts[r.id] || { sets: 0, pain: 0, volume: 0 }) })), streak: streakOf(sessions) });
    }

    // One past session, with every set grouped by exercise.
    if (req.query.session) {
      const sid = Number(req.query.session);
      const sess = (await db(`sessions?id=eq.${sid}&user_id=eq.${uid}&select=*`))[0];
      if (!sess) return json(res, 404, { error: "Session not found." });
      const ss = await db(`sets?user_id=eq.${uid}&session_id=eq.${sid}&select=*&order=exercise_id,set_number`);
      const exs = all.filter((e) => e.workout_day === sess.workout_day);
      const detail = exs.map((ex) => {
        const mine = ss.filter((x) => x.exercise_id === ex.id);
        return mine.length ? { name: ex.name, kind: ex.kind, unilateral: ex.unilateral, sets: mine.map(({ set_number, side, set_kind, load, reps, rir, seconds, pain, assist_load }) => ({ set_number, side, set_kind, load, reps, rir, seconds, pain, assist_load })), stats: sessionStats(ex, mine) } : null;
      }).filter(Boolean);
      return json(res, 200, { session: sess, detail });
    }

    const exercises = all.filter((e) => e.workout_day === day);
    const open = sessions.find((s) => s.workout_day === day && !s.finished) || null;
    const ready = open ? readiness(open.sleep, open.energy, open.soreness) : null;
    const suggestions = exercises.map((ex) => {
      const s = suggest(ex, (hist[ex.id] || []).slice(0, 3), { strengthBench });
      return open ? applyToday(s, ex, ready.level, open.deload) : s;
    });
    const logged = open ? sets.filter((s) => s.session_id === open.id).map(({ exercise_id, set_number, side, set_kind, load, reps, rir, seconds, pain, assist_load }) => ({ exercise_id, set_number, side, set_kind, load, reps, rir, seconds, pain, assist_load })) : [];
    return json(res, 200, { user: { id: uid, email: user.email }, profile, last_bodyweight: lastBw, dashboard, deload, prehab: PREHAB[day] || null, open_session: open, readiness: ready, exercises, suggestions, logged });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
