import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  substitutionOptions, prescribeSwap, buildSlotSuggestion, suggest, applyToday,
  cleanMacro, hasFood, replacementKind, normalizeName, schemaMissing,
  mealTotals, normalizeMealEstimate, effectiveDayFood, foodBar, foodChip,
  presentSessionFood, requestMealEstimate, foodActionWrites, FOOD_KEY_MESSAGE,
  chicagoDate, weightProgress, seanWeightDefaults, profilePatchForSean, shouldSeedWeighIn, targetsOf,
  hydrationTarget, ringProgress, saveSetRow, classifySetSaveError,
  liftingGoal, monthSpan, adjacentHistoryMonth, liftingDaysFromSets, summarizeLiftingMonths, paceCopy,
  recompSpan, pairAvg, latestBodyWeight, physiqueView, goalFatMassLb, requestScanExtract, SCAN_KEY_MESSAGE,
} from "../lib/train.js";

const planned = {
  id: 1, name: "Machine Chest Press", kind: "primary", unilateral: false,
  sets: 4, rep_low: 6, rep_high: 8, increment: 5, start_load: 100, heavy_offset: 10,
};
const repl = {
  id: 9, name: "Dumbbell Bench Press", kind: "primary", unilateral: false,
  sets: 3, rep_low: 8, rep_high: 12, increment: 5, start_load: 40,
};

function work(load, reps, extra = {}) {
  return { set_kind: "work", load, reps, rir: 2, pain: 0, completed: true, ...extra };
}

test("machine chest press suggests a flat press, not itself", () => {
  const { options, note } = substitutionOptions("Machine Chest Press");
  const names = options.map((o) => o.name);
  assert.equal(note, "");
  assert.ok(names.includes("Dumbbell Bench Press"));
  assert.ok(names.includes("Barbell Bench Press"));
  assert.equal(names.includes("Machine Chest Press"), false);
  assert.ok(names.length >= 2 && names.length <= 3);
});

test("known lifts get a pattern and unknown or prep work does not", () => {
  const covered = [
    "Barbell Bench Press", "Pull-Up", "Push-Ups", "Romanian Deadlift", "Lat Pulldown",
    "Incline Dumbbell Press", "Seated Cable Row", "Back Squat", "Leg Press", "Bulgarian Split Squat",
    "Barbell Hip Thrust", "Lying Leg Curl", "Farmer Carry", "Dumbbell Curl", "Cable Pushdown",
    "Face Pull", "Standing Calf Raise", "Dumbbell Lateral Raise", "Plank", "Hanging Leg Raise",
  ];
  for (const name of covered) {
    const got = substitutionOptions(name);
    assert.ok(got.options.length >= 1 && got.options.length <= 3, name);
    assert.equal(got.options.some((o) => normalizeName(o.name) === normalizeName(name)), false, name);
  }
  for (const name of ["Scapular Push-Up", "Spanish Squat", "Bird Dog", "Mystery Garden Walk"]) {
    const got = substitutionOptions(name);
    assert.equal(got.options.length, 0, name);
    assert.match(got.note, /No close substitute/);
  }
});

test("patterns stay in their family", () => {
  const names = (n) => substitutionOptions(n).options.map((o) => o.name).join(" | ");
  assert.match(names("Leg Extension"), /Extension/);
  assert.doesNotMatch(names("Leg Extension"), /Squat|Bench/);
  assert.match(names("Incline Dumbbell Curl"), /Curl/);
  assert.doesNotMatch(names("Incline Dumbbell Curl"), /Press/);
  assert.match(names("Overhead Dumbbell Extension"), /Pushdown|Skull/);
  assert.doesNotMatch(names("Overhead Dumbbell Extension"), /Overhead/);
  assert.doesNotMatch(names("Pull-Up"), /Bench|Squat/);
});

