const $ = (id) => document.getElementById(id);
const send = (message) => browser.runtime.sendMessage(message);

async function render() {
  const status = await send({ type: "getStatus" });

  $("loaded").textContent = status.total - status.discarded;
  $("dormant").textContent = status.discarded;
  $("total").textContent = status.total;

  // Deliberately counts, never megabytes. Firefox exposes no memory API to
  // extensions — chrome.system.memory is unimplemented and performance.memory
  // is Chrome-only — so any MB figure here would be invented. about:processes
  // is the honest place to look.
  $("note").textContent = status.snoozedUntil
    ? `Paused until ${new Date(status.snoozedUntil).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })}.`
    : "Checking every minute. Dormant tabs stay in your spaces and reload when you open them.";

  $("sweep").disabled = status.pending === 0;
  $("sweep-hint").textContent = status.pending
    ? `${status.pending} tab${status.pending === 1 ? "" : "s"} ready`
    : "nothing to unload right now";

  $("protect").disabled = !status.activeHost;
  $("protect").firstChild.textContent = status.activeHostAllowlisted
    ? "Stop protecting this site"
    : "Never unload this site";
  $("protect-hint").textContent = status.activeHost || "no site in this tab";

  $("snooze").textContent = status.snoozedUntil ? "Resume now" : "Pause for 30 minutes";

  $("lifetime").textContent = status.lifetimeDiscarded
    ? `${status.lifetimeDiscarded.toLocaleString()} unloaded so far`
    : "";

  return status;
}

let current;

$("sweep").addEventListener("click", async () => {
  $("sweep").disabled = true;
  const { discarded } = await send({ type: "sweepNow" });
  current = await render();
  if (discarded === 0) {
    // Nothing moved despite having candidates — almost always a page holding a
    // beforeunload handler, which refuses to be discarded. Say so rather than
    // leaving the numbers looking stuck.
    $("note").textContent = "Nothing unloaded — those tabs are holding unsaved work.";
  }
});

$("protect").addEventListener("click", async () => {
  await send({ type: "toggleAllowlistHost", host: current.activeHost });
  current = await render();
});

$("snooze").addEventListener("click", async () => {
  await send(current.snoozedUntil ? { type: "unsnooze" } : { type: "snooze", minutes: 30 });
  current = await render();
});

$("options").addEventListener("click", (event) => {
  event.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});

current = await render();
