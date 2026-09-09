// Shared helpers for the Phase II training log, V2.
// Principle: reward successful training, not heavier training. Completing the prescription with
// RIR, symmetry, and no pain earns progression. Poor recovery earns restraint. Pain earns modification.

const URL_ = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;

export function json(res, status, body) {
  res.setHeader("Content-Type", "application/json");
  res.status(status).send(JSON.stringify(body));
}

export async function db(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", Prefer: prefer || (method === "GET" ? "" : "return=representation") },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function requireUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) throw Object.assign(new Error("Sign in first."), { status: 401 });
  const r = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: `Bearer ${token}` } });
  if (!r.ok) throw Object.assign(new Error("Session expired. Sign in again."), { status: 401 });
  return r.json();
}

export async function ensureSeeded(userId) {
  const existing = await db(`exercises?user_id=eq.${userId}&select=id&limit=1`);
  if (existing.length) return;
  const tpl = await db(`exercise_templates?select=*&order=workout_day,sort_order`);
  const goalDate = defaultGoalDate();
  const rows = tpl.map((t) => ({
    user_id: userId, template_id: t.id, workout_day: t.workout_day, sort_order: t.sort_order, name: t.name, rule: t.rule, kind: t.kind,
    unilateral: t.unilateral, heavy_offset: t.heavy_offset, subordinate_to: t.subordinate_to,
    sets: t.sets, rep_low: t.rep_low, rep_high: t.rep_high, start_load: t.start_load, start_reps: t.rep_low, increment: t.increment,
    goal_load: t.goal_load, goal_reps: t.goal_reps, goal_date: t.goal_load || t.goal_reps ? goalDate : null, note: t.note,
  }));
  await db("exercises", { method: "POST", body: rows, prefer: "return=minimal" });
  await db("profiles", { method: "POST", body: { user_id: userId, goal_date: goalDate }, prefer: "resolution=ignore-duplicates,return=minimal" });
}
function defaultGoalDate() { const d = new Date(); d.setDate(d.getDate() + 16 * 7); return d.toISOString().slice(0, 10); }

// ---------- pre-hab checklists and the joints each day watches ----------
export const PREHAB = {
  1: { title: "PREP · SHOULDER", joints: ["shoulder"], items: ["External rotation 2 x 15 per side", "Face pull 2 x 15", "Scapular push-up 2 x 10", "Dead hang 2 x 20-30 sec", "Push-up 1 x 10, controlled"] },
  2: { title: "PREP · SHOULDER AND TRUNK", joints: ["shoulder"], items: ["Dead hang 2 x 20-30 sec", "Band pull-apart 2 x 15", "Y-T-W raises 1 x 8 each", "Bird dog 2 x 6 per side, slow"] },
  3: { title: "PREP · HIP AND QUAD", joints: ["quad", "hip flexor"], items: ["90/90 hip switches 2 x 8", "Half-kneeling hip flexor 2 x 30 sec per side", "Glute bridge 2 x 12", "Bodyweight squat 2 x 8, pain-free depth", "Spanish squat or wall sit 3 x 20-30 sec"] },
  4: { title: "PREP · SHOULDER", joints: ["shoulder"], items: ["External rotation 2 x 15 per side", "Wall slide 2 x 10", "Scapular push-up 2 x 10", "Face pull 2 x 15", "Y raise 2 x 10"] },
  5: { title: "PREP · MOVEMENT", joints: ["shoulder", "quad"], items: ["90/90 hip switch x 8", "World's greatest stretch x 5 per side", "Band pull-apart x 15", "Scapular pull-up x 8", "Glute bridge x 15", "Bird dog x 6 per side"] },
};

// ---------- math ----------
export const epley = (load, reps) => (!load || !reps) ? 0 : Number(reps) === 1 ? Number(load) : Number(load) * (1 + Number(reps) / 30);
const roundTo = (x, unit) => unit ? Math.round(x / unit) * unit : Math.round(x);
const r1 = (x) => Math.round(x * 10) / 10;
const nums = (a) => a.filter((x) => x != null && x !== "").map(Number);
const max = (a) => (nums(a).length ? Math.max(...nums(a)) : null);
const min = (a) => (nums(a).length ? Math.min(...nums(a)) : null);
const avg = (a) => (nums(a).length ? nums(a).reduce((s, x) => s + x, 0) / nums(a).length : null);