test("press and pull swaps lead with a supported, shoulder-aware option", () => {
  const first = (n) => substitutionOptions(n).options[0].name;
  const all = (n) => substitutionOptions(n).options.map((o) => o.name).join(" | ");
  assert.equal(first("Machine Chest Press"), "Dumbbell Bench Press");
  assert.equal(first("Barbell Bench Press"), "Machine Chest Press");
  assert.equal(first("Barbell Overhead Press"), "Machine Shoulder Press");
  assert.equal(first("Arnold Press"), "Machine Shoulder Press");
  assert.doesNotMatch(all("Barbell Overhead Press"), /Barbell Overhead|Military/);
  assert.equal(first("Pull-Up"), "Lat Pulldown");
  assert.equal(first("Barbell Row"), "Chest-Supported Row");
  assert.equal(first("Chest Dip"), "Machine Dip");
  assert.doesNotMatch(all("Dip"), /Ring|Chest Dip/);
  assert.equal(first("Dumbbell Fly"), "Machine Pec Deck");
  const upright = substitutionOptions("Upright Row");
  assert.equal(upright.options.length, 0);
  assert.match(upright.note, /winging shoulder/);
  assert.equal(substitutionOptions("Behind the Neck Press").options.length, 0);
  assert.match(substitutionOptions("Scapular Push-Up").note, /No close substitute/);
  assert.match(substitutionOptions("Y-T-W Raise").note, /No close substitute/);
});

test("a logged substitute uses its own load and the plan's reps", () => {
  const hist = [{ session_date: "2026-10-01", sets: [work(50, 8), work(50, 8), work(50, 8), work(50, 8)] }];
  const plannedSg = suggest(planned, [], {});
  const replSg = suggest(repl, hist, {});
  const out = prescribeSwap(planned, plannedSg, repl, hist, null);
  assert.equal(out.load, replSg.load);
  assert.equal(out.reps, plannedSg.reps);
  assert.equal(out.sets, plannedSg.sets);
  assert.equal(out.exercise_id, repl.id);
  assert.equal(out.planned_exercise_id, planned.id);
  assert.equal(out.swapped, true);
  assert.equal(out.swap_from, planned.name);
  assert.equal(out.heavy, null);
  assert.equal(planned.name, "Machine Chest Press");
});

test("an unlogged substitute leaves the load blank", () => {
  const plannedSg = suggest(planned, [], {});
  const out = prescribeSwap(planned, plannedSg, repl, [], null);
  assert.equal(out.load, null);
  assert.equal(out.reps, plannedSg.reps);
  assert.equal(out.sets, 4);
  assert.match(out.why, /blank/);
  assert.match(out.why, /6-8/);
});

test("pain on the substitute is not hidden", () => {
  const hist = [{ session_date: "2026-10-01", sets: [work(50, 8, { pain: 4 }), work(50, 8, { pain: 4 })] }];
  const plannedSg = suggest(planned, [], {});
  const out = prescribeSwap(planned, plannedSg, { ...repl, sets: 2 }, hist, null);
  assert.equal(out.status, "pain_hold");
  assert.equal(out.light, "red");
  assert.ok(out.load != null && out.load < 50);
});

test("an unswapped slot matches suggest and applyToday", () => {
  const hist = [{ session_date: "2026-10-01", sets: [work(100, 6), work(100, 6), work(100, 6), work(100, 6)] }];
  const ctx = {};
  const plain = suggest(planned, hist, ctx);
  const built = buildSlotSuggestion(planned, hist, ctx, null, null, []);
  assert.equal(built.load, plain.load);
  assert.equal(built.reps, plain.reps);
  assert.equal(built.sets, plain.sets);
  assert.equal(built.exercise_id, planned.id);
  assert.equal(built.swapped, false);
  assert.ok(built.options.length >= 2);

  const adjusted = applyToday(suggest(planned, hist, ctx), planned, "yellow", false);
  const viaSlot = buildSlotSuggestion(planned, hist, ctx, { level: "yellow", deload: false }, null, []);
  assert.equal(viaSlot.load, adjusted.load);
  assert.equal(viaSlot.status, adjusted.status);
  assert.equal(planned.name, "Machine Chest Press");
});

