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
  // Any existing row means this user already has a program. Return immediately.
  // Never update, delete, or copy templates over a list that is already there.
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

// ---------- session substitutes ----------
// A curated map from movement pattern to two or three replacements. The seeded
// program is never edited. A swap is only a suggestion list plus, once chosen,
// a row in session_swaps. Names are matched loosely so the Phase II catalog is
// covered without copying it into this file. An exercise that does not share a
// pattern gets an empty list and a plain reason, not a made-up substitute.
//
// Shoulder bias: Sean's scapular winging means press and pull swaps lead with a
// supported path (machine, chest-supported, or neutral grip). Heavy overhead,
// upright rows, and unstable hangs are not the first suggestion.

export function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const NO_SWAP = /scapular|dead hang|external rotation|wall slide|bird dog|hip switch|world s greatest|worlds greatest|spanish squat|wall sit|90 90|y t w|\bytw\b/;

const SUBSTITUTIONS = {
  horizontal_press: [
    { name: "Machine Chest Press", note: "Same flat press, fixed path. Easier on the shoulder." },
    { name: "Dumbbell Bench Press", note: "Same flat press. Neutral grip if the shoulder wants it." },
    { name: "Push-Ups", note: "Same press pattern, closed chain, no overhead.", kind: "bodyweight" },
    { name: "Barbell Bench Press", note: "Same flat press, barbell. Tuck the elbows." },
  ],
  incline_press: [
    { name: "Incline Machine Press", note: "Same incline, fixed path. Keep the seat supported." },
    { name: "Incline Dumbbell Press", note: "Same incline. Elbows can stay closer than a bar." },
    { name: "Dumbbell Bench Press", note: "Flatter press if the incline bothers the shoulder." },
  ],
  overhead_press: [
    { name: "Machine Shoulder Press", note: "Supported overhead. Back on the pad, not a standing grind." },
    { name: "Seated Dumbbell Shoulder Press", note: "Seated, back supported. Stop before the shoulder shrugs." },
    { name: "Landmine Press", note: "Angled press, less overhead than a strict military press." },
  ],
  landmine_press: [
    { name: "Landmine Press", note: "Same angled press, both hands if you can." },
    { name: "Incline Machine Press", note: "Same angle family, fixed path." },
    { name: "Machine Shoulder Press", note: "Supported press if the landmine is taken." },
  ],
  fly: [
    { name: "Machine Pec Deck", note: "Same fly, fixed path. Do not stretch into pain." },
    { name: "Cable Fly", note: "Same fly, cable. Keep a soft elbow." },
    { name: "Dumbbell Fly", note: "Same fly. Shorten the stretch if the shoulder talks." },
  ],
  vertical_pull: [
    { name: "Lat Pulldown", note: "Same vertical pull, seated and supported." },
    { name: "Assisted Pull-Up", note: "Same vertical pull, machine-assisted.", kind: "bodyweight" },
    { name: "Neutral-Grip Pulldown", note: "Same pull, neutral grip. Kinder on the shoulder." },
    { name: "Pull-Up", note: "Same vertical pull, bodyweight.", kind: "bodyweight" },
  ],
  horizontal_pull: [
    { name: "Chest-Supported Row", note: "Same horizontal pull, chest supported so the shoulder blade can move." },
    { name: "Machine Row", note: "Same horizontal pull, fixed path." },
    { name: "Seated Cable Row", note: "Same horizontal pull, seated." },
    { name: "Barbell Row", note: "Same horizontal pull, barbell. Brace, do not yank." },
  ],
  hinge: [
    { name: "Romanian Deadlift", note: "Same hip hinge." },
    { name: "Dumbbell Romanian Deadlift", note: "Same hinge, dumbbells." },
    { name: "Trap Bar Deadlift", note: "Same hinge, trap bar." },
    { name: "Good Morning", note: "Same hip hinge, lighter bar." },
  ],
  back_extension: [
    { name: "Back Extension", note: "Same hip and back extension." },
    { name: "45-Degree Back Extension", note: "Same pattern, on the bench." },
    { name: "Reverse Hyperextension", note: "Same posterior extension." },
  ],
  squat: [
    { name: "Goblet Squat", note: "Same squat pattern." },
    { name: "Leg Press", note: "Same knee-dominant pattern, machine." },
    { name: "Back Squat", note: "Same squat pattern, barbell." },
  ],
  lunge: [
    { name: "Dumbbell Walking Lunge", note: "Same split-leg pattern.", unilateral: true },
    { name: "Bulgarian Split Squat", note: "Same split-leg pattern.", unilateral: true },
    { name: "Step-Up", note: "Same single-leg pattern.", unilateral: true },
  ],
  hip_thrust: [
    { name: "Barbell Hip Thrust", note: "Same hip extension." },
    { name: "Dumbbell Hip Thrust", note: "Same hip extension, dumbbell." },
    { name: "Machine Hip Thrust", note: "Same hip extension, machine." },
  ],
  leg_curl: [
    { name: "Seated Leg Curl", note: "Same knee flexion." },
    { name: "Lying Leg Curl", note: "Same knee flexion." },
    { name: "Dumbbell Leg Curl", note: "Same knee flexion, free weight.", unilateral: true },
  ],
  leg_extension: [
    { name: "Leg Extension", note: "Same knee extension." },
    { name: "Single-Leg Extension", note: "Same knee extension, one side.", unilateral: true },
    { name: "Cable Leg Extension", note: "Same knee extension, cable.", unilateral: true },
  ],
  carry: [
    { name: "Farmer Carry", note: "Same loaded carry.", kind: "carry" },
    { name: "Suitcase Carry", note: "Same carry, one side.", kind: "carry", unilateral: true },
    { name: "Trap Bar Carry", note: "Same carry, trap bar.", kind: "carry" },
  ],
  dip: [
    { name: "Machine Dip", note: "Same dip, supported. Skip rings and deep hangs." },
    { name: "Close-Grip Bench Press", note: "Same triceps press, back on the bench." },
    { name: "Machine Chest Press", note: "Stable press if a dip bothers the shoulder." },
  ],
  curl: [
    { name: "Dumbbell Curl", note: "Same elbow flexion.", unilateral: true },
    { name: "Barbell Curl", note: "Same elbow flexion." },
    { name: "Cable Curl", note: "Same elbow flexion, cable." },
  ],
  tricep: [
    { name: "Cable Pushdown", note: "Same elbow extension, arms at your sides. No overhead." },
    { name: "Skull Crusher", note: "Same elbow extension, lying and supported." },
    { name: "Machine Triceps Press", note: "Same elbow extension, fixed path." },
  ],
  lateral: [
    { name: "Machine Lateral Raise", note: "Same side raise, fixed path. Stay light." },
    { name: "Cable Lateral Raise", note: "Same side raise, cable. Stop before the shrug.", unilateral: true },
    { name: "Dumbbell Lateral Raise", note: "Same side raise. Light, no swing.", unilateral: true },
  ],
  rear_delt: [
    { name: "Face Pull", note: "Same rear-delt pattern. Light, elbows up, the way the prep work goes." },
    { name: "Rear Delt Machine Fly", note: "Same rear-delt fly, chest supported." },
    { name: "Reverse Dumbbell Fly", note: "Same rear-delt fly. Chest on a bench if you can.", unilateral: true },
  ],
  calf: [
    { name: "Standing Calf Raise", note: "Same calf raise." },
    { name: "Seated Calf Raise", note: "Same calf raise, seated." },
    { name: "Dumbbell Calf Raise", note: "Same calf raise, free weight." },
  ],
  pullover: [
    { name: "Machine Pullover", note: "Same pullover, fixed path. Do not force the stretch overhead." },
    { name: "Cable Pullover", note: "Same pullover, cable. Keep it in a pain-free arc." },
    { name: "Dumbbell Pullover", note: "Same pullover. Shorten the range if the shoulder talks." },
  ],
  shrug: [
    { name: "Dumbbell Shrug", note: "Same shrug. Light enough to keep the shoulder blades honest." },
    { name: "Trap Bar Shrug", note: "Same shrug, trap bar." },
    { name: "Barbell Shrug", note: "Same shrug, barbell." },
  ],
  trunk: [
    { name: "Lying Leg Raise", note: "Same trunk flexion, on the floor." },
    { name: "Cable Crunch", note: "Same trunk flexion, loaded, not a hang." },
    { name: "Hanging Leg Raise", note: "Same trunk flexion. Dead-hang only if the shoulder is quiet." },
  ],
  anti_ext: [
    { name: "Plank", note: "Same anti-extension brace.", kind: "bodyweight" },
    { name: "Ab Wheel", note: "Same anti-extension." },
    { name: "Dead Bug", note: "Same brace, on the floor.", kind: "bodyweight" },
  ],
};

