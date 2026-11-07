function layoutWiderThanScreen(m) {
  const byScreen = m.screenWidth > 0 && m.innerWidth > m.screenWidth * 1.2;
  const byDevice = m.deviceNarrow === true && m.layoutWide === true;
  return !!(byScreen || byDevice);
}

function layoutFactsText(m) {
  const button = m.openLog ? m.openLog.w + "x" + m.openLog.h : "";
  return [
    "train layout",
    "version " + (m.version || ""),
    "viewport " + (m.viewport || ""),
    "inner " + m.innerWidth + "x" + m.innerHeight,
    "screen " + m.screenWidth + "x" + m.screenHeight,
    "visual " + m.vvWidth + "x" + m.vvHeight + " scale " + m.vvScale,
    "dpr " + m.dpr,
    "deviceNarrow " + m.deviceNarrow,
    "layoutWide " + m.layoutWide,
    "standalone " + m.standalone,
    "scrollWidth " + m.scrollWidth,
    "main " + m.mainWidth,
    "header " + m.headerWidth,
    "nav " + m.navWidth,
    "bodyFont " + m.bodyFont,
    "openLog " + button,
    "widerThanScreen " + layoutWiderThanScreen(m),
  ].join("\n");
}