test("replacement kind stays loadable when the plan is bodyweight", () => {
  const pull = { id: 2, name: "Pull-Up", kind: "bodyweight", sets: 3, rep_low: 5, rep_high: 8 };
  const option = substitutionOptions("Pull-Up").options.find((o) => o.name === "Lat Pulldown");
  assert.equal(replacementKind(option, pull), "double");
  assert.equal(replacementKind({ kind: "bodyweight" }, planned), "bodyweight");
});

test("meal lines roll up, and a typed total remains until meals exist", () => {
  const items = [
    { name: "Popcorn", portion: "1 pack", calories: 100, protein: 2, carbs: 18, fat: 3 },
    { name: "Blue corn tortilla chips", portion: "2 servings", calories: 280, protein: 4, carbs: 36, fat: 14 },
  ];
  const totals = mealTotals(items);
  assert.deepEqual(totals, { calories: 380, protein: 6, carbs: 54, fat: 17 });
  const manual = { calories: 1800, protein: 100, carbs: 150, fat: 40 };
  assert.equal(effectiveDayFood([], manual).source, "manual");
  assert.equal(effectiveDayFood([], manual).calories, 1800);
  const meals = [{ items }];
  const rolled = effectiveDayFood(meals, manual);
  assert.equal(rolled.source, "meals");
  assert.equal(rolled.calories, 380);
  assert.equal(rolled.fat, 17);
  assert.equal(manual.calories, 1800);
  assert.equal(effectiveDayFood([], manual).source, "manual");
  const parsed = normalizeMealEstimate('Sure. {"items":[{"name":"Popcorn","portion":"1 pack","calories":100,"protein":2,"carbs":18,"fat":3}],"note":"Assumed one pack."}');
  assert.equal(parsed.totals.calories, 100);
  assert.match(parsed.note, /one pack/);
});

test("an estimate is not a save, and a missing key never calls the model", async () => {
  assert.equal(foodActionWrites("estimate"), false);
  assert.equal(foodActionWrites("confirm"), true);
  let called = false;
  const missing = await requestMealEstimate({ apiKey: "", text: "eggs", fetchImpl: () => { called = true; } });
  assert.equal(called, false);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, FOOD_KEY_MESSAGE);
  const draft = await requestMealEstimate({
    apiKey: "test-key",
    text: "popcorn and chips, two servings, no salsa",
    fetchImpl: async (url, opts) => {
      called = true;
      assert.equal(opts.headers["x-api-key"], "test-key");
      assert.equal(String(opts.body).includes("test-key"), false);
      const body = JSON.parse(opts.body);
      assert.equal(body.model, "claude-sonnet-4-6");
      assert.ok(body.messages[0].content.some((c) => c.type === "text" && /no salsa/.test(c.text)));
      return { ok: true, text: async () => JSON.stringify({ content: [{ type: "text", text: '{"items":[{"name":"Popcorn","portion":"1 pack","calories":100,"protein":2,"carbs":18,"fat":3},{"name":"Blue corn tortilla chips","portion":"2 servings","calories":280,"protein":4,"carbs":36,"fat":14}],"note":"Tortilla chips assumed at 140 calories per 1 oz serving, without salsa."}' }] }) };
    },
  });
  assert.equal(called, true);
  assert.equal(draft.ok, true);
  assert.equal(draft.meal.totals.calories, 380);
  assert.equal(draft.meal.totals.protein, 6);
  assert.equal(Object.hasOwn(draft, "apiKey"), false);
});

test("bars and chips use the profile target, and a blank target draws no bar", () => {
  assert.equal(foodBar(2250, null).show, false);
  assert.equal(foodBar(2250, "").show, false);
  const cal = foodChip("calories", 2250, 2000);
  assert.equal(cal.label, "Calories over");
  assert.equal(cal.value, "+250");
  const pro = foodChip("protein", 213.5, 209);
  assert.equal(pro.label, "Protein above");
  assert.equal(pro.value, "+4.5 g");
  const water = foodChip("hydration", 115.5, 128);
  assert.equal(water.label, "Hydration left");
  assert.equal(water.value, "12.5 oz");
  assert.equal(foodChip("calories", null, 2000), null);
});