// More specific patterns first. "Incline curl" is a curl, "upright row" is not a horizontal row,
// "leg press" is a squat, "face pull" is not a vertical pull.
const SHOULDER_NO_SWAP = /upright row|behind the neck|guillotine|kipping|muscle up|ring dip|handstand/;

const SWAP_RULES = [
  { id: "leg_curl", test: /leg curl|hamstring curl|nordic curl/ },
  { id: "curl", test: /\bcurl\b/ },
  { id: "tricep", test: /pushdown|push down|skull crusher|tricep|triceps|overhead extension|dumbbell extension|\bjm press\b/ },
  { id: "landmine_press", test: /landmine/ },
  { id: "fly", test: /\bfly\b|\bflies\b|pec deck|chest fly/ },
  { id: "incline_press", test: /incline/ },
  { id: "overhead_press", test: /overhead|shoulder press|military press|arnold press|\bohp\b/ },
  { id: "rear_delt", test: /face pull|reverse fly|rear delt|pull apart|pull-apart/ },
  { id: "vertical_pull", test: /pull up|pullup|chin up|chinup|pulldown|lat pull/ },
  { id: "horizontal_pull", test: /\brow\b|\brows\b/ },
  { id: "hip_thrust", test: /hip thrust|glute bridge/ },
  { id: "leg_extension", test: /leg extension/ },
  { id: "lunge", test: /lunge|split squat|bulgarian|step up/ },
  { id: "squat", test: /squat|leg press|hack squat/ },
  { id: "back_extension", test: /back extension|hyperextension|reverse hyper/ },
  { id: "hinge", test: /romanian|\brdl\b|deadlift|good morning|hip hinge/ },
  { id: "carry", test: /carry|farmer|suitcase|yoke walk/ },
  { id: "dip", test: /\bdip\b/ },
  { id: "lateral", test: /lateral raise|side raise/ },
  { id: "calf", test: /calf/ },
  { id: "pullover", test: /pullover|pull over/ },
  { id: "anti_ext", test: /plank|ab wheel|dead bug|ab rollout|rollout/ },
  { id: "trunk", test: /leg raise|crunch|sit up|knee raise/ },
  { id: "shrug", test: /shrug/ },
  { id: "horizontal_press", test: /bench|chest press|floor press|push up|pushup/ },
];

