#!/usr/bin/env node
// Tab Renamer — keep default-named herdr tabs labelled after their live
// content: `<number> ✦ <agent>[ · <title>]` for agent tabs, `<number> ⌂ <~cwd>`
// for shell tabs. Global idempotent reconcile: every invocation sweeps all
// tabs (event payload ignored), so a missed event self-heals on the next one.
// A tab whose label isn't the default (or our own last write) is never
// touched — manual names win, permanently.
//
// Fail-safe posture: any parse/shape surprise → skip + one line to stderr.
// Doing nothing is always acceptable; a wrong rename is the only real failure.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  openSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const DRY = process.argv.includes("--dry-run");
const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const HOME = homedir();
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || null;
const DEBOUNCE_MS = 250;
const LOCK_STALE_MS = 30_000;
const MAX_TITLE = 30; // code points, session-title suffix
const MAX_CWD = 30; // code points, shell-tab path (tail kept)

const AGENT_MARK = "✦";
const SHELL_MARK = "⌂";
const SEP = " · ";

const warn = (msg) => process.stderr.write(`tab-renamer: ${msg}\n`);

function herdr(...args) {
  const r = spawnSync(HERDR, args, { encoding: "utf8", timeout: 10_000 });
  if (r.error) throw new Error(`herdr ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(
      `herdr ${args.join(" ")}: exit ${r.status} ${(r.stderr || "").trim()}`,
    );
  }
  return r.stdout.trim() === "" ? null : JSON.parse(r.stdout);
}

const tildify = (p) =>
  p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;

// Session-title suffix: strip control chars, collapse whitespace, lowercase
// (natural spacing kept — the separator is " · ", no re-slugging). The cap
// counts code points, not UTF-16 units, so it can't split a surrogate pair.
function cleanTitle(s) {
  const scrubbed = s
    .replace(/\s+/g, " ") // before control-strip so \t and \n become spaces
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .toLowerCase();
  return [...scrubbed].slice(0, MAX_TITLE).join("").trim();
}

// Shell-tab path, ~-shortened and capped from the LEFT (the tail of a path is
// the informative end). Case preserved — paths are case-sensitive.
function cleanCwd(p) {
  const t = tildify(p);
  const cps = [...t];
  return cps.length <= MAX_CWD ? t : "…" + cps.slice(-MAX_CWD).join("");
}

const paneNum = (id) => {
  const m = /:p(\d+)$/.exec(id ?? "");
  return m ? Number(m[1]) : Infinity;
};

// The pane that speaks for a tab: lowest-numbered agent pane; else the tab's
// focused pane; else the lowest-numbered pane.
function pickPane(panes) {
  const byNum = [...panes].sort((a, b) => paneNum(a.pane_id) - paneNum(b.pane_id));
  return (
    byNum.find((p) => typeof p.agent === "string" && p.agent !== "") ??
    byNum.find((p) => p.focused === true) ??
    byNum[0]
  );
}

// The label a tab *should* have, or null for "no opinion" (which always
// collapses to the no-op path — a surprise can never cause a rename).
function computeLabel(tab, panes) {
  const pane = pickPane(panes);
  if (!pane) return null;
  if (typeof pane.agent === "string" && pane.agent !== "") {
    let label = `${tab.number} ${AGENT_MARK} ${pane.agent}`;
    const raw = pane.terminal_title_stripped;
    if (typeof raw === "string") {
      const title = cleanTitle(raw);
      // Before the first task summary, agents title the terminal with their
      // own product name ("claude", "claude code") — that adds nothing, skip.
      const norm = (s) => s.replace(/[^a-z0-9]+/g, "");
      const noise = [norm(pane.agent.toLowerCase()), norm(pane.agent.toLowerCase()) + "code"];
      if (title && !noise.includes(norm(title))) label += `${SEP}${title}`;
    }
    return label;
  }
  const cwd = pane.foreground_cwd || pane.cwd;
  if (typeof cwd !== "string" || cwd === "") return null;
  return `${tab.number} ${SHELL_MARK} ${cleanCwd(cwd)}`;
}

function readState() {
  if (!STATE_DIR) return {};
  try {
    const j = JSON.parse(readFileSync(join(STATE_DIR, "state.json"), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  if (!STATE_DIR || DRY) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // Atomic replace: a torn state.json would make readState() return {} in a
    // concurrent sweep, which the ownership guard would misread as "the user
    // named these tabs" — permanently. Write-then-rename makes that
    // unobservable.
    const tmp = join(STATE_DIR, `state.json.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, join(STATE_DIR, "state.json"));
  } catch (e) {
    warn(`state write failed: ${e.message}`);
  }
}