test("a past session keeps its sets when food is attached", () => {
  const session = { id: 11, workout_day: 1, finished: true, detail: [{ name: "Barbell Bench Press", sets: [{ load: 185, reps: 6 }] }, { name: "Pull-Up", sets: [{ reps: 8 }] }] };
  const before = JSON.stringify(session);
  const view = presentSessionFood(session, [], { calories: 2400, protein: 180, carbs: 220, fat: 70 });
  assert.equal(view.id, 11);
  assert.equal(view.workout_day, 1);
  assert.equal(view.finished, true);
  assert.equal(view.detail[0].sets[0].load, 185);
  assert.equal(view.detail[1].name, "Pull-Up");
  assert.equal(view.food.source, "manual");
  assert.equal(JSON.stringify(session), before);
  const withMeals = presentSessionFood(session, [{ items: [{ name: "Popcorn", portion: "1 pack", calories: 100, protein: 2, carbs: 18, fat: 3 }] }], { calories: 2400, protein: 180, carbs: 220, fat: 70 });
  assert.equal(withMeals.detail[0].sets[0].load, 185);
  assert.equal(withMeals.food.source, "meals");
  assert.equal(withMeals.food.calories, 100);
});

test("weight progress at the start, the goal, above the start, and under the goal", () => {
  const start = weightProgress({ start: 245.6, current: 245.6, goal: 210 });
  assert.equal(start.lost, 0);
  assert.equal(start.remaining, 35.6);
  assert.equal(start.pct, 0);
  assert.equal(start.reached, false);
  const goal = weightProgress({ start: 245.6, current: 210, goal: 210 });
  assert.equal(goal.lost, 35.6);
  assert.equal(goal.remaining, 0);
  assert.equal(goal.pct, 100);
  assert.equal(goal.reached, true);
  const above = weightProgress({ start: 245.6, current: 250, goal: 210 });
  assert.equal(above.lost, -4.4);
  assert.equal(above.remaining, 40);
  assert.equal(above.pct, 0);
  const under = weightProgress({ start: 245.6, current: 205, goal: 210 });
  assert.equal(under.lost, 40.6);
  assert.equal(under.remaining, -5);
  assert.equal(under.pct, 100);
  assert.equal(under.reached, true);
  assert.equal(weightProgress({ start: null, current: 245.6, goal: 210 }).ready, false);
});

test("Chicago dates and Sean's defaults stay off every other account", () => {
  assert.equal(chicagoDate(new Date("2026-11-07T04:30:00Z")), "2026-11-06");
  assert.equal(chicagoDate(new Date("2026-11-06T15:00:00Z")), "2026-11-06");
  assert.equal(chicagoDate(new Date("2026-11-06T05:30:00Z")), "2026-11-05");
  assert.equal(seanWeightDefaults("friend@example.com"), null);
  assert.equal(profilePatchForSean("friend@example.com", {}), null);
  assert.equal(shouldSeedWeighIn("friend@example.com", 0), false);
  const sean = profilePatchForSean("SeanPatrickPhelps@gmail.com", {});
  assert.equal(sean.start_bodyweight, 245.6);
  assert.equal(sean.goal_bodyweight, 210);
  assert.equal(sean.target_calories, 2000);
  assert.equal(sean.target_protein, 200);
  const kept = profilePatchForSean("seanpatrickphelps@gmail.com", { start_bodyweight: 230, goal_bodyweight: 200, target_calories: 2200, target_protein: 180 });
  assert.equal(kept, null);
  const partial = profilePatchForSean("seanpatrickphelps@gmail.com", { start_bodyweight: 245.6, goal_bodyweight: 210 });
  assert.equal(partial.target_calories, 2000);
  assert.equal(partial.start_bodyweight, undefined);
  assert.equal(shouldSeedWeighIn("seanpatrickphelps@gmail.com", 0), true);
  assert.equal(shouldSeedWeighIn("seanpatrickphelps@gmail.com", 1), false);
  assert.equal(targetsOf({}).calories, null);
  assert.equal(targetsOf({ target_calories: 2000, target_protein: 200 }).protein, 200);
  assert.equal(foodActionWrites("weigh"), true);
  assert.equal(foodBar(1000, 2000).pct, 50);
  assert.equal(effectiveDayFood([{ items: [{ calories: 500, protein: 40, carbs: 30, fat: 10 }] }], null).calories, 500);
});

