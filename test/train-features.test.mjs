import test from "node:test";
import assert from "node:assert/strict";
import {
  substitutionOptions, prescribeSwap, buildSlotSuggestion, suggest, applyToday,
  cleanMacro, hasFood, replacementKind, normalizeName, schemaMissing,
  mealTotals, normalizeMealEstimate, effectiveDayFood, foodBar, foodChip,
  presentSessionFood, requestMealEstimate, foodActionWrites, FOOD_KEY_MESSAGE,
  chicagoDate, weightProgress, seanWeightDefaults, profilePatchForSean, shouldSeedWeighIn, targetsOf,
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
