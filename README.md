# herdr Tab Renamer

A [herdr](https://herdr.dev) plugin that keeps default-named tabs labelled
after their live content. A tab running an agent becomes
`1 ✦ claude · pr reviews` (number, agent, session title); a plain shell tab
becomes `1 ⌂ ~/dev/notes` (number, current directory). A tab you renamed
yourself is never touched — manual names win, permanently.

## Why

herdr tabs keep their default numeric names (`1`, `2`, …) forever. With
several tabs of agents and shells, the tab bar says nothing about what is
where. The content of each tab usually *does* say — the agent's live task
summary, or the shell's directory — so this plugin makes the label follow it.

## Behaviour

- A default-named tab running an agent is labelled `<number> ✦ <agent>`, with
  ` · <session title>` appended once the agent has one (lowercased, capped at
  30 characters). The title is the agent's terminal title — for Claude Code
  that's the live task summary, updated as work progresses.
- A default-named tab with only a shell is labelled `<number> ⌂ <directory>`
  (`~`-shortened, long paths capped keeping the tail).
- When the agent exits back to the shell, the label follows.
- In a split tab the lowest-numbered agent pane drives the label; with no
  agent, the focused pane, then the lowest-numbered pane.
- A tab you renamed yourself — before or after the plugin touched it — is
  never renamed again.
- Every trigger event reconciles *all* tabs, so missed events self-heal on
  the next one.

## How it works

On each herdr event the plugin reads `herdr tab list` and `herdr pane list`,
computes the label each tab should have, and renames a tab only when its
current label is the default (the bare tab number) or the plugin's own last
write, tracked in plugin state. The agent session title comes from the pane's
`terminal_title_stripped` field — the OSC title herdr already captures.

Fail-safe by design: any parse or shape surprise is a silent no-op with one
line to stderr (visible via
`herdr plugin log list --plugin io.rlew.tab-renamer`). Doing nothing is
always acceptable; a wrong rename is the only real failure.

## Install

```sh
herdr plugin install ryanlewis/herdr-tab-renamer
```

Requires herdr ≥ 0.8.0 and Node ≥ 18. Zero npm dependencies.

To remove it:

```sh
herdr plugin uninstall io.rlew.tab-renamer
```

The plugin normally runs off herdr events, but you can force a sweep at any
time with the bundled workspace action:

```sh
herdr plugin action invoke io.rlew.tab-renamer.rename-now
```

### Development

```sh
git clone https://github.com/ryanlewis/herdr-tab-renamer
cd herdr-tab-renamer
herdr plugin link .      # and later: herdr plugin unlink io.rlew.tab-renamer
```

Plugin state (a map of tab id → last label the plugin wrote, used to tell its
own renames apart from yours) lives in
`~/.local/state/herdr/plugins/io.rlew.tab-renamer/`. Deleting it is safe:
tabs the plugin last renamed will just be treated as user-named until they
return to their default label (rename one back to its bare number to opt it
in again).

## Coexistence

Pairs with [herdr-workspace-renamer](https://github.com/ryanlewis/herdr-workspace-renamer),
which syncs agent *session names* onto *workspace* labels. The two own
different labels (tabs vs workspaces) and never conflict; both are
no-op-happy global reconciles, so sharing trigger events is cheap.

## Test

```sh
node test/rename.test.mjs   # offline: fake herdr CLI
node rename.mjs --dry-run   # against live herdr state, prints planned renames
```

Tests use the built-in `node:test` runner — Node ≥ 20 for development. (The
test file is run directly rather than via `node --test`: glob arguments need
Node ≥ 21, and this repo's `test/` directory name collides with the runner's
default discovery patterns.)

## License

MIT
