# Torpor

Keeps a large tab collection in [Zen Browser](https://zen-browser.app) without keeping it in
memory. Tabs stay exactly where they are — same space, same position — but the ones you are
not using get taken out of RAM and reload when you open them.

Named for the state animals enter to survive scarcity: metabolism suspended, waking unchanged.

## Why this exists

Zen removed its time-based tab unloader. What remains is Firefox's low-memory unloader, which
only fires under genuine memory pressure — so on a machine with plenty of RAM, tabs are never
unloaded at all, however long they sit. Zen does ship *Unload Space* and *Unload All Other
Spaces* in the space context menu, but they are manual, keyboard-shortcutless, and something
you have to remember to do.

Torpor is the missing automation.

## How it decides

Two rules, evaluated once a minute.

**Unused** — a tab untouched for longer than the idle threshold (30 minutes by default) is
unloaded. On a real profile this is most of them; the tab you are reading is not affected.

**Necessary** — if more than `maxLoaded` tabs (20 by default) are still in memory, the
least-recently-used are unloaded until the count is back under the ceiling. This is the rule
that catches a busy afternoon, when nothing has been idle long enough for the first rule.

Never touched:

- the tab you are looking at
- anything playing audio
- the 8 most recently used tabs (`keepWarm`)
- any host on your allowlist — entries can be written however is convenient
  (`example.com`, `*.example.com`, `localhost:3000`, or a URL pasted straight from the address
  bar), and are resolved with the same URL parser used to match tabs
- `about:`, `chrome:`, `moz-extension:`, `view-source:` and `file:` pages
- anything holding unsaved work — a page with a `beforeunload` handler refuses to be
  discarded, and Torpor lets it win rather than injecting a content script to second-guess it

Pinned tabs *are* unloaded. That is deliberate: Zen's own *Unload Space* does the same, sparing
only Essentials.

## Two things you should know before installing

**Essentials need to go on the allowlist.** Zen Essentials are indistinguishable from ordinary
pinned tabs at the extension layer — same `pinned: true`, no distinguishing property. There is
no way to detect them programmatically, so add their hosts in Settings.

**`keepWarm` is a floor, and it outranks the ceiling.** If you set it above `maxLoaded`, that
many tabs stay resident and the budget never binds. The settings page says so when the two
conflict rather than letting the smaller number look effective.

**`keepWarm` is what protects split view.** An extension cannot see that a split exists; only
one of the two panes is `active`, and the other looks like any inactive tab. The default of 8
covers it in practice. If a pane ever goes blank, raise it.

All of these fall out of how Zen implements spaces. The full investigation, with commands to
re-verify every claim against a future Zen build, is in [`docs/FINDINGS.md`](docs/FINDINGS.md).

## What it can see

`tabs`, `storage` and `alarms`. That is the whole permission list — no host permissions, no
content scripts, no web-accessible resources.

There is no network code anywhere in the extension: no `fetch`, no `XMLHttpRequest`, no
`WebSocket`, no telemetry endpoint. Nothing leaves your machine. The only thing stored is your
own settings and a count of how many tabs have been unloaded.

The `tabs` permission does grant access to tab URLs, which is unavoidable — the allowlist has
to match on hostnames. `grep -rn 'fetch\|XMLHttpRequest\|WebSocket' src/` returns nothing, and
`npx web-ext build` will show you exactly which files ship.

## Install

Zen enforces extension signatures — `xpinstall.signatures.required` does nothing on a release
Gecko build — so a self-built copy has to be signed before it will install permanently.

```bash
npm install
npm test                                    # 42 tests, no browser needed
npx web-ext sign --channel=unlisted \
  --api-key=$AMO_KEY --api-secret=$AMO_SECRET
```

Credentials are free from
[addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/).
`--channel=unlisted` self-distributes: no public listing, no review queue. Install the signed
`.xpi` from `web-ext-artifacts/` via `about:addons` → gear → *Install Add-on From File*.

For development, `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick
`manifest.json`. Temporary installs vanish on restart, which is what you want while iterating.

## Development

```bash
npm test        # node --test, policy.js is pure so this needs no browser
npm run lint    # web-ext lint
npm run run     # launches Zen with a throwaway profile
npm run session # the session-store decoder used for the research
```

Nothing in the test suite launches a browser. `test/policy.test.js` covers the decision itself;
`test/background.test.js` runs the real background script against a fake WebExtension API, which
is the only practical way to cover the things that are invisible from outside — that one tab
closing mid-sweep cannot take the rest of the batch down, that a page refusing to be discarded
is never counted as discarded, and that no state is being cached between alarms.

All the logic lives in one pure function, `selectVictims(tabs, config, now)` in
[`src/policy.js`](src/policy.js). It is pure by necessity, not taste: an MV3 background script
is an event page that Firefox tears down when idle, so anything held in module scope silently
evaporates between alarms. Torpor keeps no state — it reads `tab.lastAccessed`, which Firefox
maintains natively, and derives everything else from its arguments.

`npm run session` decodes your Zen session store (read-only) and prints the tab statistics that
justify the defaults:

```
tabs:        70
spaces:      5 (23 / 15 / 15 / 12 / 5)
hidden:      0   <- 0 means Zen is not using tab hiding for spaces
idle > 24h:  42
```

## Verifying it works

Counts, not megabytes. Firefox exposes no memory API to extensions, so any figure the popup
showed you in MB would be invented. Use `about:processes` for the real number and
`about:unloads` for the unload queue.

Worth checking by hand after installing, because none of these can be settled from source:

1. `about:processes` before and after a sweep — content processes should drop sharply.
2. Switch into a background space and confirm only the tab you land on reloads.
3. Open a split in one space, work in another past the idle threshold, come back — neither
   pane should be blank.
4. Right after a sweep, open the space context menu and pick *Unload Space*: it should be a
   no-op. If it is not, `tabs.discard()` and Zen's `explicitUnloadTabs()` are leaving tabs in
   different states, which is worth knowing.

## Licence

MIT — see [LICENSE](LICENSE).
