// Minimal MV3 service worker. The popup does all the work; this exists so
// Chrome keeps the extension loaded and we have a stable place to add
// context menus / commands later.
chrome.runtime.onInstalled.addListener(() => {
  console.log("[HTML-to-Figma] extension installed");
});
