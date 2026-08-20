import { loadSettings, saveSettings, parseAllowlist, DEFAULTS } from "./settings.js";

const $ = (id) => document.getElementById(id);
const NUMBERS = ["idleMinutes", "maxLoaded", "keepWarm"];

function fill(settings) {
  for (const key of NUMBERS) $(key).value = settings[key];
  $("allowlist").value = settings.allowlist.join("\n");
  warnIfWarmExceedsBudget(settings);
}

// keepWarm is a hard floor, so a keepWarm above maxLoaded quietly wins and the
// budget never binds. Say so rather than letting the setting look effective.
//
// The floor is enforced per window while the ceiling is global, so with several
// windows open the real floor is keepWarm x windows. Comparing the two numbers
// as written would miss that entirely.
function warnIfWarmExceedsBudget({ keepWarm, maxLoaded }) {
  const floor = keepWarm * windowCount;
  const perWindow =
    windowCount > 1 ? ` (${keepWarm} in each of ${windowCount} windows)` : "";

  $("conflict").textContent =
    floor > maxLoaded
      ? `Keeping the last ${keepWarm} tabs warm${perWindow} overrides the ceiling of ${maxLoaded}, so ${floor} will stay in memory.`
      : "";
}

// Read once on load. The warning is advisory, so a window opened while the
// settings page sits there does not need to move it live.
let windowCount = 1;
async function countWindows() {
  const tabs = await browser.tabs.query({});
  windowCount = Math.max(1, new Set(tabs.map((tab) => tab.windowId)).size);
}

async function save() {
  const patch = Object.fromEntries(NUMBERS.map((key) => [key, Number($(key).value)]));
  patch.allowlist = parseAllowlist($("allowlist").value);

  // saveSettings sanitises, so read back what was actually stored rather than
  // leaving the form showing a value that was clamped on the way in.
  fill(await saveSettings(patch));

  $("saved").classList.add("show");
  setTimeout(() => $("saved").classList.remove("show"), 1200);
}

$("save").addEventListener("click", save);
for (const key of NUMBERS) {
  $(key).addEventListener("input", () =>
    warnIfWarmExceedsBudget(
      Object.fromEntries(NUMBERS.map((k) => [k, Number($(k).value)]))
    )
  );
}

$("reset").addEventListener("click", async () => {
  // snoozedUntil is runtime state, not a preference — leave any active pause alone.
  const { snoozedUntil, ...defaults } = DEFAULTS;
  fill(await saveSettings(defaults));
});

await countWindows();
fill(await loadSettings());
