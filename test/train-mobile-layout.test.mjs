import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../train/index.html", import.meta.url), "utf8");
const head = html.slice(0, html.indexOf("</head>"));

test("viewport meta is in the head and uses the device width", () => {
  const tags = [...head.matchAll(/<meta\s+name="viewport"\s+content="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(tags.length, 1, "one viewport meta, in the head");
  assert.match(tags[0], /(^|,)\s*width=device-width\s*(,|$)/);
  assert.match(tags[0], /initial-scale=1(?!\d)/);
  assert.doesNotMatch(tags[0], /width=\d/);
  assert.doesNotMatch(tags[0], /maximum-scale|user-scalable\s*=\s*no/);
});

test("daily rows stay stacked instead of stretching to fill the screen", () => {
  const rule = html.match(/\.metrics\{[^}]*\}/);
  assert.ok(rule, "metrics rule");
  assert.match(rule[0], /justify-content:flex-start/);
  assert.doesNotMatch(html, /space-evenly/);
  assert.match(html, /\.acts\{[^}]*margin-top:auto/);
});

test("a logged set opens an editor with a rust Save and a secondary Delete", () => {
  const sheet = html.slice(html.indexOf('id="setSheet"'), html.indexOf('id="swapShade"'));
  assert.match(sheet, /id="saveEdit"/);
  assert.match(sheet, /btn rust pill/);
  assert.match(html, /Delete this set\?/);
  assert.match(html, /data-edit-step="-1"/);
  assert.match(html, /data-edit-step="1"/);
  assert.match(html, /function openSetEditor/);
  assert.match(html, /action: "edit-set"/);
  assert.match(html, /action: "delete-set"/);
  assert.equal(sheet.includes("\u2014"), false);
  assert.equal(html.slice(html.indexOf("function editorHtml"), html.indexOf("function syncEditor")).includes("btn rust"), false);
  const danger = html.match(/#setSheet \.btn\.danger\{[^}]*\}/);
  assert.ok(danger, "delete button style");
  assert.match(danger[0], /background:transparent/);
  assert.doesNotMatch(danger[0], /background:var\(--rust\)/);
});

test("the phone column is full width until the desktop breakpoint", () => {
  const main = html.match(/body\.in main\{[^}]*\}/);
  assert.ok(main, "main rule");
  assert.match(main[0], /max-width:none/);
  assert.doesNotMatch(main[0], /max-width:\s*520px/);
  const desktop = html.match(/@media \(min-width:\s*800px\)\{[^}]*\}/);
  assert.ok(desktop, "desktop breakpoint");
  assert.match(desktop[0], /max-width:720px/);
  assert.match(html, /-webkit-text-size-adjust:100%/);
});