// Serialize whole sweeps: overlapping event-triggered processes would race on
// read-modify-write of state.json (last writer drops the other's entries, with
// the same permanent-lockout consequence as a torn read). Losing the lock just
// means another sweep is reconciling right now — the next event's sweep covers
// any gap. A lock older than LOCK_STALE_MS is from a crashed sweep and is
// stolen.
function acquireLock() {
  if (!STATE_DIR || DRY) return true; // nothing to serialize against
  const lock = join(STATE_DIR, ".lock");
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        writeFileSync(lock, String(process.pid));
        return true;
      }
    } catch {
      // lock vanished or unreadable — skip this sweep, next event self-heals
    }
    return false;
  }
}

function releaseLock() {
  if (!STATE_DIR || DRY) return;
  try {
    unlinkSync(join(STATE_DIR, ".lock"));
  } catch {
    // already gone — fine
  }
}

// Events can burst (several subscriptions can fire off one user action) — skip
// if a full sweep ran within the last DEBOUNCE_MS.
function debounced() {
  if (!STATE_DIR || DRY) return false;
  const stamp = join(STATE_DIR, ".last-sweep");
  try {
    if (Date.now() - statSync(stamp).mtimeMs < DEBOUNCE_MS) return true;
  } catch {
    // no stamp yet
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    closeSync(openSync(stamp, "w"));
  } catch {
    // stamp write failing just means no debounce — harmless
  }
  return false;
}

function main() {
  if (debounced()) return;

  const tabs = herdr("tab", "list")?.result?.tabs;
  const panes = herdr("pane", "list")?.result?.panes;
  if (!Array.isArray(tabs) || !Array.isArray(panes)) {
    warn("unexpected herdr list output shape; no-op");
    return;
  }

  const state = readState();
  let stateDirty = false;

  // Drop state for tabs that no longer exist.
  const liveIds = new Set(tabs.map((t) => t?.tab_id));
  for (const id of Object.keys(state)) {
    if (!liveIds.has(id)) {
      delete state[id];
      stateDirty = true;
    }
  }

  for (const tab of tabs) {
    const tabId = tab?.tab_id;
    const label = tab?.label;
    if (
      typeof tabId !== "string" ||
      typeof label !== "string" ||
      typeof tab?.number !== "number"
    ) {
      continue;
    }

    // Ownership guard: only touch a label that is the default (the bare tab
    // number) or our own last write. Anything else → the user named this tab,
    // and their choice is permanent.
    if (label !== String(tab.number) && label !== state[tabId]) {
      if (tabId in state) {
        // user overrode our write — locked from now on
        delete state[tabId];
        stateDirty = true;
      }
      continue;
    }

    const want = computeLabel(tab, panes.filter((p) => p?.tab_id === tabId));
    if (typeof want !== "string" || want === "") continue;

    if (want === label) continue; // already in sync — no rename, no loop

    if (DRY) {
      warn(`[dry-run] would rename ${tabId} "${label}" -> "${want}"`);
      continue;
    }
    try {
      herdr("tab", "rename", tabId, want);
      state[tabId] = want;
      stateDirty = true;
      warn(`renamed ${tabId} "${label}" -> "${want}"`);
    } catch (e) {
      warn(`rename ${tabId} failed: ${e.message}`);
    }
  }

  if (stateDirty) writeState(state);
}

// Outside herdr (no state dir) a real run would rename tabs without recording
// ownership, permanently orphaning them from future sweeps — refuse rather
// than half-work. --dry-run stays available for previewing.
if (!STATE_DIR && !DRY) {
  warn(
    "HERDR_PLUGIN_STATE_DIR is not set (not running under herdr?); refusing to rename without state tracking — use --dry-run to preview",
  );
} else if (acquireLock()) {
  try {
    main();
  } catch (e) {
    warn(e.message); // fail safe: any surprise is a no-op
  } finally {
    releaseLock();
  }
}
