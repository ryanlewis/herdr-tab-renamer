// Offline tests for rename.mjs: fake herdr CLI, exercising every rename,
// guard, and fail-safe behaviour. Each scenario runs in its own sandbox
// (fresh HOME, world state, plugin state dir).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const renameScript = join(here, "..", "rename.mjs");
const fakeHerdr = join(here, "fake-herdr.mjs");

const tab = (tabId, number, label, extra = {}) => ({
  tab_id: tabId,
  workspace_id: tabId.split(":")[0],
  number,
  label,
  agent_status: "idle",
  focused: false,
  pane_count: 1,
  ...extra,
});

const agentPane = (paneId, tabId, title, extra = {}) => ({
  pane_id: paneId,
  tab_id: tabId,
  workspace_id: tabId.split(":")[0],
  agent: "claude",
  agent_status: "idle",
  cwd: "$HOME/dev/myapp",
  foreground_cwd: "$HOME/dev/myapp",
  focused: false,
  ...(title === undefined
    ? {}
    : { terminal_title: `✳ ${title}`, terminal_title_stripped: title }),
  ...extra,
});

const shellPane = (paneId, tabId, cwd, extra = {}) => ({
  pane_id: paneId,
  tab_id: tabId,
  workspace_id: tabId.split(":")[0],
  agent_status: "unknown",
  cwd,
  foreground_cwd: cwd,
  focused: false,
  ...extra,
});

// One sandbox per scenario: fresh HOME, world file, calls log, state dir.
function run({ world, state, lockAgeMs, noStateDir, stateUnwritable, args = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "tabren-test-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const worldPath = join(dir, "world.json");
  // "$HOME" in fixture paths becomes the sandbox home, so tests can exercise
  // ~-shortening against the real HOME env.
  writeFileSync(worldPath, JSON.stringify(world).replaceAll("$HOME", home));
  const callsPath = join(dir, "calls.log");
  writeFileSync(callsPath, "");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir);
  if (state) writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));
  // A directory at state.json makes writeState's atomic rename fail while
  // everything else (lock, stamp) still works.
  if (stateUnwritable) mkdirSync(join(stateDir, "state.json"));
  if (lockAgeMs !== undefined) {
    const lock = join(stateDir, ".lock");
    writeFileSync(lock, "99999");
    const t = (Date.now() - lockAgeMs) / 1000;
    utimesSync(lock, t, t);
  }

  const env = {
    ...process.env,
    HOME: home,
    HERDR_BIN_PATH: fakeHerdr,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    FAKE_HERDR_WORLD: worldPath,
    FAKE_HERDR_CALLS: callsPath,
  };
  if (noStateDir) delete env.HERDR_PLUGIN_STATE_DIR;
  const r = spawnSync(process.execPath, [renameScript, ...args], {
    encoding: "utf8",
    env,
  });

  const calls = readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  let stateAfter = {};
  try {
    stateAfter = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  } catch {}
  const lockLeft = existsSync(join(stateDir, ".lock"));
  rmSync(dir, { recursive: true, force: true });
  return { calls, stateAfter, lockLeft, stderr: r.stderr, status: r.status };
}

// ---- agent-tab labels --------------------------------------------------

test("agent tab without a title falls back to `<n> · <agent>`", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [agentPane("w1:p1", "w1:t1", undefined)],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 · claude"]], r.stderr);
  assert.equal(r.stateAfter["w1:t1"], "1 · claude", "rename recorded in plugin state");
});

test("agent tab with a title shows the title alone, lowercased", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [agentPane("w1:p1", "w1:t1", "PR Reviews")],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 · pr reviews"]], r.stderr);
});

test("long title capped at 30 code points", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [
        agentPane("w1:p1", "w1:t1", "Rework the ingest pipeline for cold-start latency"),
      ],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 · rework the ingest pipeline for"]], r.stderr);
});

test("title cap counts code points, never splits a surrogate pair", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [agentPane("w1:p1", "w1:t1", "🚀".repeat(40))],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", `1 · ${"🚀".repeat(30)}`]], r.stderr);
});

test("non-ASCII title kept verbatim", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [agentPane("w1:p1", "w1:t1", "日本語のタスク")],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 · 日本語のタスク"]], r.stderr);
});

test("pre-summary product-name titles fall back to the agent name", () => {
  for (const noise of ["Claude", "Claude Code", "claude: myapp"]) {
    const r = run({
      world: {
        tabs: [tab("w1:t1", 1, "1")],
        panes: [agentPane("w1:p1", "w1:t1", noise)],
      },
    });
    assert.deepEqual(r.calls, [["w1:t1", "1 · claude"]], `title ${noise}: ${r.stderr}`);
  }
});

test("title merely resembling the agent name is kept", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [agentPane("w1:p1", "w1:t1", "claude-code")],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 · claude-code"]], r.stderr);
});

test("title control chars stripped, whitespace collapsed", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [agentPane("w1:p1", "w1:t1", "  Fix\tthe   thing\x07 ")],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 · fix the thing"]], r.stderr);
});