// ---------- readiness ----------
export function readiness(sleep, energy, soreness) {
  if (!sleep || !energy || !soreness) return { score: null, level: "green", label: "TRAIN", note: "No check-in. Normal prescription." };
  const score = Number(sleep) + Number(energy) + (6 - Number(soreness));
  if (score >= 12) return { score, level: "green", label: "TRAIN", note: "Normal prescription." };
  if (score >= 9) return { score, level: "yellow", label: "HOLD", note: "Use the planned weights. Nothing goes up today." };
  return { score, level: "red", label: "RECOVERY", note: "Primary lifts about 10 percent lighter, one accessory set fewer. You decide." };
}

// ---------- per-session stats for one exercise ----------
export function sessionStats(ex, sets) {
  const work = sets.filter((s) => (s.set_kind || "work") === "work" && (s.reps != null || s.seconds != null));
  const heavy = sets.filter((s) => s.set_kind === "heavy");
  const bench = sets.filter((s) => s.set_kind === "benchmark");
  const sides = ex.unilateral ? 2 : 1;
  const prescribedReps = ex.sets * ex.rep_low * sides;
  const repsDone = work.reduce((s, x) => s + (x.completed === false ? 0 : Number(x.reps || 0)), 0);
  const stat = {
    sets: work.length, prescribed_sets: ex.sets * sides,
    load: max(work.map((s) => s.load)), reps: work.map((s) => s.reps), secs: work.map((s) => s.seconds),
    min_reps: min(work.map((s) => s.reps)), min_secs: min(work.map((s) => s.seconds)),
    avg_rir: avg(work.map((s) => s.rir)), max_pain: max(sets.map((s) => s.pain)) ?? 0,
    reps_missed: Math.max(0, prescribedReps - repsDone),
    e1rm: max(work.map((s) => epley(s.load, s.reps))) || 0,
    volume: work.reduce((s, x) => s + Number(x.load || 0) * Number(x.reps || 0), 0),
    best_set: work.reduce((b, s) => (Number(s.reps || 0) > Number(b?.reps || 0) ? s : b), null),
    total_reps: repsDone,
    heavy: heavy.length ? { load: max(heavy.map((s) => s.load)), reps: max(heavy.map((s) => s.reps)), rir: avg(heavy.map((s) => s.rir)) } : null,
    benchmark: bench.length ? max(bench.map((s) => s.reps)) : null,
    unassisted: max(work.filter((s) => !s.assist_load).map((s) => s.reps)),
    assist: min(work.filter((s) => s.assist_load).map((s) => s.assist_load)),
  };
  if (ex.unilateral) {
    const L = work.filter((s) => s.side === "L"), R = work.filter((s) => s.side === "R");
    const val = (arr) => ex.kind === "carry" ? max(arr.map((s) => Number(s.load || 0) * Number(s.seconds || 0))) : min(arr.map((s) => s.reps));
    stat.left = val(L); stat.right = val(R);
    stat.asymmetry = stat.left && stat.right ? r1(Math.abs(stat.left - stat.right) / Math.max(stat.left, stat.right) * 100) : null;
    stat.weak_reps = min(work.map((s) => s.reps));
    stat.weak_secs = min(work.map((s) => s.seconds));
  }
  if (ex.kind === "carry") stat.score = ex.unilateral ? min([stat.left, stat.right]) : max(work.map((s) => Number(s.load || 0) * Number(s.seconds || 0)));
  return stat;
}

