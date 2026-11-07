import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../train/layout-facts.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../train/index.html", import.meta.url), "utf8");
const ctx = { layoutWiderThanScreen: null, layoutFactsText: null };
vm.runInNewContext(code + "\nthis.layoutWiderThanScreen = layoutWiderThanScreen;\nthis.layoutFactsText = layoutFactsText;", ctx);

test("a phone-sized screen with a desktop layout width is flagged", () => {
  assert.equal(ctx.layoutWiderThanScreen({ screenWidth: 412, innerWidth: 980, deviceNarrow: true, layoutWide: true }), true);
  assert.equal(ctx.layoutWiderThanScreen({ screenWidth: 1080, innerWidth: 980, deviceNarrow: true, layoutWide: true }), true);
  assert.equal(ctx.layoutWiderThanScreen({ screenWidth: 360, innerWidth: 980, deviceNarrow: false, layoutWide: false }), true);
});

test("a normal phone and a desktop window are not flagged", () => {
  assert.equal(ctx.layoutWiderThanScreen({ screenWidth: 412, innerWidth: 412, deviceNarrow: false, layoutWide: false }), false);
  assert.equal(ctx.layoutWiderThanScreen({ screenWidth: 1920, innerWidth: 1280, deviceNarrow: false, layoutWide: true }), false);
  assert.equal(ctx.layoutWiderThanScreen({ screenWidth: 1080, innerWidth: 412, deviceNarrow: false, layoutWide: false }), false);
});

test("the readout is copyable text and leaves out account data", () => {
  const text = ctx.layoutFactsText({
    version: "train-v9", viewport: "width=device-width, initial-scale=1, viewport-fit=cover",
    innerWidth: 980, innerHeight: 1740, screenWidth: 412, screenHeight: 915,
    vvWidth: 980, vvHeight: 1740, vvScale: 1, dpr: 2.625,
    deviceNarrow: true, layoutWide: true, standalone: true, scrollWidth: 980,
    mainWidth: 720, headerWidth: 720, navWidth: 720, bodyFont: "16px", openLog: { w: 339, h: 64 },
  });
  assert.match(text, /inner 980x1740/);
  assert.match(text, /screen 412x915/);
  assert.match(text, /main 720/);
  assert.match(text, /widerThanScreen true/);
  assert.doesNotMatch(text, /@|pounds|calorie|token|password/i);
});

test("the page shows that readout only for the wide-layout case and does not send it", () => {
  assert.match(html, /src="\/train\/layout-facts\.js"/);
  assert.match(html, /#scaleNote/);
  assert.match(html, /@media \(max-device-width:\s*640px\) and \(min-width:\s*800px\)/);
  assert.match(html, /id="copySize"/);
  assert.match(html, /id="scaleText"/);
  const note = html.slice(html.indexOf('id="scaleNote"'), html.indexOf("</header>"));
  assert.doesNotMatch(note, /fetch\(|sendBeacon|XMLHttpRequest/);
  assert.doesNotMatch(html, /maximum-scale|user-scalable\s*=\s*no/);
});
