import test from "node:test";
import assert from "node:assert/strict";

import { selectVictims, DISCARD_FLOOR_MS } from "../src/policy.js";
import { DEFAULTS } from "../src/settings.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

// A tab that is eligible for discard unless a test says otherwise: inactive,
// silent, loaded, ordinary http URL, idle for two hours.
let nextId = 1;
function tab(overrides = {}) {
  return {
    id: nextId++,
    windowId: 1,
    active: false,
    audible: false,
    discarded: false,
    pinned: false,
    url: `https://example.com/${nextId}`,
    lastAccessed: NOW - 120 * MIN,
    ...overrides,
  };
}

// Config with the guards switched off, so each test can isolate one rule.
// keepWarm: 0 and maxLoaded: Infinity mean only the idle sweep runs.
function config(overrides = {}) {
  return {
    ...DEFAULTS,
    keepWarm: 0,
    maxLoaded: Infinity,
    idleMinutes: 30,
    allowlist: [],
    snoozedUntil: 0,
    ...overrides,
  };
}

const run = (tabs, cfg = config(), now = NOW) => selectVictims(tabs, cfg, now);

test("discards a tab idle past the threshold", () => {
  const t = tab();
  assert.deepEqual(run([t]), [t.id]);
});

test("leaves a tab idle for less than the threshold", () => {
  const t = tab({ lastAccessed: NOW - 10 * MIN });
  assert.deepEqual(run([t]), []);
});

test("never discards the active tab", () => {
  const t = tab({ active: true, lastAccessed: NOW - 999 * MIN });
  assert.deepEqual(run([t]), []);
});

test("never discards an audible tab", () => {
  const t = tab({ audible: true });
  assert.deepEqual(run([t]), []);
});

test("skips tabs that are already discarded", () => {
  const t = tab({ discarded: true });
  assert.deepEqual(run([t]), []);
});

test("discards pinned tabs — Zen's own Unload Space does too", () => {
  const t = tab({ pinned: true });
  assert.deepEqual(run([t]), [t.id]);
});

test("skips privileged and internal URLs", () => {
  const tabs = [
    tab({ url: "about:config" }),
    tab({ url: "chrome://browser/content/browser.xhtml" }),
    tab({ url: "moz-extension://abc/options.html" }),
    tab({ url: "view-source:https://example.com" }),
    tab({ url: "" }),
  ];
  assert.deepEqual(run(tabs), []);
});

test("allowlist protects an exact host", () => {
  const t = tab({ url: "https://mail.google.com/inbox" });
  assert.deepEqual(run([t], config({ allowlist: ["mail.google.com"] })), []);
});

test("allowlist wildcard protects subdomains but not a lookalike suffix", () => {
  const sub = tab({ url: "https://docs.example.com/a" });
  const apex = tab({ url: "https://example.com/b" });
  const lookalike = tab({ url: "https://notexample.com/c" });

  const victims = run(
    [sub, apex, lookalike],
    config({ allowlist: ["*.example.com"] })
  );
  assert.deepEqual(victims, [lookalike.id]);
});

test("allowlist ignores case, whitespace and blank lines", () => {
  const t = tab({ url: "https://Example.COM/x" });
  assert.deepEqual(run([t], config({ allowlist: ["  ExAmPlE.com  ", ""] })), []);
});

test("keepWarm protects the N most recently accessed tabs", () => {
  const tabs = [
    tab({ lastAccessed: NOW - 100 * MIN }),
    tab({ lastAccessed: NOW - 200 * MIN }),
    tab({ lastAccessed: NOW - 300 * MIN }),
    tab({ lastAccessed: NOW - 400 * MIN }),
  ];
  const victims = run(tabs, config({ keepWarm: 2 }));
  assert.deepEqual(victims.sort(), [tabs[2].id, tabs[3].id].sort());
});

test("keepWarm applies per window, not globally", () => {
  const a = [
    tab({ windowId: 1, lastAccessed: NOW - 100 * MIN }),
    tab({ windowId: 1, lastAccessed: NOW - 200 * MIN }),
  ];
  const b = [
    tab({ windowId: 2, lastAccessed: NOW - 300 * MIN }),
    tab({ windowId: 2, lastAccessed: NOW - 400 * MIN }),
  ];
  // One tab survives in each window, not one across both.
  const victims = run([...a, ...b], config({ keepWarm: 1 }));
  assert.deepEqual(victims.sort(), [a[1].id, b[1].id].sort());
});