function noSwap(raw) {
  const label = raw || "this exercise";
  return { pattern: null, options: [], note: `No close substitute for ${label}. Nothing else in the map trains the same pattern.` };
}

function shoulderNoSwap(raw) {
  return { pattern: null, options: [], note: `No close substitute for ${raw}. That variation is a poor match with a winging shoulder, so the map does not offer one.` };
}

export function substitutionOptions(exerciseName) {
  const raw = String(exerciseName || "").trim();
  const name = normalizeName(raw);
  if (!name || NO_SWAP.test(name)) return noSwap(raw);
  if (SHOULDER_NO_SWAP.test(name)) return shoulderNoSwap(raw);
  const rule = SWAP_RULES.find((r) => r.test.test(name));
  if (!rule) return noSwap(raw);
  const options = (SUBSTITUTIONS[rule.id] || [])
    .filter((o) => normalizeName(o.name) !== name)
    .slice(0, 3)
    .map((o) => ({ name: o.name, note: o.note, kind: o.kind || null, unilateral: !!o.unilateral }));
  if (!options.length) return noSwap(raw);
  return { pattern: rule.id, options, note: "" };
}

// Kind for a brand-new library row only. An existing exercise keeps its own kind.
// A loaded substitute for a bodyweight plan still needs a load field, so it is not bodyweight.
export function replacementKind(spec, planned) {
  if (spec?.kind) return spec.kind;
  if (!planned || planned.kind === "bodyweight" || planned.kind === "carry") return "double";
  return planned.kind || "double";
}