test("48 oz fills the water ring when the goal is unset", () => {
  assert.equal(hydrationTarget(null), 100);
  assert.equal(hydrationTarget(undefined), 100);
  assert.equal(hydrationTarget(""), 100);
  assert.equal(hydrationTarget(0), 100);
  assert.equal(hydrationTarget(80), 80);
  const ring = ringProgress(48, hydrationTarget(null));
  assert.equal(ring.current, 48);
  assert.equal(ring.target, 100);
  assert.equal(Math.round(ring.pct * 100), 48);
  assert.ok(ring.pct > 0);
  assert.equal(targetsOf({ target_hydration_oz: null }).hydration, null);
  assert.equal(ringProgress(48, hydrationTarget(128)).target, 128);
});

test("a set save updates the same row and a 409 patches it instead of inserting twice", async () => {
  const row = { user_id: "u", session_id: 4, exercise_id: 9, set_number: 1, side: null, set_kind: "work", load: 185, reps: 8 };
  const calls = [];
  const db = async (path, opts) => {
    calls.push({ path, method: opts.method, body: opts.body });
    const patches = calls.filter((c) => c.method === "PATCH").length;
    if (opts.method === "PATCH" && patches === 1) return [];
    if (opts.method === "POST") throw new Error('Supabase POST sets: 409 {"code":"23505","message":"duplicate key value violates unique constraint \\"sets_unique_v2\\""}');
    if (opts.method === "PATCH") return [{ id: 7, reps: opts.body.reps, load: opts.body.load }];
    return null;
  };
  const saved = await saveSetRow(db, row);
  assert.equal(saved.id, 7);
  assert.equal(saved.reps, 8);
  assert.deepEqual(calls.map((c) => c.method), ["PATCH", "POST", "PATCH"]);
  assert.equal(calls.some((c) => c.method === "DELETE"), false);
  assert.match(calls[0].path, /session_id=eq\.4/);
  assert.match(calls[0].path, /side=is\.null/);
  assert.match(calls[0].path, /set_kind=eq\.work/);

  const again = [];
  const update = async (path, opts) => {
    again.push(opts.method);
    if (opts.method === "PATCH") return [{ id: 7, reps: 10 }];
    throw new Error("insert should not run when the slot already exists");
  };
  const edited = await saveSetRow(update, { ...row, reps: 10 });
  assert.equal(edited.reps, 10);
  assert.deepEqual(again, ["PATCH"]);

  const offline = classifySetSaveError(new TypeError("Failed to fetch"));
  assert.equal(offline.queue, true);
  const conflict = classifySetSaveError(new Error("That set did not save. Try again."));
  assert.equal(conflict.queue, false);
  assert.match(conflict.message, /did not save/);
  const raw = classifySetSaveError(new Error("Supabase POST sets: 409 duplicate key"));
  assert.equal(raw.queue, false);
  assert.equal(raw.message, "That set did not save. Try again.");
});

