// Event page. Assume it is torn down between alarms and rebuilt from nothing.
//
// The one rule here: no module-scope state. Everything the policy needs comes
// from browser.tabs (lastAccessed is maintained by Firefox) or storage.local.
// A `let lastSeen = new Map()` up here would work in testing and quietly stop
// working an hour later, which is the classic MV3 trap.

import { selectVictims } from "./policy.js";
import { loadSettings, saveSettings, DEFAULTS } from "./settings.js";

const ALARM = "sweep";
const SWEEP_PERIOD_MINUTES = 1;

browser.runtime.onInstalled.addListener(async () => {
  await armAlarm();
  // Materialise defaults on first run so the options page has something to show.
  await saveSettings({});
});

browser.runtime.onStartup.addListener(armAlarm);

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) sweep();
});

async function armAlarm() {
  await browser.alarms.clear(ALARM);
  browser.alarms.create(ALARM, { periodInMinutes: SWEEP_PERIOD_MINUTES });
}

/**
 * One pass: read the world, decide, act, record.
 * @returns {Promise<number>} how many tabs actually ended up discarded
 */
async function sweep() {
  const [tabs, settings] = await Promise.all([browser.tabs.query({}), loadSettings()]);
  const victims = selectVictims(tabs, settings, Date.now());
  if (!victims.length) return 0;

  // One call per tab, not one call for the batch. tabs.discard() rejects the
  // whole request if any single id has gone stale, and tabs close underneath a
  // sweep all the time. Fifty promises once a minute costs nothing.
  const results = await Promise.allSettled(
    victims.map((id) => browser.tabs.discard(id))
  );

  const failed = results.filter((r) => r.status === "rejected").length;

  // A fulfilled promise is not proof. tabs.discard() resolves without doing
  // anything for the active tab, and a page holding a prompting beforeunload
  // handler refuses outright — which is exactly the unsaved-work protection we
  // want, so we let it happen and count the truth afterwards rather than
  // injecting a content script to sniff form state.
  const after = await browser.tabs.query({ discarded: true });
  const discardedIds = new Set(after.map((tab) => tab.id));
  const confirmed = victims.filter((id) => discardedIds.has(id)).length;

  if (failed) console.debug(`[torpor] ${failed} discard call(s) rejected`);
  await bumpStats(confirmed);
  return confirmed;
}

async function bumpStats(discarded) {
  if (!discarded) return;
  const { stats = { discarded: 0 } } = await browser.storage.local.get("stats");
  await browser.storage.local.set({
    stats: { discarded: stats.discarded + discarded, lastSweep: Date.now() },
  });
}

async function getStatus() {
  const [tabs, settings, { stats = { discarded: 0 } }] = await Promise.all([
    browser.tabs.query({}),
    loadSettings(),
    browser.storage.local.get("stats"),
  ]);

  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  const now = Date.now();

  return {
    total: tabs.length,
    discarded: tabs.filter((tab) => tab.discarded).length,
    // What a sweep would do right now, so the popup can promise honestly.
    pending: selectVictims(tabs, settings, now).length,
    snoozedUntil: settings.snoozedUntil > now ? settings.snoozedUntil : 0,
    lifetimeDiscarded: stats.discarded,
    activeHost: hostOf(active?.url),
    activeHostAllowlisted:
      !!active && settings.allowlist.some((entry) => matchesHost(entry, hostOf(active.url))),
  };
}

browser.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case "getStatus":
      return getStatus();

    case "sweepNow":
      return sweep().then((discarded) => ({ discarded }));

    case "snooze":
      return saveSettings({ snoozedUntil: Date.now() + message.minutes * 60_000 }).then(
        () => ({ ok: true })
      );

    case "unsnooze":
      return saveSettings({ snoozedUntil: 0 }).then(() => ({ ok: true }));

    case "toggleAllowlistHost":
      return toggleAllowlistHost(message.host).then((allowlisted) => ({ allowlisted }));

    default:
      return undefined; // not ours
  }
});

async function toggleAllowlistHost(host) {
  if (!host) return false;
  const { allowlist } = await loadSettings();

  const already = allowlist.some((entry) => matchesHost(entry, host));
  const next = already
    ? allowlist.filter((entry) => !matchesHost(entry, host))
    : [...allowlist, host];

  await saveSettings({ allowlist: next });
  return !already;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Mirrors policy.js matching so the popup's "protected" badge cannot disagree
// with what the sweep actually does.
function matchesHost(entry, host) {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed || !host) return false;
  if (trimmed.startsWith("*.")) {
    const base = trimmed.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === trimmed;
}

export { DEFAULTS };