test("control char flanked by spaces collapses to a single space", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [agentPane("w1:p1", "w1:t1", "fix \x07 thing")],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 · fix thing"]], r.stderr);
});

test("agent pane with empty title string falls back to the agent name", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [agentPane("w1:p1", "w1:t1", "")],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 · claude"]], r.stderr);
});

// ---- shell-tab labels --------------------------------------------------

test("shell tab gets `<n> ⌂ <~cwd>`", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [shellPane("w1:p1", "w1:t1", "$HOME/dev/myapp")],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 ⌂ ~/dev/myapp"]], r.stderr);
});

test("shell cwd outside HOME kept verbatim; case preserved", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [shellPane("w1:p1", "w1:t1", "/opt/Homebrew/etc")],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 ⌂ /opt/Homebrew/etc"]], r.stderr);
});

test("long shell cwd capped from the left, tail kept", () => {
  const deep = "/x/" + "verylongsegment/".repeat(6).slice(0, -1);
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [shellPane("w1:p1", "w1:t1", deep)],
    },
  });
  assert.equal(r.calls.length, 1, r.stderr);
  const path = r.calls[0][1].slice("1 ⌂ ".length);
  assert.ok(path.startsWith("…"), path);
  assert.equal([...path].length, 31, path); // … + 30 code points of tail
  assert.ok(deep.endsWith([...path].slice(1).join("")), path);
});

test("shell pane prefers foreground_cwd over cwd", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [
        shellPane("w1:p1", "w1:t1", "$HOME/start", { foreground_cwd: "$HOME/dev/elsewhere" }),
      ],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 ⌂ ~/dev/elsewhere"]], r.stderr);
});

// ---- ownership guard ---------------------------------------------------

test("manually renamed tab never touched; state entry dropped", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "user-chose-this")],
      panes: [agentPane("w1:p1", "w1:t1", "some title")],
    },
    state: { "w1:t1": "1 · old" },
  });
  assert.deepEqual(r.calls, []);
  assert.ok(!("w1:t1" in r.stateAfter), "state entry dropped when user overrides label");
});

test("non-default label with no state: untouched", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "mine")],
      panes: [agentPane("w1:p1", "w1:t1", "some title")],
    },
  });
  assert.deepEqual(r.calls, []);
});

test("re-rename updates a label the plugin set (title changed)", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1 · old task")],
      panes: [agentPane("w1:p1", "w1:t1", "new task")],
    },
    state: { "w1:t1": "1 · old task" },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 · new task"]], r.stderr);
});

test("agent exit back to shell relabels an owned tab", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1 · task")],
      panes: [shellPane("w1:p1", "w1:t1", "$HOME/dev/myapp")],
    },
    state: { "w1:t1": "1 · task" },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 ⌂ ~/dev/myapp"]], r.stderr);
});

test("no-op when label already matches", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1 · task")],
      panes: [agentPane("w1:p1", "w1:t1", "task")],
    },
    state: { "w1:t1": "1 · task" },
  });
  assert.deepEqual(r.calls, []);
});

test("mid-sweep manual rename wins (pre-rename live re-check)", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [agentPane("w1:p1", "w1:t1", "task")],
      live_labels: { "w1:t1": "deploys" },
    },
  });
  assert.deepEqual(r.calls, [], r.stderr);
});

// ---- pane pick ---------------------------------------------------------

test("split tab: first agent pane wins over a lower-numbered shell", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1", { pane_count: 2 })],
      panes: [
        shellPane("w1:p1", "w1:t1", "$HOME/dev/myapp", { focused: true }),
        agentPane("w1:p2", "w1:t1", "the task"),
      ],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 · the task"]], r.stderr);
});

test("split tab: two agents — lowest pane number wins, regardless of list order", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1", { pane_count: 2 })],
      panes: [
        agentPane("w1:p3", "w1:t1", "later pane"),
        agentPane("w1:p1", "w1:t1", "first pane"),
      ],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 · first pane"]], r.stderr);
});

test("all-shell split: focused pane wins", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1", { pane_count: 2 })],
      panes: [
        shellPane("w1:p1", "w1:t1", "$HOME/one"),
        shellPane("w1:p2", "w1:t1", "$HOME/two", { focused: true }),
      ],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 ⌂ ~/two"]], r.stderr);
});

test("all-shell split with no focus: lowest pane wins", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1", { pane_count: 2 })],
      panes: [
        shellPane("w1:p2", "w1:t1", "$HOME/two"),
        shellPane("w1:p1", "w1:t1", "$HOME/one"),
      ],
    },
  });
  assert.deepEqual(r.calls, [["w1:t1", "1 ⌂ ~/one"]], r.stderr);
});

// ---- positions (default label = display ordinal) -----------------------

test("default label is display position, not tab number (gap after closed tabs)", () => {
  // Tabs 2–4 were closed: t5 is the workspace's 2nd tab, default label "2".
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "user-named"), tab("w1:t5", 5, "2")],
      panes: [shellPane("w1:p6", "w1:t5", "$HOME/dev/myapp")],
    },
  });
  assert.deepEqual(r.calls, [["w1:t5", "2 ⌂ ~/dev/myapp"]], r.stderr);
});