test("history months run from September 2026 through this month, newest first", () => {
  assert.equal(liftingGoal(30), 21);
  assert.equal(liftingGoal(31), 22);
  assert.equal(liftingGoal(28), 20);
  assert.equal(liftingGoal(10), 7);
  const span = monthSpan("2026-09", "2026-11-10");
  assert.deepEqual(span, ["2026-11", "2026-10", "2026-09"]);
  assert.equal(span.includes("2026-08"), false);
  assert.equal(adjacentHistoryMonth("2026-09", -1, "2026-11-10"), null);
  assert.equal(adjacentHistoryMonth("2026-11", 1, "2026-11-10"), null);
  assert.equal(adjacentHistoryMonth("2026-10", 1, "2026-11-10"), "2026-11");
  assert.equal(adjacentHistoryMonth("2026-10", -1, "2026-11-10"), "2026-09");

  const logged = [
    "2026-11-02T18:00:00Z",
    "2026-11-03T18:00:00Z",
    "2026-11-05T18:00:00Z",
    "2026-11-06T18:00:00Z",
    "2026-11-08T18:00:00Z",
    "2026-11-09T18:00:00Z",
    "2026-11-10T16:00:00Z",
    "2026-11-10T04:30:00Z",
  ].map((logged_at) => ({ logged_at }));
  const dates = liftingDaysFromSets(logged, "2026-11-10");
  assert.equal(dates.includes("2026-11-09"), true);
  assert.equal(dates.filter((d) => d === "2026-11-10").length, 1);
  assert.equal(dates.includes("2026-08-31"), false);
  const months = summarizeLiftingMonths({ dates, today: "2026-11-10" });
  assert.equal(months[0].month, "2026-11");
  assert.equal(months[0].name, "November");
  assert.equal(months[0].lifted, 7);
  assert.equal(months[0].daysInMonth, 30);
  assert.equal(months[0].goal, 21);
  assert.equal(months[0].paceGoal, 7);
  assert.equal(months[0].pace, 0);
  assert.equal(paceCopy(months[0]), "On pace");
  assert.equal(Math.round(months[0].pct * 21), 7);
  assert.equal(months.at(-1).month, "2026-09");
  assert.equal(paceCopy(months[1]), "");
  const ahead = { current: true, pace: 2 };
  const behind = { current: true, pace: -1 };
  assert.equal(paceCopy(ahead), "2 days ahead of pace");
  assert.equal(paceCopy(behind), "1 day behind pace");
});

const baseline = {
  scan_date: "2026-11-05", weight_lb: 246, body_fat_pct: 26.6, lean_mass_lb: 180.6,
  arm_left_muscle_lb: 10.6, arm_right_muscle_lb: 10.8, trunk_muscle_lb: 78.9,
  leg_left_muscle_lb: 30.2, leg_right_muscle_lb: 30.2,
};
const later = {
  scan_date: "2026-11-10", weight_lb: 243.2, body_fat_pct: 25.1, lean_mass_lb: 182.1,
  arm_left_muscle_lb: 10.9, arm_right_muscle_lb: 11.1, trunk_muscle_lb: 79.4,
  leg_left_muscle_lb: 30.4, leg_right_muscle_lb: 30.5,
};
const goals = {
  goal_body_fat_pct: 12, goal_lean_mass_lb: 185, goal_bodyweight: 210,
  goal_arm_muscle_lb: 11.8, goal_trunk_muscle_lb: 80, goal_leg_muscle_lb: 30.6,
};

