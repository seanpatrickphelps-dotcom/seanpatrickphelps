// Shared helpers for the Phase II training log.

const URL_ = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;

export function json(res, status, body) {
  res.setHeader("Content-Type", "application/json");
  res.status(status).send(JSON.stringify(body));
}

// ---------- Supabase REST (service key, we filter by user_id ourselves) ----------
export async function db(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      Prefer: prefer || (method === "GET" ? "" : "return=representation"),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ---------- Auth: verify the user's JWT, return the user ----------
export async function requireUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) throw Object.assign(new Error("Sign in first."), { status: 401 });
  const r = await fetch(`${URL_}/auth/v1/user`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw Object.assign(new Error("Session expired. Sign in again."), { status: 401 });
  return r.json(); // { id, email, ... }
}

// ---------- First login: copy the template into the user's own exercises ----------
export async function ensureSeeded(userId) {
  const existing = await db(`exercises?user_id=eq.${userId}&select=id&limit=1`);
  if (existing.length) return;
  const tpl = await db(`exercise_templates?select=*&order=workout_day,sort_order`);
  const goalDate = defaultGoalDate();
  const rows = tpl.map((t) => ({
    user_id: userId, template_id: t.id, workout_day: t.workout_day, sort_order: t.sort_order,
    name: t.name, rule: t.rule, sets: t.sets, rep_low: t.rep_low, rep_high: t.rep_high,
    start_load: t.start_load, start_reps: t.rep_low, increment: t.increment,
    goal_load: t.goal_load, goal_reps: t.goal_reps, goal_date: t.goal_load || t.goal_reps ? goalDate : null, note: t.note,
  }));
  await db("exercises", { method: "POST", body: rows, prefer: "return=minimal" });
  await db("profiles", { method: "POST", body: { user_id: userId, goal_date: goalDate }, prefer: "resolution=ignore-duplicates,return=minimal" });
}

function defaultGoalDate() {
  const d = new Date(); d.setDate(d.getDate() + 16 * 7);
  return d.toISOString().slice(0, 10);
}

// ---------- Progression engine ----------
export const epley = (load, reps) => (!load || !reps) ? 0 : reps === 1 ? Number(load) : load * (1 + reps / 30);
const roundTo = (x, unit) => unit ? Math.round(x / unit) * unit : Math.round(x);

// sessionsForEx: array of { session_date, sets:[{load,reps,rir,seconds,pain_flag}] }, newest first
export function suggest(ex, sessionsForEx, today = new Date()) {
  const inc = Number(ex.increment) || 5;
  const out = { exercise_id: ex.id, load: null, reps: null, seconds: null, status: "start", why: "" };

  if (!sessionsForEx.length) {
    out.load = ex.start_load; out.reps = ex.rep_low;
    if (ex.rule === "carry") out.seconds = ex.rep_low;
    out.why = "First session. Start where the plan starts and log every set.";
    return withPace(ex, out, null, today);
  }

  const last = sessionsForEx[0];
  const prev = sessionsForEx[1];
  const sets = last.sets.filter((s) => s.reps != null || s.seconds != null);
  const pain = sets.some((s) => s.pain_flag);
  const lastLoad = maxNum(sets.map((s) => s.load)) ?? ex.start_load;
  const minReps = minNum(sets.map((s) => s.reps));
  const minSecs = minNum(sets.map((s) => s.seconds));
  const enough = sets.length >= ex.sets;
  const hitTop = enough && minReps != null && minReps >= ex.rep_high;
  const hitLow = enough && minReps != null && minReps >= ex.rep_low;
  const prevMissed = prev ? !(prev.sets.length >= ex.sets && (minNum(prev.sets.map((s) => s.reps)) ?? 0) >= ex.rep_low) : false;

  if (pain) {
    out.load = lastLoad; out.reps = ex.rep_low; out.status = "frozen";
    out.why = "Pain flag last session. Same load, one week freeze on progression.";
    return withPace(ex, out, last, today);
  }

  if (ex.rule === "linear") {
    if (hitTop) { out.load = roundTo(lastLoad + inc, inc); out.reps = ex.rep_high; out.status = "up"; out.why = `All ${ex.sets} sets clean at ${lastLoad}. Add ${inc}.`; }
    else if (!hitLow && prevMissed) { out.load = roundTo(lastLoad * 0.95, inc); out.reps = ex.rep_low; out.status = "reset"; out.why = "Missed two sessions in a row. Drop five percent and rebuild."; }
    else if (!hitLow) { out.load = lastLoad; out.reps = ex.rep_low; out.status = "repeat"; out.why = `Missed a set at ${lastLoad}. Repeat it and own every rep.`; }
    else { out.load = lastLoad; out.reps = ex.rep_high; out.status = "repeat"; out.why = `Hit ${ex.rep_low}s but not ${ex.rep_high}s. Same load, chase the top of the range.`; }
  } else if (ex.rule === "double") {
    if (hitTop) { out.load = roundTo(lastLoad + inc, inc); out.reps = ex.rep_low; out.status = "up"; out.why = `Every set hit ${ex.rep_high}. Add ${inc} and reset to ${ex.rep_low}s.`; }
    else { out.load = lastLoad; out.reps = Math.min(ex.rep_high, (minReps ?? ex.rep_low) + 1); out.status = "reps"; out.why = `Same load. Beat last week: at least ${out.reps} on every set.`; }
  } else if (ex.rule === "bodyweight") {
    const target = ex.goal_reps || ex.rep_high;
    out.reps = Math.min(target, (minReps ?? ex.rep_low) + 1); out.status = "reps";
    out.why = `Bodyweight. Aim for ${out.reps} on every set, two reps in reserve.`;
  } else if (ex.rule === "carry") {
    const hitSecs = enough && minSecs != null && minSecs >= ex.rep_high;
    if (hitSecs) { out.load = roundTo(lastLoad + inc, inc); out.seconds = ex.rep_low; out.status = "up"; out.why = `Held ${ex.rep_high} seconds on every set. Add ${inc}.`; }
    else { out.load = lastLoad; out.seconds = Math.min(ex.rep_high, (minSecs ?? ex.rep_low) + 5); out.status = "reps"; out.why = `Same load. Hold ${out.seconds} seconds every set.`; }
  }

  // Guardrail: never more than a five percent jump, whatever the math says.
  if (out.load != null && lastLoad && out.load > lastLoad * 1.05) out.load = roundTo(lastLoad * 1.05, inc);
  return withPace(ex, out, last, today);
}

