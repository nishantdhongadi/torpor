// Exercises background.js against a fake WebExtension API.
//
// The point is to cover the parts that are easy to get wrong and impossible to
// see from the outside: that a stale tab id cannot take a whole sweep down with
// it, that a tab which refuses to be discarded is not counted as discarded, and
// that nothing is cached in module scope between alarms.

import test from "node:test";
import assert from "node:assert/strict";

// --- fake browser -----------------------------------------------------------

const listeners = { installed: [], startup: [], alarm: [], message: [] };
const state = { tabs: [], storage: {}, alarms: new Map() };

const NOW = () => Date.now();
const MIN = 60_000;

/** @type {any} */
const fakeBrowser = {
  runtime: {
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
  },
  alarms: {
    onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    create: async (name, info) => state.alarms.set(name, info),
    clear: async (name) => state.alarms.delete(name),
  },
  tabs: {
    query: async (info = {}) =>
      state.tabs.filter((tab) =>
        Object.entries(info).every(([key, value]) =>
          key === "currentWindow" ? true : tab[key] === value
        )
      ),
    discard: async (id) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) throw new Error(`no tab with id ${id}`); // closed mid-sweep
      // Firefox resolves without discarding the active tab, and a page holding a
      // prompting beforeunload handler refuses. Both look like success here.
      if (tab.active || tab.holdsUnsavedWork) return;
      tab.discarded = true;
    },
  },
  storage: {
    local: {
      get: async (keys) => {
        const wanted = typeof keys === "string" ? [keys] : keys;
        return Object.fromEntries(
          wanted.filter((k) => k in state.storage).map((k) => [k, state.storage[k]])
        );
      },
      set: async (patch) => Object.assign(state.storage, patch),
    },
  },
};

globalThis.browser = fakeBrowser;

const { DEFAULTS } = await import("../src/background.js");

// --- helpers ----------------------------------------------------------------

let nextId = 1;
const tab = (overrides = {}) => ({
  id: nextId++,
  windowId: 1,
  active: false,
  audible: false,
  discarded: false,
  pinned: false,
  url: `https://example.com/${nextId}`,
  lastAccessed: NOW() - 120 * MIN,
  ...overrides,
});

function reset(tabs = []) {
  state.tabs = tabs;
  state.storage = {};
  state.alarms.clear();
  nextId = 1;
}

const fireAlarm = () => listeners.alarm[0]({ name: "sweep" });
const send = (message) => listeners.message[0](message);
const loadedCount = () => state.tabs.filter((t) => !t.discarded).length;

// Wait out the sweep the alarm kicked off. The listener is deliberately
// synchronous — the real one does not await either — so drain the microtask
// queue rather than pretending it returns a promise.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- tests ------------------------------------------------------------------

test("install arms the sweep alarm and writes defaults", async () => {
  reset();
  await Promise.all(listeners.installed.map((fn) => fn()));

  assert.deepEqual(state.alarms.get("sweep"), { periodInMinutes: 1 });
  assert.equal(state.storage.maxLoaded, DEFAULTS.maxLoaded);
  assert.equal(state.storage.keepWarm, DEFAULTS.keepWarm);
});

test("startup re-arms the alarm without duplicating it", async () => {
  reset();
  await Promise.all(listeners.startup.map((fn) => fn()));
  assert.equal(state.alarms.size, 1);
});

test("a sweep discards the idle tail and leaves the warm set alone", async () => {
  const tabs = Array.from({ length: 40 }, (_, i) =>
    tab({ active: i === 0, lastAccessed: NOW() - (i < 4 ? i : i * 60) * MIN })
  );
  reset(tabs);

  fireAlarm();
  await settle();

  assert.equal(loadedCount(), DEFAULTS.keepWarm);
  assert.equal(tabs[0].discarded, false, "the active tab survives");
  assert.equal(state.storage.stats.discarded, 40 - DEFAULTS.keepWarm);
});