// Traffic light for the last exposure of a loaded lift. Pain overrides everything.
function light(ex, st) {
  if (st.max_pain >= 3) return ["red", `Pain ${st.max_pain}/5 last session. PAIN HOLD.`];
  if (st.sets < st.prescribed_sets) return ["red", `Only ${st.sets} of ${st.prescribed_sets} sets logged last session.`];
  if (st.reps_missed > 2) return ["red", `Missed ${st.reps_missed} prescribed reps last session.`];
  if (st.reps_missed > 0) return ["yellow", `Completed ${st.total_reps} of ${st.prescribed_sets * ex.rep_low} prescribed reps.`];
  if (st.max_pain === 2) return ["yellow", "Pain 2/5 last session. Comfortable, but nothing goes up."];
  if (st.avg_rir != null && st.avg_rir < 1) return ["yellow", `Average RIR ${r1(st.avg_rir)}. That was a grind, repeat it cleaner.`];
  return ["green", `Completed ${st.prescribed_sets} x ${ex.rep_low} with ${st.avg_rir != null ? "average RIR " + r1(st.avg_rir) : "reps in reserve"} and pain ${st.max_pain}.`];
}

// ---------- the suggestion ----------
// hist: [{session_date, sets:[...]}] newest first, finished sessions only.
// ctx.strengthBench: history of the Workout 1 bench, used by the volume-bench rule.
export function suggest(ex, hist, ctx = {}) {
  const inc = Number(ex.increment) || 5;
  const out = { exercise_id: ex.id, name: ex.name, kind: ex.kind, unilateral: !!ex.unilateral, load: null, reps: null, seconds: null, sets: ex.sets, status: "start", light: "green", why: "", heavy: null, last: null };
  const stats = hist.map((h) => sessionStats(ex, h.sets));
  const st = stats[0], prev = stats[1];
  out.last = st ? { date: hist[0].session_date, ...pick(st, ["load", "reps", "secs", "avg_rir", "max_pain", "e1rm", "heavy", "left", "right", "asymmetry", "score", "unassisted", "assist", "benchmark", "total_reps"]) } : null;

  if (!st) {
    out.load = ex.start_load; out.reps = ex.rep_low; if (ex.kind === "carry") out.seconds = ex.rep_low;
    out.why = "First exposure. Start where the plan starts and log every working set.";
    if (ex.heavy_offset && out.load) out.heavy = { load: Number(out.load) + Number(ex.heavy_offset), reps: "2-3", note: "Never a grind. RIR 1 to 2." };
    if (ex.kind === "bodyweight") out.benchmark_due = false;
    return out;
  }
  const lastLoad = st.load ?? ex.start_load;

  if (ex.kind === "primary" || ex.kind === "volume") {
    const [lt, reason] = light(ex, st);
    out.light = lt;
    if (lt === "green") { out.load = roundTo(lastLoad + inc, inc); out.reps = ex.rep_low; out.status = "progress"; out.why = `${reason} Phase II ${ex.kind === "volume" ? "volume" : "strength"} progression adds ${inc} lb.`; }
    else if (lt === "yellow") { out.load = lastLoad; out.reps = ex.rep_low; out.status = "repeat"; out.why = `${reason} Repeating ${lastLoad}.`; }
    else {
      const prevBad = prev && light(ex, prev)[0] !== "green";
      out.load = roundTo(lastLoad * (st.max_pain >= 3 ? 0.9 : 0.925), inc); out.reps = ex.rep_low; out.status = st.max_pain >= 3 ? "pain_hold" : "reduce";
      out.why = `${reason}${prevBad ? " Second miss in a row." : ""} Reducing to ${out.load}.`;
    }
    if (ex.heavy_offset) out.heavy = { load: Number(out.load) + Number(ex.heavy_offset), reps: "2-3", note: "Heavy exposure, RIR 1 to 2. It does not decide the 4 x 4." };
    if (ex.kind === "volume" && ctx.strengthBench?.length >= 3 && out.status === "progress") {
      const e = ctx.strengthBench.slice(0, 3).map((h) => sessionStats({ ...ex, unilateral: false }, h.sets).e1rm);
      if (e[0] < e[1] && e[1] < e[2]) { out.load = lastLoad; out.status = "hold"; out.light = "yellow"; out.why = "Strength bench has slipped two exposures in a row. Holding volume bench one week so Monday recovers."; }
    }
  } else if (ex.kind === "double") {
    const reps = ex.unilateral ? st.weak_reps : st.min_reps;
    const full = st.sets >= st.prescribed_sets;
    if (st.max_pain >= 3) { out.load = lastLoad; out.reps = ex.rep_low; out.status = "pain_hold"; out.light = "red"; out.why = `Pain ${st.max_pain}/5. PAIN HOLD at ${lastLoad}, and stop it if it climbs.`; }
    else if (full && reps != null && reps >= ex.rep_high && (st.avg_rir == null || st.avg_rir >= 1) && st.max_pain <= 1) {
      out.load = roundTo(lastLoad + inc, inc); out.reps = ex.rep_low; out.status = "progress"; out.why = `Every set hit ${ex.rep_high} with RIR and no pain. Up ${inc}, build back to ${ex.rep_high}s.`;
    } else if (st.max_pain === 2) { out.load = lastLoad; out.reps = reps ?? ex.rep_low; out.status = "hold"; out.light = "yellow"; out.why = `Holding at ${lastLoad} because pain was 2/5.`; }
    else { out.load = lastLoad; out.reps = Math.min(ex.rep_high, (reps ?? ex.rep_low) + 1); out.status = "reps"; out.why = `Same ${lastLoad}. Beat last time: at least ${out.reps} on every set${ex.unilateral ? ", weak side first" : ""}.`; }
    if (ex.unilateral && st.asymmetry != null && st.asymmetry > 10) out.why += ` Asymmetry ${st.asymmetry}%: the strong side matches the weak side's reps, not the other way round.`;
  } else if (ex.kind === "bodyweight") {
    const goal = ex.goal_reps || ex.rep_high;
    const base = st.unassisted ?? st.min_reps ?? ex.rep_low;
    if (st.max_pain >= 3) { out.reps = base; out.status = "pain_hold"; out.light = "red"; out.why = `Pain ${st.max_pain}/5. PAIN HOLD, same reps or skip.`; }
    else { out.reps = Math.min(goal, base + 1); out.status = "reps"; out.why = `Best clean set last time ${base}${st.assist ? `, assisted ${st.assist}` : ""}. Aim for ${out.reps} per set, two in reserve.`; }
    out.benchmark_due = benchmarkDue(hist);
  } else if (ex.kind === "carry") {
    const secs = ex.unilateral ? st.weak_secs : st.min_secs;
    if (st.max_pain >= 3) { out.load = lastLoad; out.seconds = secs; out.status = "pain_hold"; out.light = "red"; out.why = `Pain ${st.max_pain}/5. PAIN HOLD.`; }
    else if (st.sets >= st.prescribed_sets && secs != null && secs >= ex.rep_high && st.max_pain <= 1) { out.load = roundTo(lastLoad + inc, inc); out.seconds = ex.rep_low; out.status = "progress"; out.why = `Held ${ex.rep_high} sec on every set${ex.unilateral ? ", both sides" : ""}. Up ${inc} lb.`; }
    else { out.load = lastLoad; out.seconds = Math.min(ex.rep_high, (secs ?? ex.rep_low) + 5); out.status = "reps"; out.why = `Same ${lastLoad} lb. Hold ${out.seconds} sec every set${ex.unilateral ? "; the weaker side sets the number" : ""}.`; }
  }
  if (out.load != null && lastLoad && out.load > lastLoad * 1.05) out.load = roundTo(lastLoad * 1.05, inc);
  return out;
}