// Pace against the end goal, in estimated one-rep max, linear from start to goal date.
function withPace(ex, out, last, today) {
  if (!ex.goal_date || (!ex.goal_load && !ex.goal_reps)) return out;
  const start = new Date(ex.start_date || today), goal = new Date(ex.goal_date);
  const total = Math.max(1, (goal - start) / 864e5), elapsed = Math.min(total, Math.max(0, (today - start) / 864e5));
  const frac = elapsed / total;
  let now, startV, goalV, unit;
  if (ex.rule === "bodyweight") {
    unit = "reps"; startV = ex.start_reps || ex.rep_low; goalV = ex.goal_reps;
    now = last ? minNum(last.sets.map((s) => s.reps)) : startV;
  } else if (ex.rule === "carry") {
    unit = "lb x sec"; startV = (ex.start_load || 0) * ex.rep_low; goalV = (ex.goal_load || ex.start_load) * (ex.goal_reps || ex.rep_high);
    now = last ? maxNum(last.sets.map((s) => (s.load || 0) * (s.seconds || 0))) : startV;
  } else {
    unit = "e1RM"; startV = epley(ex.start_load, ex.start_reps || ex.rep_low); goalV = epley(ex.goal_load, ex.goal_reps || 1);
    now = last ? maxNum(last.sets.map((s) => epley(s.load, s.reps))) : startV;
  }
  if (now == null) now = startV;
  const expected = startV + (goalV - startV) * frac;
  const tol = 0.03 * Math.max(1, Math.abs(goalV));
  out.pace = {
    unit, now: round1(now), expected: round1(expected), goal: round1(goalV),
    weeks_left: Math.round(((goal - today) / 864e5 / 7) * 10) / 10,
    status: now > expected + tol ? "ahead" : now < expected - tol ? "behind" : "on pace",
  };
  return out;
}

const round1 = (x) => Math.round(x * 10) / 10;
const maxNum = (a) => { const v = a.filter((x) => x != null).map(Number); return v.length ? Math.max(...v) : null; };
const minNum = (a) => { const v = a.filter((x) => x != null).map(Number); return v.length ? Math.min(...v) : null; };

// Group a flat list of sets (joined with session_date) into per-exercise session history, newest first.
export function historyByExercise(sets) {
  const byEx = {};
  for (const s of sets) {
    const k = s.exercise_id; byEx[k] ||= {};
    const sk = s.session_id; byEx[k][sk] ||= { session_id: sk, session_date: s.sessions?.session_date, sets: [] };
    byEx[k][sk].sets.push(s);
  }
  const out = {};
  for (const k in byEx) out[k] = Object.values(byEx[k]).sort((a, b) => (a.session_date < b.session_date ? 1 : -1));
  return out;
}
