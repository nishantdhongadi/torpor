// Settings live in browser.storage.local and nowhere else.
//
// This module is imported by the unit tests, so nothing here may touch the
// `browser` global at import time — only inside the functions.

export const DEFAULTS = {
  // Ceiling on how many tabs stay in memory at once. The "when necessary" half.
  maxLoaded: 20,

  // Minutes of disuse before a tab becomes fair game. The "unused" half.
  idleMinutes: 30,

  // How many of the most recently used tabs are untouchable, per window.
  //
  // This is not just politeness. Zen puts every space in a single window, so
  // this is effectively a global LRU, and it is the only thing protecting the
  // inactive pane of a split view — an extension cannot see splits at all.
  // See docs/FINDINGS.md section 1.
  keepWarm: 8,

  // Hosts that are never discarded. Zen Essentials look exactly like ordinary
  // pinned tabs from out here, so this list is the only way to protect them.
  // "example.com" matches that host; "*.example.com" also matches subdomains.
  allowlist: [],

  // Epoch ms. While in the future, sweeps do nothing.
  snoozedUntil: 0,
};

export async function loadSettings() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  return sanitize({ ...DEFAULTS, ...stored });
}

export async function saveSettings(patch) {
  const merged = sanitize({ ...(await loadSettings()), ...patch });
  await browser.storage.local.set(merged);
  return merged;
}

// Storage is user-editable and survives version changes, so treat every value
// as untrusted and fall back rather than throwing inside an alarm handler.
export function sanitize(settings) {
  const int = (value, fallback, min, max) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  return {
    maxLoaded: int(settings.maxLoaded, DEFAULTS.maxLoaded, 1, 500),
    idleMinutes: int(settings.idleMinutes, DEFAULTS.idleMinutes, 1, 10_080),
    keepWarm: int(settings.keepWarm, DEFAULTS.keepWarm, 0, 100),
    allowlist: Array.isArray(settings.allowlist)
      ? settings.allowlist.filter((entry) => typeof entry === "string")
      : DEFAULTS.allowlist,
    snoozedUntil: int(settings.snoozedUntil, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function parseAllowlist(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}