function benchmarkDue(hist) {
  const lastB = hist.find((h) => h.sets.some((s) => s.set_kind === "benchmark"));
  if (!lastB) return hist.length >= 3;
  return (Date.now() - new Date(lastB.session_date)) / 864e5 >= 28;
}

// Today's adjustment from readiness or an accepted deload, applied on top of the suggestion.
export function applyToday(s, ex, level, deload) {
  const inc = Number(ex.increment) || 5;
  if (deload) {
    if (s.load != null && (ex.kind === "primary" || ex.kind === "volume")) s.load = roundTo(s.load * 0.9, inc);
    s.sets = ex.kind === "double" ? Math.max(1, Math.round(ex.sets * 0.5)) : Math.max(1, Math.round(ex.sets * 2 / 3));
    if (s.heavy) s.heavy = null;
    s.today = "DELOAD: lighter, fewer sets, nothing to failure."; s.status = "deload"; return s;
  }
  if (level === "yellow" && s.status === "progress") { s.load = s.last?.load ?? s.load; if (s.heavy) s.heavy.load = Number(s.load) + Number(ex.heavy_offset || 0); s.status = "hold"; s.light = "yellow"; s.today = "Readiness HOLD: planned weight, no increase today."; }
  if (level === "red") {
    if (s.load != null && (ex.kind === "primary" || ex.kind === "volume")) { s.load = roundTo((s.last?.load ?? s.load) * 0.9, inc); s.status = "hold"; if (s.heavy) s.heavy = null; }
    if (ex.kind === "double") s.sets = Math.max(1, ex.sets - 1);
    s.light = "red"; s.today = "Readiness RECOVERY: primary lifts 10 percent lighter, one accessory set fewer.";
  }
  return s;
}