test("recomposition moves from the baseline scan toward the physique, and stays quiet with no scans", () => {
  assert.equal(physiqueView({ profile: goals, scans: [], latestWeighIn: null }).ready, false);
  assert.equal(pairAvg(10.6, 10.8), 10.7);
  assert.equal(recompSpan(26.6, 30, 12).pct, 0);
  assert.equal(recompSpan(26.6, 10, 12).pct, 100);
  const newerWeigh = latestBodyWeight({ log_date: "2026-11-11", pounds: 242.4 }, later);
  assert.equal(newerWeigh.source, "weigh_in");
  assert.equal(newerWeigh.pounds, 242.4);
  const sameDay = latestBodyWeight({ log_date: "2026-11-10", pounds: 242.8 }, later);
  assert.equal(sameDay.source, "weigh_in");
  const scanWins = latestBodyWeight({ log_date: "2026-11-06", pounds: 245.6 }, later);
  assert.equal(scanWins.source, "scan");
  assert.equal(scanWins.pounds, 243.2);
  const view = physiqueView({ profile: goals, scans: [later, baseline], latestWeighIn: { log_date: "2026-11-06", pounds: 245.6 } });
  assert.equal(view.ready, true);
  assert.equal(view.baselineDate, "2026-11-05");
  assert.equal(view.fat.current, 25.1);
  assert.equal(view.fat.pct, 10.3);
  assert.equal(view.lean.pct, 34.1);
  assert.equal(view.weight.current, 243.2);
  assert.equal(view.weight.pct, 7.8);
  assert.equal(view.overall, 17.4);
  assert.equal(view.rings.arms.current, 11);
  assert.equal(view.rings.arms.left, 10.9);
  assert.equal(view.rings.arms.right, 11.1);
  assert.equal(view.rings.arms.pct, 27.3);
  assert.equal(view.rings.trunk.pct, 45.5);
  assert.equal(view.rings.legs.pct, 75);
  assert.equal(view.rings.arms.trend.length, 2);
  assert.equal(view.rings.arms.trend[0].value, 10.7);
  assert.equal(goalFatMassLb({ goal_bodyweight: 210, goal_body_fat_pct: 12 }), 25.2);
  assert.equal(goalFatMassLb({ goal_bodyweight: 210 }), null);
  assert.equal(view.fatMass.goal, 25.2);
  assert.equal(view.fatMass.change, null);
});

test("the earliest scan is the baseline, and fat lost is measured from it", () => {
  const sept = { scan_date: "2026-09-12", body_fat_pct: 28.4, fat_mass_lb: 71.1, lean_mass_lb: 179.3, weight_lb: 250.4, visceral_fat: 13 };
  const oct = { scan_date: "2026-10-08", body_fat_pct: 27.4, fat_mass_lb: 68.0, lean_mass_lb: 180.0, weight_lb: 248.0, visceral_fat: 12 };
  const nov = { scan_date: "2026-11-10", body_fat_pct: 25.1, fat_mass_lb: 63.4, lean_mass_lb: 182.1, weight_lb: 243.2, visceral_fat: 11, arm_left_fat_lb: 4.0, arm_right_fat_lb: 3.9, trunk_fat_lb: 33.8, leg_left_fat_lb: 9.1, leg_right_fat_lb: 9.0 };
  const view = physiqueView({ profile: goals, scans: [nov, oct, sept], latestWeighIn: null });
  assert.equal(view.baselineDate, "2026-09-12");
  assert.equal(view.latestDate, "2026-11-10");
  assert.equal(view.fatMass.current, 63.4);
  assert.equal(view.fatMass.baseline, 71.1);
  assert.equal(view.fatMass.goal, 25.2);
  assert.equal(view.fatMass.change, -7.7);
  assert.equal(view.since.fatLost, 7.7);
  assert.equal(view.since.leanGained, 2.8);
  assert.equal(view.fatMass.trend.length, 3);
  assert.equal(view.fatMass.trend[0].date, "2026-09-12");
  assert.equal(view.fatMass.parts.trunk, 33.8);
  assert.equal(view.fat.baseline, 28.4);
});