function rirScheme(ex) {
  if (ex.kind === "bodyweight") return "Keep about two reps in reserve.";
  if (ex.kind === "primary" || ex.kind === "volume") return "Same RIR as the plan: the set should not be a grind.";
  if (ex.kind === "carry") return "Same effort as the plan. Stop with the hold still clean.";
  return "Log RIR the same way you would on the planned exercise.";
}

// Weight comes from the substitute's own history. Reps, set count, and RIR stay with the plan.
// No history: leave the load blank instead of inventing an equivalent.
export function prescribeSwap(planned, plannedSg, replacement, replHist, todayAdj) {
  const logged = Array.isArray(replHist) && replHist.length > 0;
  let replSg = suggest(replacement, replHist || [], {});
  if (todayAdj) replSg = applyToday(replSg, replacement, todayAdj.level, todayAdj.deload);
  const kind = replacement.kind || replacementKind({}, planned);
  const repLabel = `${planned.rep_low}${planned.rep_high !== planned.rep_low ? "-" + planned.rep_high : ""}`;
  const rir = rirScheme(planned);
  const out = {
    exercise_id: replacement.id,
    planned_exercise_id: planned.id,
    name: replacement.name,
    kind,
    unilateral: replacement.unilateral != null ? !!replacement.unilateral : !!planned.unilateral,
    load: null,
    reps: kind === "carry" ? null : plannedSg.reps,
    seconds: kind === "carry" ? (plannedSg.seconds ?? planned.rep_low) : null,
    sets: plannedSg.sets,
    status: "swap",
    light: "green",
    why: "",
    heavy: null,
    last: replSg.last,
    swapped: true,
    swap_from: planned.name,
    benchmark_due: false,
    today: plannedSg.today || null,
  };
  const back = `Next time this day is ${planned.name} again.`;
  if (kind === "bodyweight") {
    out.why = `This session only, in place of ${planned.name}. Reps stay ${repLabel}. ${rir} ${logged ? "Last time on this movement is above." : "First time on it, so nothing is invented."} ${back}`;
  } else if (logged && replSg.load != null) {
    out.load = replSg.load;
    out.why = `This session only, in place of ${planned.name}. Weight comes from ${replacement.name}'s own history. Reps stay ${repLabel}. ${rir} ${back}`;
  } else {
    out.why = `This session only, in place of ${planned.name}. No log on ${replacement.name} yet, so the load is blank. Put in a conservative weight you can finish. Reps stay ${repLabel}. ${rir} ${back}`;
  }
  if (logged && replSg.status === "pain_hold") {
    out.status = "pain_hold";
    out.light = "red";
    out.load = kind === "bodyweight" ? null : replSg.load;
    out.why = `${replSg.why} This session is using ${replacement.name} instead of ${planned.name}. Reps stay ${repLabel}. ${rir}`;
  }
  return out;
}