// ---------- scoreboard: trend, not a straight line ----------
export function scoreboard(ex, hist, bodyweight) {
  const stats = hist.map((h) => ({ date: h.session_date, ...sessionStats(ex, h.sets) }));
  const card = { exercise_id: ex.id, name: ex.name, kind: ex.kind, goal_load: ex.goal_load, goal_reps: ex.goal_reps, goal_date: ex.goal_date, status: "BUILDING", exposures: stats.length, series: [] };
  const painHold = stats[0] && stats[0].max_pain >= 3;
  if (ex.kind === "bodyweight") {
    const series = stats.map((s) => s.benchmark ?? s.unassisted ?? s.min_reps).filter((x) => x != null);
    card.unit = "reps"; card.now = series[0] ?? ex.start_reps ?? 0; card.start = series.at(-1) ?? ex.start_reps ?? 0; card.goal = ex.goal_reps;
    card.best_actual = stats.map((s) => s.benchmark).filter((x) => x != null)[0] ?? null;
    card.best_label = card.best_actual != null ? `${card.best_actual} max, benchmarked` : null;
    card.total_last = stats[0]?.total_reps ?? null;
    card.series = series.slice(0, 4).reverse();
  } else if (ex.kind === "carry") {
    const goalLoad = ex.goal_load || bodyweight || 225;
    card.unit = "lb x sec"; card.goal = goalLoad * (ex.goal_reps || 60); card.goal_label = `${goalLoad} lb x ${ex.goal_reps || 60} sec`;
    const series = stats.map((s) => s.score).filter((x) => x != null);
    card.now = series[0] ?? 0; card.start = series.at(-1) ?? 0; card.series = series.slice(0, 4).reverse();
    card.now_label = stats[0] ? `${stats[0].load} lb x ${max(stats[0].secs)} sec` : null;
  } else {
    card.unit = "e1RM";
    const series = stats.map((s) => r1(s.e1rm)).filter((x) => x > 0);
    card.start = series.at(-1) ?? r1(epley(ex.start_load, ex.start_reps || ex.rep_low));
    card.now = series[0] ?? card.start; card.series = series.slice(0, 4).reverse();
    card.goal = ex.goal_load ? r1(epley(ex.goal_load, ex.goal_reps || 1)) : null;
    let best = null;
    for (const s of stats) {
      const c = [];
      if (s.heavy?.load) c.push({ load: s.heavy.load, reps: s.heavy.reps });
      if (s.best_set) c.push({ load: s.load, reps: s.best_set.reps });
      for (const x of c) if (!best || Number(x.load) > Number(best.load) || (Number(x.load) === Number(best.load) && Number(x.reps) > Number(best.reps))) best = x;
    }
    card.best_actual = best ? `${best.load} x ${best.reps}` : null;
    card.best_label = best ? `${best.load} x ${best.reps}, actually lifted` : null;
    if (ex.goal_load) { const steps = []; for (let m = Number(ex.goal_load); m > (best ? Number(best.load) : 0); m -= 10) steps.unshift(m); card.milestones = steps.slice(0, 5); card.next_milestone = steps[0] ?? null; }
  }
  card.change_pct = card.start ? r1((card.now - card.start) / card.start * 100) : null;
  const s0 = stats[0], s1 = stats[1];
  const loaded = ex.kind === "primary" || ex.kind === "volume";
  if (painHold) card.status = "REHAB";
  else if (s0 && (s0.max_pain === 2 || (loaded && s1 && light(ex, s0)[0] !== "green" && light(ex, s1)[0] !== "green"))) card.status = "HOLD";
  else if (card.series.length < 3) card.status = card.series.length >= 2 && card.series.at(-1) > card.series.at(-2) ? "TRENDING UP" : "BUILDING";
  else if (ex.goal_date && card.goal) {
    const xs = card.series.map((_, i) => i), ys = card.series;
    const mx = avg(xs), my = avg(ys);
    const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / (xs.reduce((s, x) => s + (x - mx) ** 2, 0) || 1);
    const weeksLeft = Math.max(0, (new Date(ex.goal_date) - Date.now()) / 6048e5);
    const projected = card.now + slope * weeksLeft;
    card.projected = r1(projected);
    card.status = projected >= card.goal * 1.05 ? "AHEAD" : projected >= card.goal * 0.95 ? "ON PACE" : slope > 0 ? "TRENDING UP" : "HOLD";
  } else card.status = card.series.at(-1) > card.series.at(-2) ? "TRENDING UP" : "HOLD";
  return card;
}

