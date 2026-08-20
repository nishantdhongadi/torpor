// The entire decision of what to unload, as one pure function.
//
// Pure on purpose. An MV3 background script is an event page: Firefox tears it
// down when idle, so anything held in module scope silently evaporates between
// alarms. Torpor therefore keeps no state at all — it reads tab.lastAccessed,
// which Firefox maintains natively, and derives everything from the arguments
// it is handed. That also makes the whole policy testable without a browser.

// A tab left in the last minute is never taken by the budget stage, even when
// we are over the ceiling. Being one tab over budget for another 60 seconds is
// cheap; yanking the tab someone just tabbed away from is not.
export const DISCARD_FLOOR_MS = 60_000;

const SKIPPED_SCHEMES = ["about:", "chrome:", "moz-extension:", "view-source:", "file:"];

/**
 * @param {Array<object>} tabs   browser.tabs.Tab objects, any window
 * @param {object} cfg           see settings.js DEFAULTS
 * @param {number} now           epoch ms
 * @returns {Array<number>}      tab ids to discard
 */
export function selectVictims(tabs, cfg, now) {
  if (cfg.snoozedUntil > now) return [];

  const warm = warmTabIds(tabs, cfg.keepWarm);
  const allowlist = normaliseAllowlist(cfg.allowlist);

  const eligible = tabs.filter(
    (tab) => !tab.discarded && isDiscardable(tab, allowlist) && !warm.has(tab.id)
  );

  const victims = new Set();

  // Stage one — unused. Anything sitting untouched past the threshold goes,
  // however many that is. On a real Zen profile this is most of the strip.
  const idleMs = cfg.idleMinutes * 60_000;
  for (const tab of eligible) {
    if (age(tab, now) >= idleMs) victims.add(tab.id);
  }

  // Stage two — necessary. If the working set is still above the ceiling, evict
  // least-recently-used until it is not. This is what catches a busy afternoon,
  // where nothing has been idle long enough for stage one to care.
  let loaded = tabs.filter((tab) => !tab.discarded && !victims.has(tab.id)).length;
  if (loaded > cfg.maxLoaded) {
    const candidates = eligible
      .filter((tab) => !victims.has(tab.id) && age(tab, now) >= DISCARD_FLOOR_MS)
      .sort((a, b) => lastAccessed(a) - lastAccessed(b));

    for (const tab of candidates) {
      if (loaded <= cfg.maxLoaded) break;
      victims.add(tab.id);
      loaded--;
    }
    // If we run out of candidates we simply stay over budget until the next
    // tick. Deliberate: see DISCARD_FLOOR_MS.
  }

  return [...victims];
}

function isDiscardable(tab, allowlist) {
  if (tab.active) return false; // tabs.discard() refuses these anyway
  if (tab.audible) return false;

  const url = tab.url ?? "";
  if (!url) return false;
  if (SKIPPED_SCHEMES.some((scheme) => url.startsWith(scheme))) return false;

  // Pinned tabs are intentionally absent from this list. Zen's own Unload Space
  // discards pinned tabs too — it only spares Essentials, which are invisible
  // from out here. The allowlist is how Essentials get protected.

  return !isAllowlisted(url, allowlist);
}

/**
 * The `keepWarm` most recently accessed tabs in each window, which are off
 * limits regardless of every other rule.
 */
function warmTabIds(tabs, keepWarm) {
  if (keepWarm <= 0) return new Set();

  const byWindow = new Map();
  for (const tab of tabs) {
    if (tab.discarded) continue; // an unloaded tab is not part of the warm set
    const bucket = byWindow.get(tab.windowId) ?? [];
    bucket.push(tab);
    byWindow.set(tab.windowId, bucket);
  }

  const warm = new Set();
  for (const bucket of byWindow.values()) {
    bucket
      .sort((a, b) => lastAccessed(b) - lastAccessed(a))
      .slice(0, keepWarm)
      .forEach((tab) => warm.add(tab.id));
  }
  return warm;
}

// Allowlist entries are typed by hand or pasted out of the URL bar, so accept
// anything that identifies a host: "example.com", "*.example.com",
// "https://example.com/some/path#frag", "localhost:3000". An entry that looks
// right but silently fails to match is worse than no entry at all, because the
// tab it was meant to protect gets unloaded anyway.
export function normaliseAllowlist(allowlist) {
  return (allowlist ?? [])
    .map((entry) => toHostPattern(entry))
    .filter((entry) => entry.host);
}

function toHostPattern(raw) {
  let text = String(raw ?? "").trim().toLowerCase();

  const subdomains = text.startsWith("*.");
  if (subdomains) text = text.slice(2);
  if (!text) return { host: "", subdomains };

  // Parse with the platform's URL parser rather than a regex, so an entry can
  // never be read differently here than the tab URL it is matched against.
  // Hand-written entries have no scheme, so give them one; a bare "localhost:3000"
  // would otherwise parse as a scheme rather than a host and port.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(text);

  try {
    return { host: new URL(hasScheme ? text : `https://${text}`).hostname, subdomains };
  } catch {
    return { host: "", subdomains };
  }
}

function isAllowlisted(url, allowlist) {
  if (!allowlist.length) return false;

  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  return allowlist.some(
    (entry) =>
      host === entry.host || (entry.subdomains && host.endsWith(`.${entry.host}`))
  );
}

// A tab with no lastAccessed (rare, but it happens on restored sessions) is
// treated as ancient rather than as brand new — the conservative reading would
// pin it in memory forever.
const lastAccessed = (tab) => tab.lastAccessed ?? 0;
const age = (tab, now) => now - lastAccessed(tab);