test("snooze suppresses everything", () => {
  const tabs = [tab(), tab(), tab()];
  const cfg = config({ snoozedUntil: NOW + 5 * MIN, maxLoaded: 1 });
  assert.deepEqual(run(tabs, cfg), []);
});

test("an expired snooze does not suppress", () => {
  const t = tab();
  assert.deepEqual(run([t], config({ snoozedUntil: NOW - 1 })), [t.id]);
});

test("budget stage evicts least-recently-accessed first", () => {
  // All well inside the idle threshold, so only the budget stage can act.
  const recent = tab({ lastAccessed: NOW - 5 * MIN });
  const middle = tab({ lastAccessed: NOW - 6 * MIN });
  const oldest = tab({ lastAccessed: NOW - 7 * MIN });

  const victims = run([recent, middle, oldest], config({ maxLoaded: 2 }));
  assert.deepEqual(victims, [oldest.id]);
});

test("budget stage counts already-discarded tabs as free", () => {
  const loaded = [tab({ lastAccessed: NOW - 5 * MIN }), tab({ lastAccessed: NOW - 6 * MIN })];
  const parked = [tab({ discarded: true }), tab({ discarded: true })];

  // Four tabs, budget of two, but two are already discarded: nothing to do.
  assert.deepEqual(run([...loaded, ...parked], config({ maxLoaded: 2 })), []);
});

test("budget stage will not touch a tab left within the floor", () => {
  const justLeft = tab({ lastAccessed: NOW - 10_000 });
  const older = tab({ lastAccessed: NOW - 5 * MIN });

  assert.ok(DISCARD_FLOOR_MS > 10_000, "fixture must sit inside the floor");
  assert.deepEqual(run([justLeft, older], config({ maxLoaded: 1 })), [older.id]);
});

test("over budget with every candidate inside the floor discards nothing", () => {
  const tabs = [
    tab({ lastAccessed: NOW - 1_000 }),
    tab({ lastAccessed: NOW - 2_000 }),
    tab({ lastAccessed: NOW - 3_000 }),
  ];
  // Staying over budget for one more tick beats yanking a tab the user just left.
  assert.deepEqual(run(tabs, config({ maxLoaded: 1 })), []);
});

test("budget stage respects keepWarm and the allowlist", () => {
  const warm = tab({ lastAccessed: NOW - 5 * MIN });
  const safe = tab({ lastAccessed: NOW - 6 * MIN, url: "https://keep.me/x" });
  const victim = tab({ lastAccessed: NOW - 7 * MIN });

  const cfg = config({ maxLoaded: 1, keepWarm: 1, allowlist: ["keep.me"] });
  assert.deepEqual(run([warm, safe, victim], cfg), [victim.id]);
});

test("returns no duplicates when both stages select the same tab", () => {
  const tabs = [
    tab({ lastAccessed: NOW - 200 * MIN }),
    tab({ lastAccessed: NOW - 300 * MIN }),
  ];
  const victims = run(tabs, config({ maxLoaded: 0 }));
  assert.equal(new Set(victims).size, victims.length);
  assert.equal(victims.length, 2);
});

test("tolerates a tab with no lastAccessed", () => {
  const t = tab({ lastAccessed: undefined });
  assert.doesNotThrow(() => run([t]));
});

test("handles an empty tab list", () => {
  assert.deepEqual(run([]), []);
});

test("does not mutate its inputs", () => {
  const tabs = [tab(), tab({ lastAccessed: NOW - 400 * MIN })];
  const before = JSON.stringify(tabs);
  run(tabs, config({ maxLoaded: 1, keepWarm: 1 }));
  assert.equal(JSON.stringify(tabs), before);
});

