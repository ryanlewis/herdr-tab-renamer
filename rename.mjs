#!/usr/bin/env node
// Tab Renamer — keep default-named herdr tabs labelled after their live
// content: `<number> · <title>` for agent tabs (falling back to the agent's
// name until a real session title exists), `<number> ⌂ <~cwd>` for shell
// tabs. Global idempotent reconcile: every invocation sweeps all tabs (event
// payload ignored), so a missed event self-heals on the next one. A tab whose
// label isn't the default (or our own last write) is never touched — manual
// names win, permanently.
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
  utimesSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const DRY = process.argv.includes("--dry-run");
const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const HOME = homedir();
// --dry-run from a plain shell must read the real ownership state or the
// preview diverges from event-driven behaviour, so herdr's default plugin
// state path fills in when the env var is absent. Real runs still require the
// env var — its presence is the proof we're running under herdr.
const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR ||
  (DRY
    ? join(HOME, ".local", "state", "herdr", "plugins", "io.rlew.tab-renamer")
    : null);
const LOCK_STALE_MS = 30_000;
const RETRY_WINDOW_MS = 3_000;
const MAX_TITLE = 30; // code points, session title
const MAX_CWD = 30; // code points, shell-tab path (tail kept)

const AGENT_MARK = "·";
const SHELL_MARK = "⌂";

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

