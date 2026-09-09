// GET /api/train-next?day=1     -> exercises for that day with suggested load/reps and pace
// GET /api/train-next?board=1   -> every exercise that has a goal, with pace (the scoreboard)
// Header: Authorization: Bearer <access_token>
import { json, db, requireUser, ensureSeeded, suggest, historyByExercise } from "../lib/train.js";

export default async function handler(req, res) {
  try {
    const user = await requireUser(req);
    await ensureSeeded(user.id);
    const day = Number(req.query.day || 0);
    const board = req.query.board === "1";

    const filter = board ? `or=(goal_load.not.is.null,goal_reps.not.is.null)` : `workout_day=eq.${day}`;
    const exercises = await db(`exercises?user_id=eq.${user.id}&${filter}&select=*&order=workout_day,sort_order`);
    if (!exercises.length) return json(res, 200, { exercises: [], suggestions: [] });

    const ids = exercises.map((e) => e.id).join(",");
    const sets = await db(`sets?user_id=eq.${user.id}&exercise_id=in.(${ids})&select=*,sessions(session_date,finished)&order=logged_at.desc&limit=400`);
    const hist = historyByExercise(sets.filter((s) => s.sessions?.finished));

    const suggestions = exercises.map((ex) => {
      const h = (hist[ex.id] || []).slice(0, 2);
      const s = suggest(ex, h);
      s.last = h[0] ? { date: h[0].session_date, sets: h[0].sets.map(({ load, reps, rir, seconds, pain_flag }) => ({ load, reps, rir, seconds, pain_flag })) } : null;
      return s;
    });

    const profile = (await db(`profiles?user_id=eq.${user.id}&select=*`))[0] || null;
    const lastBw = (await db(`sessions?user_id=eq.${user.id}&bodyweight=not.is.null&select=bodyweight,session_date&order=session_date.desc&limit=1`))[0] || null;
    const open = day ? (await db(`sessions?user_id=eq.${user.id}&workout_day=eq.${day}&finished=eq.false&select=id,session_date&order=id.desc&limit=1`))[0] || null : null;

    return json(res, 200, { user: { id: user.id, email: user.email }, profile, last_bodyweight: lastBw, open_session: open, exercises, suggestions });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
