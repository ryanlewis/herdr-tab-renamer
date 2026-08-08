#!/usr/bin/env node
// Fake herdr CLI for offline tests. Reads canned world state from
// $FAKE_HERDR_WORLD (JSON: {tabs, panes}) and appends any `tab rename` calls
// to $FAKE_HERDR_CALLS.
import { readFileSync, appendFileSync } from "node:fs";

// Only meaningful when spawned by the test harness; bail quietly if the
// node --test runner (or anything else) executes this file directly.
if (!process.env.FAKE_HERDR_WORLD) process.exit(0);

const world = JSON.parse(readFileSync(process.env.FAKE_HERDR_WORLD, "utf8"));
const [group, verb, ...rest] = process.argv.slice(2);

if (group === "tab" && verb === "list") {
  process.stdout.write(
    JSON.stringify({ id: "cli:tab:list", result: { tabs: world.tabs, type: "tab_list" } }),
  );
} else if (group === "pane" && verb === "list") {
  process.stdout.write(
    JSON.stringify({ id: "cli:pane:list", result: { panes: world.panes, type: "pane_list" } }),
  );
} else if (group === "tab" && verb === "rename") {
  appendFileSync(process.env.FAKE_HERDR_CALLS, JSON.stringify(rest) + "\n");
  process.stdout.write(JSON.stringify({ id: "cli:tab:rename", result: { ok: true } }));
} else {
  process.stderr.write(`fake-herdr: unknown command ${group} ${verb}\n`);
  process.exit(1);
}