// Session title: strip non-whitespace control chars (tabs/newlines survive to
// become spaces), collapse whitespace, lowercase. The cap counts code points,
// not UTF-16 units, so it can't split a surrogate pair.
function cleanTitle(s) {
  const scrubbed = s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
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
function computeLabel(pos, panes) {
  const pane = pickPane(panes);
  if (!pane) return null;
  if (typeof pane.agent === "string" && pane.agent !== "") {
    const raw = pane.terminal_title_stripped;
    let title = typeof raw === "string" ? cleanTitle(raw) : "";
    // Before the first task summary, agents title the terminal with their own
    // product name — "claude", "claude code", "claude: <dir>". Treat those
    // shapes as no-title. Matching stays exact so a real summary that merely
    // resembles the name (e.g. "claude-code") survives.
    const a = pane.agent.toLowerCase();
    if (title === a || title === `${a} code` || title.startsWith(`${a}: `)) {
      title = "";
    }
    // A titled tab shows the title alone (shell tabs keep the distinct ⌂
    // marker); the agent's name is only the fallback until a title exists.
    return `${pos} ${AGENT_MARK} ${title || pane.agent}`;
  }
  const cwd = pane.foreground_cwd || pane.cwd;
  if (typeof cwd !== "string" || cwd === "") return null;
  return `${pos} ${SHELL_MARK} ${cleanCwd(cwd)}`;
}

// ---- state, lock, sweep coverage --------------------------------------
// This machinery is vendored by design (zero-dep installs) and mirrors
// github.com/ryanlewis/herdr-workspace-renamer's sync.mjs — when fixing a bug
// here, port it there (and vice versa).

function readState() {
  if (!STATE_DIR) return {};
  try {
    const j = JSON.parse(readFileSync(join(STATE_DIR, "state.json"), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

// Returns false when the state could not be persisted — callers must then
// abandon any renames that depend on it.
function writeState(state) {
  if (!STATE_DIR || DRY) return true;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // Atomic replace: a torn state.json would make readState() return {} in a
    // concurrent sweep, which the ownership guard would misread as "the user
    // named these tabs" — permanently. Write-then-rename makes that
    // unobservable.
    const tmp = join(STATE_DIR, `state.json.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, join(STATE_DIR, "state.json"));
    return true;
  } catch (e) {
    warn(`state write failed: ${e.message}`);
    return false;
  }
}

// Serialize whole sweeps: overlapping event-triggered processes would race on
// read-modify-write of state.json (last writer drops the other's entries,
// with the same permanent-lockout consequence as a torn read). A lock whose
// mtime is older than LOCK_STALE_MS is from a crashed sweep — live sweeps
// refresh it via touchLock() between herdr calls.
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
        // Steal atomically: rename is exclusive, so exactly one of any
        // concurrent stealers evicts the stale lock (the losers throw
        // ENOENT), then the vacated slot is contended for with the same
        // exclusive create as above.
        const tomb = join(STATE_DIR, `.lock.stale-${process.pid}`);
        renameSync(lock, tomb);
        unlinkSync(tomb);
        writeFileSync(lock, String(process.pid), { flag: "wx" });
        return true;
      }
    } catch {
      // lock vanished, unreadable, or another stealer won — skip this sweep
    }
    return false;
  }
}

// The lock's mtime doubles as its liveness signal — refresh it between herdr
// calls so a legitimately slow sweep isn't mistaken for a crashed one.
function touchLock() {
  if (!STATE_DIR || DRY) return;
  try {
    const now = new Date();
    utimesSync(join(STATE_DIR, ".lock"), now, now);
  } catch {
    // lock gone (stolen after a stall) — nothing to refresh
  }
}

function releaseLock() {
  if (!STATE_DIR || DRY) return;
  const lock = join(STATE_DIR, ".lock");
  try {
    // Only remove a lock we still own — after a stall past LOCK_STALE_MS ours
    // may have been stolen, and the file now serializes someone else's sweep.
    if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
  } catch {
    // already gone — fine
  }
}

const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// .last-sweep's mtime records when the most recent sweep STARTED (only a
// sweep that started after an event arrived can have seen that event's
// effects — see the entrypoint).
function lastSweepStart() {
  try {
    return statSync(join(STATE_DIR, ".last-sweep")).mtimeMs;
  } catch {
    return 0;
  }
}

function stampSweepStart() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    closeSync(openSync(join(STATE_DIR, ".last-sweep"), "w"));
  } catch {
    // stamp write failing just means extra sweeps — harmless
  }
}

function main() {
  const tabs = herdr("tab", "list")?.result?.tabs;
  const panes = herdr("pane", "list")?.result?.panes;
  if (!Array.isArray(tabs) || !Array.isArray(panes)) {
    warn("unexpected herdr list output shape; no-op");
    return;
  }

  // A tab's default label is its 1-based DISPLAY POSITION in the workspace,
  // not its immutable number (close tab 2 of 3 and the old "3" is re-labelled
  // "2" live; its tab_id/number stay put). Derive positions from list order
  // within each workspace — both the ownership guard and the label prefix
  // depend on it.
  const position = new Map();
  const perWs = new Map();
  for (const t of tabs) {
    const n = (perWs.get(t?.workspace_id) ?? 0) + 1;
    perWs.set(t?.workspace_id, n);
    position.set(t?.tab_id, n);
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

  const plan = [];
  for (const tab of tabs) {
    const tabId = tab?.tab_id;
    const label = tab?.label;
    const pos = position.get(tabId);
    if (typeof tabId !== "string" || typeof label !== "string") continue;

    // Ownership guard: only touch a label that is the default (the bare
    // display position) or our own last write. Anything else → the user named
    // this tab, and their choice is permanent. (Accepted ambiguity: a user who
    // manually names a tab the bare digit matching its current position is
    // indistinguishable from default and gets adopted.)
    if (label !== String(pos) && label !== state[tabId]) {
      if (tabId in state) {
        // user overrode our write — locked from now on
        delete state[tabId];
        stateDirty = true;
      }
      continue;
    }

    const want = computeLabel(pos, panes.filter((p) => p?.tab_id === tabId));
    if (typeof want !== "string" || want === "") continue;

    if (want === label) continue; // already in sync — no rename, no loop

    if (DRY) {
      warn(`[dry-run] would rename ${tabId} "${label}" -> "${want}"`);
      continue;
    }
    plan.push({ tabId, label, want });
  }

  // Persist intent BEFORE renaming: if a rename landed but the state write
  // didn't, the next sweep would misread our own label as user-named and lock
  // the tab out permanently. The reverse failure (intent recorded, rename
  // lost) is harmless — the label stays default-eligible and self-heals on
  // the next sweep.
  for (const p of plan) state[p.tabId] = p.want;
  if ((stateDirty || plan.length > 0) && !writeState(state)) return;

  for (const p of plan) {
    touchLock();
    try {
      // Re-read the label at the last moment: the list snapshot is stale by
      // now, and a manual rename landing mid-sweep must win.
      const live = herdr("tab", "get", p.tabId)?.result?.tab?.label;
      if (live !== p.label) continue;
      herdr("tab", "rename", p.tabId, p.want);
      warn(`renamed ${p.tabId} "${p.label}" -> "${p.want}"`);
    } catch (e) {
      warn(`rename ${p.tabId} failed: ${e.message}`);
    }
  }
}

// Outside herdr (no state dir) a real run would rename tabs without recording
// ownership, permanently orphaning them from future sweeps — refuse rather
// than half-work. --dry-run stays available for previewing.
if (!STATE_DIR && !DRY) {
  warn(
    "HERDR_PLUGIN_STATE_DIR is not set (not running under herdr?); refusing to rename without state tracking — use --dry-run to preview",
  );
} else if (DRY) {
  try {
    main();
  } catch (e) {
    warn(e.message); // fail safe: any surprise is a no-op
  }
} else {
  // An in-flight sweep may have read herdr's state BEFORE the change that
  // fired this event, so "a sweep is already running" is not coverage — this
  // event is covered only by a sweep that STARTED after it arrived. On
  // contention, wait briefly and re-check rather than fire-and-forget
  // skipping (which would leave a label stale until some unrelated future
  // event). Give up after RETRY_WINDOW_MS; herdr events are frequent enough
  // that a later sweep self-heals a rare miss.
  const arrival = Date.now();
  for (;;) {
    if (lastSweepStart() > arrival) break; // a newer sweep covered this event
    if (acquireLock()) {
      try {
        if (lastSweepStart() <= arrival) {
          stampSweepStart();
          main();
        }
      } catch (e) {
        warn(e.message); // fail safe: any surprise is a no-op
      } finally {
        releaseLock();
      }
      break;
    }
    if (Date.now() - arrival > RETRY_WINDOW_MS) break;
    sleep(50);
  }
}
