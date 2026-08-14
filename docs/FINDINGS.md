# How Zen Browser actually handles tabs, spaces, and memory

Everything here was checked against a real install rather than documentation, because the
documentation and the community answers are both partly wrong about the interesting parts.
Every claim below carries the command that produced it, so it can be re-checked against a
future Zen build.

Environment at time of writing:

| | |
|---|---|
| Zen | 1.21.14b |
| Gecko | 153.0.4 |
| Build ID | 20260811103047 |
| Platform | macOS (darwin 24.6.0) |
| Date | 2026-08-14 |

```bash
cat /Applications/Zen.app/Contents/Resources/application.ini
```

---

## 1. Zen does not use tab hiding for spaces

This is the finding that determines what an extension can and cannot do, and it is the
opposite of what you would guess.

The obvious mental model is that Zen hides the tabs belonging to inactive spaces, which would
mean a WebExtension could call `tabs.query({hidden: true})` and get back exactly the set of
"tabs in some other space" — a perfect signal for aggressive unloading.

That model is wrong. Zen keeps every tab visible in `gBrowser` terms and separates spaces
using a `zen-workspace-id` attribute plus per-space DOM containers, calling
`gBrowser.showTab()` on space entry:

```bash
unzip -p /Applications/Zen.app/Contents/Resources/browser/omni.ja \
  'modules/zen/ZenSpaceManager.mjs' | grep -nE 'zen-workspace-id|showTab|hidden'
```

```
248:  tab.setAttribute("zen-workspace-id", this.activeWorkspace);
2365: gBrowser.showTab(tab);
```

Confirmed independently against the live session store: of 70 tabs across 5 spaces, **zero**
had `hidden: true`, including the 47 tabs outside the active space.

```
(inActiveWorkspace, hidden) -> count
  (False, False)  47
  (True,  False)  23
```

### What this costs an extension

- `tabs.query({})` returns **all** tabs across **all** spaces. Good — everything is reachable.
- There is **no way to tell which space a tab belongs to**. `zen-workspace-id` is a chrome-level
  DOM attribute; the WebExtension `tabs.Tab` object does not carry it.
- Therefore an extension cannot implement "unload the space I just left." It has to work from
  recency instead. In practice this is nearly equivalent: a tab in a space you are not looking
  at is idle by definition.

This also settles [zen-browser/desktop#8989](https://github.com/zen-browser/desktop/issues/8989)
("Extension not seeing tabs in deselected workspaces", closed as not planned). Extensions *do*
see those tabs. What they don't see is the space grouping.

## 2. Essentials are indistinguishable from pinned tabs

Zen Essentials carry a `zen-essential` chrome attribute, but at the WebExtension layer they
surface as ordinary pinned tabs. Both Essentials in the sampled profile reported
`pinned: true`, with no property distinguishing them from the other 14 pinned tabs.

Consequence: an extension that wants to protect Essentials must do it with a user-maintained
URL allowlist. There is no programmatic route.

## 3. Zen has built-in space unloading — but only manually

Zen ships `unloadWorkspace()` and `unloadAllOtherWorkspaces()`, surfaced in the space context
menu as *Unload Space* and *Unload All Other Spaces*:

```bash
unzip -p /Applications/Zen.app/Contents/Resources/browser/omni.ja \
  'modules/zen/ZenSpaceManager.mjs' | sed -n '1475,1510p'
unzip -p /Applications/Zen.app/Contents/Resources/browser/omni.ja \
  'localization/en-US/browser/zen-workspaces.ftl' | grep -A2 unload
```

```js
async unloadAllOtherWorkspaces() {
  const workspaceId = this.#contextMenuData?.workspaceId || this.activeWorkspace;
  const tabsToUnload = this.allStoredTabs.filter(
    tab =>
      tab.getAttribute("zen-workspace-id") !== workspaceId &&
      !tab.hasAttribute("zen-empty-tab") &&
      !tab.hasAttribute("zen-essential") &&
      !tab.hasAttribute("pending")
  );
  await gBrowser.explicitUnloadTabs(tabsToUnload);
}
```

Worth noting for anyone building on this:

- It excludes `zen-essential` but **not** `pinned` — Zen itself considers pinned tabs fair game
  for unloading. Torpor follows that precedent.
- `!tab.hasAttribute("pending")` is Zen's "already unloaded" check.
- There is no keyboard shortcut and no automation hook. It is a menu item or nothing.
- `gBrowser.explicitUnloadTabs()` is chrome-privileged and unreachable from an extension.

## 4. Time-based auto-unloading was removed from Zen

`zen.tab-unloader.timeout-minutes` no longer does anything; community guides still recommending
it are stale. Zen now relies entirely on Firefox's low-memory unloader, which fires only under
genuine memory pressure — not after a period of disuse.

```bash
unzip -p /Applications/Zen.app/Contents/Resources/browser/omni.ja \
  'defaults/preferences/firefox.js' | grep -E 'unloadOnLowMemory|min_inactive_duration'
```

```
pref("browser.tabs.unloadOnLowMemory", true);
pref("browser.tabs.min_inactive_duration_before_unload", 600000);
```

So on a machine with plenty of RAM, tabs are never unloaded at all, no matter how long they sit.
That gap is the reason this extension exists.

## 5. Zen Mods cannot run JavaScript

Zen's Mods system handles only `chrome.css` and a `preferences.json` of CSS-variable-backed
settings. There is no script entry point:

```bash
unzip -p /Applications/Zen.app/Contents/Resources/browser/omni.ja \
  'chrome/browser/content/browser/zen-components/ZenMods.mjs' | grep -nE 'chrome\.css|\.js'
```

Reaching `gZenWorkspaces.unloadAllOtherWorkspaces()` therefore requires an fx-autoconfig
`config.js` inside `/Applications/Zen.app`, which macOS code-signing dislikes and every Zen
update erases. Rejected for this project.

## 6. Zen requires signed extensions

`xpinstall.signatures.required` is ignored on release-channel Gecko builds, and Zen is one.
Distribution options are AMO listed, or AMO **unlisted** self-distribution
(`web-ext sign --channel=unlisted`), or `about:debugging` temporary installs that vanish on
restart. Torpor uses unlisted signing.

## 7. The profile this was designed against

Decoded from `sessionstore-backups/recovery.jsonlz4` (mozlz4 = 8-byte `mozLz40\0` magic +
4-byte LE size + a raw LZ4 block; see `scripts/inspect-session.mjs`):

| Metric | Value |
|---|---|
| Tabs | 70 |
| Spaces | 5 (23 / 15 / 15 / 12 / 5) |
| Windows | 1 |
| Pinned | 14 |
| Essentials | 2 (both also `pinned: true`) |
| Median idle | ~45 hours |
| Idle > 2 h | 63 tabs |
| Idle > 24 h | 41 tabs |
| Idle > 7 d | 28 tabs |

Two numbers drove the defaults. **All 70 tabs live in one window**, so any "N most recent per
window" heuristic is really a global LRU — which is why `keepWarm` defaults to 8 rather than
2 or 3. And **41 of 70 tabs are idle beyond a day**, so a 30-minute idle threshold reclaims the
long tail without ever touching the working set.

Reproduce with:

```bash
node scripts/inspect-session.mjs
```

## 8. Open question left for runtime verification

Zen's unload path uses `gBrowser.explicitUnloadTabs()`, which marks tabs `pending`. Torpor uses
the WebExtension `tabs.discard()`. Whether these produce an identical end state — specifically
whether a `tabs.discard()`ed tab is `pending` as far as Zen's own filters are concerned — could
not be settled from source reading alone. See verification step 3 in the README.