test("fat loss rings start at the earliest scan and use the profile goals", () => {
  const early = { scan_date: "2026-07-22", fat_mass_lb: 80, body_fat_pct: 31.5, visceral_fat: 15, weight_lb: 254, lean_mass_lb: 174, arm_left_muscle_lb: 10.1, arm_right_muscle_lb: 10.1, trunk_muscle_lb: 76.1, leg_left_muscle_lb: 29.1, leg_right_muscle_lb: 29.1 };
  const late = { scan_date: "2026-11-05", fat_mass_lb: 65.5, body_fat_pct: 26.6, visceral_fat: 12, weight_lb: 246, lean_mass_lb: 180.6, arm_left_muscle_lb: 10.6, arm_right_muscle_lb: 10.8, trunk_muscle_lb: 78.9, leg_left_muscle_lb: 30.2, leg_right_muscle_lb: 30.2 };
  const view = physiqueView({ profile: { ...goals, goal_visceral_fat: 6 }, scans: [late, early], latestWeighIn: null });
  assert.equal(view.baselineDate, "2026-07-22");
  assert.equal(view.loss.mass.current, 65.5);
  assert.equal(view.loss.mass.baseline, 80);
  assert.equal(view.loss.mass.goal, 25.2);
  assert.equal(view.loss.body.current, 26.6);
  assert.equal(view.loss.body.goal, 12);
  assert.equal(view.loss.visceral.current, 12);
  assert.equal(view.loss.visceral.goal, 6);
  assert.equal(view.loss.visceral.trend[0].date, "2026-07-22");
  assert.equal(view.loss.mass.trend.length, 2);
  assert.equal(view.weight.current, 246);
});

test("a scan photo prefills a draft and does not save", async () => {
  let called = false;
  const missing = await requestScanExtract({ apiKey: "", image: "abc", mediaType: "image/jpeg", fetchImpl: () => { called = true; } });
  assert.equal(called, false);
  assert.equal(missing.ok, false);
  assert.equal(missing.message, SCAN_KEY_MESSAGE);
  const draft = await requestScanExtract({
    apiKey: "test-key",
    image: "abcd",
    mediaType: "image/png",
    fetchImpl: async (_url, opts) => {
      called = true;
      assert.equal(opts.headers["x-api-key"], "test-key");
      assert.equal(String(opts.body).includes("test-key"), false);
      return { ok: true, text: async () => JSON.stringify({ content: [{ type: "text", text: '{"body_fat_pct":25.1,"lean_mass_lb":182.1,"scan_date":"2026-11-10"}' }] }) };
    },
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.saved, undefined);
  assert.equal(draft.fields.body_fat_pct, 25.1);
  assert.equal(draft.fields.lean_mass_lb, 182.1);
  assert.equal(draft.fields.scan_date, "2026-11-10");
  const src = readFileSync(new URL("../api/train-body.js", import.meta.url), "utf8");
  const extract = src.slice(src.indexOf('b.action === "extract"'), src.indexOf('b.action === "save"'));
  assert.doesNotMatch(extract, /\bdb\(/);
  const sql = readFileSync(new URL("../supabase/migrations/20261110_train_body_scans.sql", import.meta.url), "utf8");
  const update = sql.slice(sql.indexOf("update public.profiles"), sql.indexOf("insert into public.body_scans"));
  assert.match(update, /goal_body_fat_pct = 12/);
  assert.match(update, /goal_leg_muscle_lb = 30\.6/);
  assert.match(update, /cb555240-09c4-4038-b797-3cf0b4839939/);
  assert.doesNotMatch(update, /start_bodyweight|goal_bodyweight/);
  assert.match(sql, /on conflict \(user_id, scan_date\) do nothing/i);
  assert.match(sql, /246\.0, 26\.6, 65\.5, 180\.6/);
  assert.match(sql, /for select to authenticated/);
  assert.match(sql, /for insert to authenticated/);
  assert.match(sql, /for update to authenticated/);
  assert.match(sql, /for delete to authenticated/);
});

test("food helpers treat zero as logged and reject junk", () => {
  assert.equal(hasFood(null), false);
  assert.equal(hasFood({ calories: null, protein: null, carbs: null, fat: null }), false);
  assert.equal(hasFood({ calories: 0, protein: null, carbs: null, fat: null }), true);
  assert.equal(cleanMacro(""), null);
  assert.equal(cleanMacro(0), 0);
  assert.equal(cleanMacro("180.26"), 180.3);
  assert.throws(() => cleanMacro(-1), /zero or more/);
  assert.equal(schemaMissing(new Error("Could not find the table 'public.nutrition_logs' in the schema cache")), true);
  assert.equal(schemaMissing(new Error("permission denied")), false);
});