// One slot on a workout day. Without a replacement this matches suggest + applyToday,
// plus the option list. With a replacement, the planned exercise row is not modified.
export function buildSlotSuggestion(planned, plannedHist, ctx, todayAdj, replacement, replHist) {
  let s = suggest(planned, plannedHist || [], ctx || {});
  if (todayAdj) s = applyToday(s, planned, todayAdj.level, todayAdj.deload);
  const sub = substitutionOptions(planned.name);
  s.planned_exercise_id = planned.id;
  s.options = sub.options;
  s.swap_note = sub.note;
  s.swapped = false;
  if (!replacement) return s;
  const swapped = prescribeSwap(planned, s, replacement, replHist || [], todayAdj);
  swapped.options = sub.options;
  swapped.swap_note = sub.note;
  return swapped;
}

// ---------- daily food ----------
// Totals only, one row per date, including rest days. Body weight already lives
// on sessions and profiles. Later body-fat or scale data should be a new table
// or new nullable columns, not a rewrite of this log or of workout history.
export function cleanMacro(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error("Use a number, zero or more."), { status: 400 });
  if (n > 20000) throw Object.assign(new Error("That number is too large to be a daily total."), { status: 400 });
  return Math.round(n * 10) / 10;
}

export function hasFood(row) {
  if (!row) return false;
  return ["calories", "protein", "carbs", "fat"].some((k) => row[k] != null && row[k] !== "");
}

// Calendar day in America/Chicago. Weigh-ins and "today" for food use this, not UTC.
export function chicagoDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Only this account, and only to fill blanks. Other accounts get nothing.
const SEAN_WEIGHT_EMAIL = "seanpatrickphelps@gmail.com";
export function seanWeightDefaults(email) {
  if (String(email || "").trim().toLowerCase() !== SEAN_WEIGHT_EMAIL) return null;
  return { start_bodyweight: 245.6, goal_bodyweight: 210, target_calories: 2000, target_protein: 200, pounds: 245.6 };
}

export function profilePatchForSean(email, profile) {
  const d = seanWeightDefaults(email);
  if (!d) return null;
  const patch = {};
  if (profile?.start_bodyweight == null || profile?.start_bodyweight === "") patch.start_bodyweight = d.start_bodyweight;
  if (profile?.goal_bodyweight == null || profile?.goal_bodyweight === "") patch.goal_bodyweight = d.goal_bodyweight;
  if (profile?.target_calories == null || profile?.target_calories === "") patch.target_calories = d.target_calories;
  if (profile?.target_protein == null || profile?.target_protein === "") patch.target_protein = d.target_protein;
  return Object.keys(patch).length ? patch : null;
}

export function shouldSeedWeighIn(email, weighInCount) {
  return !!seanWeightDefaults(email) && !Number(weighInCount);
}

// start toward goal. lost is start minus current. remaining is current minus goal.
// Progress is 0 at the start and 100 at the goal. Gaining weight does not draw a negative bar.
export function weightProgress({ start, current, goal } = {}) {
  if (start == null || start === "" || current == null || current === "" || goal == null || goal === "") return { ready: false };
  const s = Number(start), c = Number(current), g = Number(goal);
  if (![s, c, g].every(Number.isFinite)) return { ready: false };
  const lost = Math.round((s - c) * 10) / 10;
  const remaining = Math.round((c - g) * 10) / 10;
  const span = s - g;
  let pct = 0;
  if (span > 0) pct = Math.max(0, Math.min(100, (lost / span) * 100));
  else if (span < 0) pct = Math.max(0, Math.min(100, ((c - s) / (g - s)) * 100));
  else pct = c === g ? 100 : 0;
  const reached = span === 0 ? c === g : span > 0 ? c <= g : c >= g;
  return { ready: true, start: s, current: c, goal: g, lost, remaining, pct: Math.round(pct * 10) / 10, reached };
}

export function targetsOf(profile) {
  return {
    calories: profile?.target_calories ?? null,
    protein: profile?.target_protein ?? null,
    carbs: profile?.target_carbs ?? null,
    fat: profile?.target_fat ?? null,
    hydration: profile?.target_hydration_oz ?? null,
  };
}

