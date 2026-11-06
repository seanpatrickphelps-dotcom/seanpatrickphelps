import test from "node:test";
import assert from "node:assert/strict";
import {
  substitutionOptions, prescribeSwap, buildSlotSuggestion, suggest, applyToday,
  cleanMacro, hasFood, replacementKind, normalizeName, schemaMissing,
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
