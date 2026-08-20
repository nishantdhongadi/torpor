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
function warnIfWarmExceedsBudget({ keepWarm, maxLoaded }) {
  $("conflict").textContent =
    keepWarm > maxLoaded
      ? `Keeping the last ${keepWarm} tabs overrides the ceiling of ${maxLoaded}, so ${keepWarm} will stay in memory.`
      : "";
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

fill(await loadSettings());