// ---------- deload triggers: recommend when two or more fire ----------
export function deloadCheck(primaries, recentSessions) {
  const reasons = [];
  for (const { ex, hist } of primaries) {
    const st = hist.slice(0, 3).map((h) => sessionStats(ex, h.sets));
    if (st.length >= 2 && light(ex, st[0])[0] !== "green" && light(ex, st[1])[0] !== "green") reasons.push(`${ex.name} underperformed twice`);
    if (st.length >= 2 && st[0].avg_rir != null && st[1].avg_rir != null && st[0].avg_rir < st[1].avg_rir - 1) reasons.push(`${ex.name} RIR dropped`);
    if (st.length >= 2 && st[0].max_pain >= 2 && st[0].max_pain > st[1].max_pain) reasons.push(`${ex.name} pain rising`);
    if (st.length >= 3 && st[0].e1rm > 0 && st[0].e1rm < st[2].e1rm * 0.95) reasons.push(`${ex.name} e1RM down more than 5%`);
  }
  const rs = recentSessions.filter((s) => s.sleep).slice(0, 5);
  if (rs.length >= 3) {
    const r = rs.map((s) => readiness(s.sleep, s.energy, s.soreness).score);
    if (avg(r) < 9) reasons.push("readiness averaging low");
    if (avg(rs.map((s) => s.sleep)) <= 2) reasons.push("sleep consistently poor");
    if (avg(rs.map((s) => s.soreness)) >= 4) reasons.push("soreness staying high");
  }
  return { recommended: reasons.length >= 2, reasons };
}

// ---------- history grouping ----------
export function historyByExercise(sets) {
  const byEx = {};
  for (const s of sets) {
    const k = s.exercise_id; byEx[k] ||= {};
    const sk = s.session_id; byEx[k][sk] ||= { session_id: sk, session_date: s.sessions?.session_date, sets: [] };
    byEx[k][sk].sets.push(s);
  }
  const out = {};
  for (const k in byEx) out[k] = Object.values(byEx[k]).sort((a, b) => (a.session_date < b.session_date ? 1 : a.session_date > b.session_date ? -1 : b.session_id - a.session_id));
  return out;
}
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