// The shape that actually matters: one window, five spaces, a long idle tail.
// See docs/FINDINGS.md section 7.
test("real profile shape: 70 tabs collapse to the warm set", () => {
  const tabs = [];
  for (let i = 0; i < 70; i++) {
    tabs.push(
      tab({
        windowId: 1, // every tab in one window, as Zen actually arranges it
        pinned: i < 14,
        active: i === 0,
        // A handful touched in the last few minutes, the rest trailing into days.
        lastAccessed: NOW - (i < 6 ? i * MIN : i * 60 * MIN),
      })
    );
  }

  const victims = selectVictims(tabs, { ...DEFAULTS, snoozedUntil: 0 }, NOW);
  const survivors = tabs.filter((t) => !victims.includes(t.id)).map((t) => t.id);

  // With a profile this idle the sweep dominates and the budget never binds, so
  // what is left is exactly the warm set. This is the point of the whole thing:
  // 70 tabs still in the strip, 8 of them in memory.
  assert.deepEqual(survivors, tabs.slice(0, DEFAULTS.keepWarm).map((t) => t.id));
  assert.ok(survivors.length <= DEFAULTS.maxLoaded, "never above the budget");
  assert.ok(survivors.includes(tabs[0].id), "the active tab survives");
});

test("a busy burst is caught by the budget even when nothing is idle yet", () => {
  // 30 tabs all touched within the last few minutes: the idle sweep has nothing
  // to say, so only maxLoaded keeps memory bounded.
  const tabs = Array.from({ length: 30 }, (_, i) =>
    tab({ active: i === 0, lastAccessed: NOW - (i + 2) * MIN })
  );

  const victims = selectVictims(tabs, { ...DEFAULTS, snoozedUntil: 0 }, NOW);
  assert.equal(30 - victims.length, DEFAULTS.maxLoaded);
});

// Real-world allowlist input. People copy out of the URL bar; an entry that
// silently fails to match is worse than no allowlist at all, because the tab it
// was supposed to protect gets unloaded anyway.
test("allowlist accepts a pasted URL", () => {
  const t = tab({ url: "https://mail.google.com/mail/u/0/#inbox" });
  const cfg = config({ allowlist: ["https://mail.google.com/mail/u/0/#inbox"] });
  assert.deepEqual(run([t], cfg), []);
});

test("allowlist accepts a host with a trailing slash or port", () => {
  const a = tab({ url: "https://example.com/x" });
  const b = tab({ url: "http://localhost:3000/app" });
  assert.deepEqual(run([a, b], config({ allowlist: ["example.com/", "localhost:3000"] })), []);
});

test("allowlist accepts a wildcard written as a URL", () => {
  const t = tab({ url: "https://team.notion.so/page" });
  assert.deepEqual(run([t], config({ allowlist: ["*.notion.so/"] })), []);
});

test("allowlist still rejects an unrelated host", () => {
  const t = tab({ url: "https://evil.com/x" });
  assert.deepEqual(run([t], config({ allowlist: ["example.com"] })), [t.id]);
});

test("allowlist entries are parsed the same way tab URLs are", () => {
  // A regex that disagrees with the URL parser is how an entry ends up
  // protecting a host the user did not mean. Backslashes are the classic case:
  // browsers read this URL's host as good.com, so the entry must too.
  const good = tab({ url: "https://good.com/x" });
  assert.deepEqual(run([good], config({ allowlist: ["https://good.com\\@evil.com"] })), []);

  const evil = tab({ url: "https://evil.com/x" });
  assert.deepEqual(run([evil], config({ allowlist: ["https://good.com\\@evil.com"] })), [
    evil.id,
  ]);
});

test("allowlist handles credentials and internationalised hosts", () => {
  const t = tab({ url: "https://example.com/x" });
  assert.deepEqual(run([t], config({ allowlist: ["user:pass@example.com"] })), []);
});

test("allowlist drops entries that name no host", () => {
  const t = tab();
  const cfg = config({ allowlist: ["", "   ", "*.", "not a host", "https://"] });
  assert.deepEqual(run([t], cfg), [t.id]);
});

test("allowlist reads a wildcard the same way with or without a scheme", () => {
  // The README advertises both wildcards and pasting from the address bar, so
  // the combination has to work rather than producing a dead entry.
  const t = tab({ url: "https://team.notion.so/page" });
  for (const entry of ["*.notion.so", "https://*.notion.so", "https://*.notion.so/page"]) {
    assert.deepEqual(run([t], config({ allowlist: [entry] })), [], `entry: ${entry}`);
  }
});

test("a scheme-prefixed wildcard still does not match a lookalike", () => {
  const t = tab({ url: "https://notnotion.so/x" });
  assert.deepEqual(run([t], config({ allowlist: ["https://*.notion.so"] })), [t.id]);
});