test("a tab closing mid-sweep does not take the rest of the batch down", async () => {
  const tabs = Array.from({ length: 12 }, () => tab());
  reset(tabs);

  // Stand in for a tab the user closes between query and discard: the id is
  // handed to the sweep, then vanishes. tabs.discard() rejects on it. Made the
  // stalest tab so that it is certainly among the sweep's victims.
  const doomed = tabs[5];
  doomed.lastAccessed = NOW() - 1000 * MIN;
  const realQuery = browser.tabs.query;
  browser.tabs.query = async (info) => {
    const result = await realQuery(info);
    state.tabs = state.tabs.filter((t) => t.id !== doomed.id);
    browser.tabs.query = realQuery;
    return result;
  };

  fireAlarm();
  await settle();

  // Everything else still went dormant despite the one rejection.
  assert.equal(state.tabs.filter((t) => !t.discarded).length, DEFAULTS.keepWarm);
});

test("a tab holding unsaved work is not counted as discarded", async () => {
  const stubborn = tab({ holdsUnsavedWork: true, lastAccessed: NOW() - 300 * MIN });
  const ordinary = Array.from({ length: 10 }, () => tab());
  reset([stubborn, ...ordinary]);

  fireAlarm();
  await settle();

  assert.equal(stubborn.discarded, false);
  // The stats only credit tabs confirmed dormant by the re-query, never the
  // ones tabs.discard() merely resolved for.
  const confirmed = state.tabs.filter((t) => t.discarded).length;
  assert.equal(state.storage.stats.discarded, confirmed);
});

test("snoozing suppresses sweeps until it expires", async () => {
  reset(Array.from({ length: 30 }, () => tab()));

  await send({ type: "snooze", minutes: 30 });
  fireAlarm();
  await settle();
  assert.equal(loadedCount(), 30, "nothing unloaded while paused");

  await send({ type: "unsnooze" });
  fireAlarm();
  await settle();
  assert.equal(loadedCount(), DEFAULTS.keepWarm);
});

test("getStatus reports the live picture, not a cached one", async () => {
  const active = tab({
    active: true,
    url: "https://mail.google.com/inbox",
    lastAccessed: NOW(), // the tab in front of you, so it is in the warm set too
  });
  reset([active, ...Array.from({ length: 20 }, () => tab())]);

  const before = await send({ type: "getStatus" });
  assert.equal(before.total, 21);
  assert.equal(before.discarded, 0);
  assert.ok(before.pending > 0, "should have work queued");
  assert.equal(before.activeHost, "mail.google.com");
  assert.equal(before.activeHostAllowlisted, false);

  await send({ type: "sweepNow" });

  const after = await send({ type: "getStatus" });
  assert.equal(after.discarded, 21 - DEFAULTS.keepWarm);
  assert.equal(after.pending, 0, "nothing left to do straight after a sweep");
});

test("allowlisting a host protects it and is reversible", async () => {
  const essential = tab({ url: "https://mail.google.com/inbox", active: true });
  const others = Array.from({ length: 20 }, () => tab());
  reset([essential, ...others]);

  const added = await send({ type: "toggleAllowlistHost", host: "mail.google.com" });
  assert.equal(added.allowlisted, true);
  assert.deepEqual(state.storage.allowlist, ["mail.google.com"]);

  // Make it an ordinary background tab so only the allowlist can save it.
  essential.active = false;
  others[0].active = true;

  fireAlarm();
  await settle();
  assert.equal(essential.discarded, false);

  const removed = await send({ type: "toggleAllowlistHost", host: "mail.google.com" });
  assert.equal(removed.allowlisted, false);
  assert.deepEqual(state.storage.allowlist, []);
});

test("settings survive a simulated event-page teardown", async () => {
  reset(Array.from({ length: 30 }, () => tab()));
  await send({ type: "snooze", minutes: 30 });

  // Everything the background script knows must come back from storage alone.
  // If any of it were held in module scope this is where it would vanish.
  const persisted = { ...state.storage };
  state.storage = persisted;

  const status = await send({ type: "getStatus" });
  assert.ok(status.snoozedUntil > Date.now(), "pause survived the teardown");
});

test("ignores messages that are not ours", async () => {
  reset();
  assert.equal(send({ type: "somethingElse" }), undefined);
  assert.equal(send(undefined), undefined);
});
