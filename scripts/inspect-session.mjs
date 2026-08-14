#!/usr/bin/env node
// Decodes a Zen/Firefox session store and prints the tab statistics that justify
// Torpor's default thresholds. See docs/FINDINGS.md section 7.
//
// Reads only. Point it at a profile with --profile=<path>, or let it pick the
// most recently modified Zen profile on this machine.
//
// The session store is "mozlz4": the 8-byte magic `mozLz40\0`, a 4-byte
// little-endian decompressed size, then a raw LZ4 *block* (not the LZ4 frame
// format the `lz4` CLI speaks, which is why this is hand-rolled rather than a
// dependency).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function decompressBlock(src, expectedSize) {
  const out = Buffer.allocUnsafe(expectedSize);
  let i = 0;
  let o = 0;

  while (i < src.length) {
    const token = src[i++];

    let literalLength = token >> 4;
    if (literalLength === 15) {
      let byte;
      do {
        byte = src[i++];
        literalLength += byte;
      } while (byte === 255);
    }

    src.copy(out, o, i, i + literalLength);
    i += literalLength;
    o += literalLength;

    // The final sequence is literals only, with no match to follow.
    if (i >= src.length) break;

    const offset = src[i] | (src[i + 1] << 8);
    i += 2;

    let matchLength = token & 15;
    if (matchLength === 15) {
      let byte;
      do {
        byte = src[i++];
        matchLength += byte;
      } while (byte === 255);
    }
    matchLength += 4;

    // Byte-at-a-time on purpose: LZ4 matches may overlap the output cursor.
    let from = o - offset;
    for (let n = 0; n < matchLength; n++) out[o++] = out[from++];
  }

  if (o !== expectedSize) {
    throw new Error(`decompressed ${o} bytes, header claimed ${expectedSize}`);
  }
  return out;
}

export function readMozLz4(path) {
  const raw = readFileSync(path);
  if (raw.subarray(0, 8).toString("latin1") !== "mozLz40\0") {
    throw new Error(`${path} is not a mozlz4 file`);
  }
  const size = raw.readUInt32LE(8);
  return JSON.parse(decompressBlock(raw.subarray(12), size).toString("utf8"));
}

function findProfile() {
  const root = join(homedir(), "Library/Application Support/zen/Profiles");
  if (!existsSync(root)) {
    throw new Error(`no Zen profiles at ${root} — pass --profile=<path>`);
  }
  const candidates = readdirSync(root)
    .map((name) => join(root, name))
    .filter((dir) => existsSync(join(dir, "sessionstore-backups/recovery.jsonlz4")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (!candidates.length) throw new Error("no profile with a recovery.jsonlz4");
  return candidates[0];
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function main() {
  const flag = process.argv.find((a) => a.startsWith("--profile="));
  const profile = flag ? flag.slice("--profile=".length) : findProfile();

  const session = readMozLz4(join(profile, "sessionstore-backups/recovery.jsonlz4"));
  const now = Date.now();

  const spaces = new Map();
  const ages = [];
  let total = 0;
  let pinned = 0;
  let essential = 0;
  let hidden = 0;

  for (const win of session.windows ?? []) {
    for (const tab of win.tabs ?? []) {
      total++;
      const space = tab.zenWorkspace ?? "(none)";
      spaces.set(space, (spaces.get(space) ?? 0) + 1);
      if (tab.pinned) pinned++;
      if (tab.zenEssential) essential++;
      if (tab.hidden) hidden++;
      if (tab.lastAccessed) ages.push((now - tab.lastAccessed) / 3_600_000);
    }
  }

  ages.sort((a, b) => a - b);
  const over = (h) => ages.filter((a) => a > h).length;

  console.log(`profile:     ${profile}`);
  console.log(`windows:     ${(session.windows ?? []).length}`);
  console.log(`tabs:        ${total}`);
  console.log(`spaces:      ${spaces.size} (${[...spaces.values()].sort((a, b) => b - a).join(" / ")})`);
  console.log(`pinned:      ${pinned}`);
  console.log(`essentials:  ${essential}`);
  console.log(`hidden:      ${hidden}   <- 0 means Zen is not using tab hiding for spaces`);
  console.log("");
  console.log(`idle hours:  median ${percentile(ages, 0.5).toFixed(1)}  p90 ${percentile(ages, 0.9).toFixed(1)}  max ${(ages.at(-1) ?? 0).toFixed(1)}`);
  console.log(`idle > 2h:   ${over(2)}`);
  console.log(`idle > 24h:  ${over(24)}`);
  console.log(`idle > 7d:   ${over(168)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
