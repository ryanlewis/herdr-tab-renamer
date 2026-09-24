# herdr Tab Renamer

> [!WARNING]
> **No longer maintained.** This repository is archived. Use
> [kryptamine/herdr-auto-title](https://github.com/kryptamine/herdr-auto-title)
> instead: it names tabs and panes after their live content and leaves names
> you set yourself alone.
>
> ```sh
> herdr plugin uninstall io.rlew.tab-renamer
> herdr plugin install kryptamine/herdr-auto-title
> herdr plugin action invoke herdr.auto-title.restart
> ```

A [herdr](https://herdr.dev) plugin that keeps default-named tabs labelled
after their live content. A tab running an agent becomes `1 · pr reviews`
(number, live session title — or `1 · claude` until a title exists); a plain
shell tab becomes `1 ⌂ ~/dev/myapp` (number, current directory). A tab you
renamed yourself is never touched — manual names win, permanently.

## Why

herdr tabs keep their default numeric names (`1`, `2`, …) forever. With
several tabs of agents and shells, the tab bar says nothing about what is
where. The content of each tab usually *does* say — the agent's live task
summary, or the shell's directory — so this plugin makes the label follow it.

## Behaviour

- A default-named tab running an agent is labelled `<number> · <title>`,
  where the title is the agent's terminal title (lowercased, capped at 30
  characters) — for Claude Code that's the live task summary, updated as work
  progresses. Until a real title exists (the pre-summary product-name titles
  like "claude code" are treated as no title), the agent's name stands in:
  `<number> · claude`.
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
current label is the default (its display position — herdr renumbers default
labels live as tabs close) or the plugin's own last write, tracked in plugin
state. The agent session title comes from the pane's `terminal_title_stripped`
field — the OSC title herdr already captures. Just before each rename the tab's
label is re-read, so a manual rename landing mid-sweep always wins.

Event mapping, as observed on herdr 0.8.0: agent start and agent-quit-to-shell
both arrive via `pane.agent_detected`/`pane.agent_status_changed`
re-evaluation (`pane.exited` does *not* fire when an agent quits — the pane
survives); title updates are picked up by the status/focus events. Since every
event triggers a full reconcile, the mapping only affects latency, never
correctness.

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

`--dry-run` outside herdr reads the real plugin state directory (if present),
so the preview matches what event-driven runs would actually do — including
updates to tabs the plugin already owns.

Tests use the built-in `node:test` runner — Node ≥ 20 for development. (The
test file is run directly rather than via `node --test`: glob arguments need
Node ≥ 21, and this repo's `test/` directory name collides with the runner's
default discovery patterns.)

## License

MIT