test("owned label's position prefix self-heals after tabs shift", () => {
  // t5 was 2nd when we labelled it; the tab before it has since closed.
  const r = run({
    world: {
      tabs: [tab("w1:t5", 5, "2 ⌂ ~/dev/myapp")],
      panes: [shellPane("w1:p6", "w1:t5", "$HOME/dev/myapp")],
    },
    state: { "w1:t5": "2 ⌂ ~/dev/myapp" },
  });
  assert.deepEqual(r.calls, [["w1:t5", "1 ⌂ ~/dev/myapp"]], r.stderr);
});

test("positions are per-workspace, in list order", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1"), tab("w1:t3", 3, "2"), tab("w2:t7", 7, "1")],
      panes: [
        shellPane("w1:p1", "w1:t1", "$HOME/a"),
        shellPane("w1:p3", "w1:t3", "$HOME/b"),
        shellPane("w2:p9", "w2:t7", "$HOME/c"),
      ],
    },
  });
  assert.deepEqual(Object.fromEntries(r.calls), {
    "w1:t1": "1 ⌂ ~/a",
    "w1:t3": "2 ⌂ ~/b",
    "w2:t7": "1 ⌂ ~/c",
  }, r.stderr);
});

// ---- sweep behaviour ---------------------------------------------------

test("global sweep renames only eligible tabs", () => {
  const r = run({
    world: {
      tabs: [
        tab("w1:t1", 1, "1"),
        tab("w1:t2", 2, "manual-label"),
        tab("w2:t1", 1, "1"),
      ],
      panes: [
        agentPane("w1:p1", "w1:t1", "task one"),
        agentPane("w1:p2", "w1:t2", "blocked task"),
        shellPane("w2:p1", "w2:t1", "$HOME/dev/myapp"),
      ],
    },
  });
  assert.deepEqual(Object.fromEntries(r.calls), {
    "w1:t1": "1 · task one",
    "w2:t1": "1 ⌂ ~/dev/myapp",
  }, r.stderr);
});

test("dead tab's state entry pruned", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [agentPane("w1:p1", "w1:t1", "task")],
    },
    state: { "w9:t9": "1 · gone" },
  });
  assert.ok(!("w9:t9" in r.stateAfter), "dead tab pruned from state");
  assert.equal(r.stateAfter["w1:t1"], "1 · task");
});

test("tab with no panes: safe skip", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [],
    },
  });
  assert.deepEqual(r.calls, []);
  assert.equal(r.status, 0);
});

test("malformed herdr output: safe no-op, exit 0", () => {
  const r = run({ world: { tabs: "nonsense", panes: [] } });
  assert.deepEqual(r.calls, []);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /unexpected herdr list output shape/);
});

// ---- state & lock safety ----------------------------------------------

test("state write failure aborts all renames (no rename without recorded ownership)", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1")],
      panes: [agentPane("w1:p1", "w1:t1", "task")],
    },
    stateUnwritable: true,
  });
  assert.deepEqual(r.calls, [], r.stderr);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /state write failed/);
});

const lockScenario = {
  world: {
    tabs: [tab("w1:t1", 1, "1")],
    panes: [agentPane("w1:p1", "w1:t1", "task")],
  },
};

test("fresh lock held by another sweep: skipped after bounded retry, lock preserved", () => {
  const r = run({ ...lockScenario, lockAgeMs: 0 });
  assert.deepEqual(r.calls, []);
  assert.ok(r.lockLeft, "foreign lock must not be removed");
  assert.equal(r.status, 0);
});

test("stale lock stolen: sweep proceeds, lock released", () => {
  const r = run({ ...lockScenario, lockAgeMs: 60_000 });
  assert.deepEqual(r.calls, [["w1:t1", "1 · task"]], r.stderr);
  assert.ok(!r.lockLeft);
});

test("normal run releases the lock", () => {
  const r = run(lockScenario);
  assert.deepEqual(r.calls, [["w1:t1", "1 · task"]], r.stderr);
  assert.ok(!r.lockLeft);
});

test("no state dir and no --dry-run: refuses to run, renames nothing", () => {
  const r = run({ ...lockScenario, noStateDir: true });
  assert.deepEqual(r.calls, []);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /refusing to rename/);
});

test("--dry-run previews without renaming or writing state", () => {
  const r = run({ ...lockScenario, args: ["--dry-run"] });
  assert.deepEqual(r.calls, []);
  assert.match(r.stderr, /would rename w1:t1 "1" -> "1 · task"/);
  assert.deepEqual(r.stateAfter, {}, "dry-run writes no state");
});

test("--dry-run reads existing state, so owned tabs preview their update", () => {
  const r = run({
    world: {
      tabs: [tab("w1:t1", 1, "1 · old task")],
      panes: [agentPane("w1:p1", "w1:t1", "new task")],
    },
    state: { "w1:t1": "1 · old task" },
    args: ["--dry-run"],
  });
  assert.deepEqual(r.calls, []);
  assert.match(r.stderr, /would rename w1:t1 "1 · old task" -> "1 · new task"/);
});