export const MIGRATION_FILE = "supabase/migrations/20261106_train_swap_nutrition.sql";
export const MEALS_MIGRATION = "supabase/migrations/20261106_train_meals_hydration.sql";

// Meals are the day's total once any exist. A typed nutrition_logs row is kept
// and used only when that day has no meal rows, so an older total is not lost.
export function mealTotals(items) {
  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const it of items || []) {
    totals.calories += Number(it.calories) || 0;
    totals.protein += Number(it.protein) || 0;
    totals.carbs += Number(it.carbs) || 0;
    totals.fat += Number(it.fat) || 0;
  }
  for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k] * 10) / 10;
  return totals;
}

export function normalizeMealItems(items) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error("Add at least one food."), { status: 400 });
  if (items.length > 40) throw Object.assign(new Error("Split that into more than one meal."), { status: 400 });
  const out = [];
  for (const it of items) {
    const name = String(it?.name || "").trim().slice(0, 120);
    if (!name) continue;
    out.push({
      name,
      portion: String(it?.portion || "").trim().slice(0, 80),
      calories: cleanMacro(it?.calories ?? 0) ?? 0,
      protein: cleanMacro(it?.protein ?? 0) ?? 0,
      carbs: cleanMacro(it?.carbs ?? 0) ?? 0,
      fat: cleanMacro(it?.fat ?? 0) ?? 0,
    });
  }
  if (!out.length) throw Object.assign(new Error("Add at least one food."), { status: 400 });
  return out;
}

export function normalizeMealEstimate(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no json");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const items = normalizeMealItems(parsed.items);
  return { items, totals: mealTotals(items), note: String(parsed.note || "").trim().slice(0, 500) };
}

export function effectiveDayFood(meals, manual) {
  const list = Array.isArray(meals) ? meals : [];
  if (list.length) {
    const parts = list.map((m) => (Array.isArray(m?.items) && m.items.length ? mealTotals(m.items) : m));
    return { ...mealTotals(parts), source: "meals" };
  }
  if (hasFood(manual)) {
    return {
      calories: manual.calories ?? null, protein: manual.protein ?? null, carbs: manual.carbs ?? null, fat: manual.fat ?? null, source: "manual",
    };
  }
  return { calories: null, protein: null, carbs: null, fat: null, source: "none" };
}

export function foodBar(current, target) {
  const t = Number(target);
  if (target == null || target === "" || !Number.isFinite(t) || t <= 0) return { show: false, pct: 0, over: false };
  const cur = Number(current);
  const n = Number.isFinite(cur) ? cur : 0;
  return { show: true, pct: Math.max(0, Math.min(100, (n / t) * 100)), over: n > t };
}

export function foodChip(kind, current, target) {
  const bar = foodBar(current, target);
  if (!bar.show || current == null || current === "") return null;
  const diff = Math.round((Number(current) - Number(target)) * 10) / 10;
  const abs = Math.abs(diff);
  if (kind === "calories") {
    if (diff > 0) return { label: "Calories over", value: `+${abs}`, tone: "over" };
    if (diff < 0) return { label: "Calories left", value: String(abs), tone: "left" };
    return { label: "Calories", value: "On target", tone: "even" };
  }
  if (kind === "protein") {
    if (diff > 0) return { label: "Protein above", value: `+${abs} g`, tone: "good" };
    if (diff < 0) return { label: "Protein left", value: `${abs} g`, tone: "left" };
    return { label: "Protein", value: "On target", tone: "even" };
  }
  if (kind === "hydration") {
    if (diff > 0) return { label: "Hydration over", value: `${abs} oz`, tone: "over" };
    if (diff < 0) return { label: "Hydration left", value: `${abs} oz`, tone: "left" };
    return { label: "Hydration", value: "On target", tone: "even" };
  }
  return null;
}

// A session view plus the day's food. Food is attached. The session fields are copied, not rewritten.
export function presentSessionFood(session, meals, manual) {
  return {
    id: session.id,
    workout_day: session.workout_day,
    finished: session.finished,
    detail: session.detail,
    food: effectiveDayFood(meals, manual),
  };
}

export const FOOD_MODEL = process.env.TRAIN_FOOD_MODEL || "claude-sonnet-4-6";
export const FOOD_KEY_MESSAGE = "Food estimates need ANTHROPIC_API_KEY on the server. Workout logging still works, and a typed daily total still saves.";
export const FOOD_SYSTEM = `You estimate one meal from a photo, a short description, or both. Return only JSON, no markdown, with exactly this shape:
{"items":[{"name":"","portion":"","calories":0,"protein":0,"carbs":0,"fat":0}],"note":""}
name is the food. portion is the serving you assumed, short, like "1 pack" or "2 servings".
calories is kcal for that line. protein, carbs, and fat are grams for that line.
note is one or two short sentences on the assumptions, such as serving size.
If the person's note conflicts with the photo, follow the note.
If you cannot tell, still return a best estimate and say what you assumed.
Do not include a totals row. Do not give medical advice.`;

export function foodActionWrites(action) {
  return action === "confirm" || action === "update" || action === "remove" || action === "hydration" || action === "weigh";
}

export async function requestMealEstimate({ apiKey, text, image, mediaType, fetchImpl, model } = {}) {
  if (!apiKey) return { ok: false, status: 400, error: FOOD_KEY_MESSAGE };
  const note = String(text || "").trim().slice(0, 2000);
  const content = [];
  if (image) {
    const type = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mediaType) ? mediaType : null;
    if (!type) return { ok: false, status: 400, error: "Use a JPEG, PNG, GIF, or WebP photo." };
    const data = String(image).replace(/^data:[^,]+,/, "").replace(/\s/g, "");
    if (data.length > 4_000_000) return { ok: false, status: 400, error: "That photo is too large. Try a smaller one." };
    content.push({ type: "image", source: { type: "base64", media_type: type, data } });
  }
  if (!note && !image) return { ok: false, status: 400, error: "Add a photo, a description, or both." };
  content.push({ type: "text", text: note || "Estimate this meal." });
  const fetchFn = fetchImpl || fetch;
  const r = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: model || FOOD_MODEL, max_tokens: 1200, system: FOOD_SYSTEM, messages: [{ role: "user", content }] }),
  });
  const rawText = await r.text();
  if (!r.ok) return { ok: false, status: 502, error: "The estimate failed. Try again, or type a daily total." };
  let data;
  try { data = JSON.parse(rawText); } catch { return { ok: false, status: 502, error: "The estimate failed. Try again, or type a daily total." }; }
  const textOut = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  try { return { ok: true, status: 200, meal: normalizeMealEstimate(textOut) }; }
  catch { return { ok: false, status: 502, error: "The estimate was not usable. Try a clearer photo or a short description." }; }
}

export function schemaMissing(err) {
  const m = String(err?.message || err || "");
  return /PGRST205|42P01|42703|PGRST204|does not exist|schema cache|Could not find the/i.test(m);
}

export function migrationError(err) {
  if (!schemaMissing(err)) return null;
  return `The training log needs a one-time SQL update before this can save. Run ${MIGRATION_FILE} in the Supabase SQL editor. Existing workouts are left as they are.`;
}

export function mealsMigrationError(err) {
  if (!schemaMissing(err)) return null;
  return `Meals and hydration need ${MEALS_MIGRATION} in the Supabase SQL editor. Run ${MIGRATION_FILE} first if you have not. Existing workouts are left as they are.`;
}

export const WEIGH_MIGRATION = "supabase/migrations/20261107_train_weigh_ins.sql";

export function weighMigrationError(err) {
  if (!schemaMissing(err)) return null;
  return `Daily weigh-ins need ${WEIGH_MIGRATION} in the Supabase SQL editor for the accountability project. Existing workouts and food are left as they are.`;
}
