# Contributing

## Where things live

| Path | |
| --- | --- |
| `Panel.qml` | the forked power panel: installed upstream plus our additions |
| `Model.js` | upstream, unchanged, and must stay that way |
| `Utils.js` | the panel's shared logic: charge-type state, and the battery-health rendering |
| `manifest.json` | plugin id, `clonedFrom: omarchy.power` |
| `bin/charge-types` | the only thing that runs as root |
| `install.sh`, `uninstall.sh` | one-time privileged setup, and its removal; `uninstall.sh` also offers to remove the polkit rule |
| `policy/power-charge-types.rules.example` | optional passwordless grant, never installed automatically; copied by hand to `/etc/polkit-1/rules.d/50-power-charge-types.rules` |
| `upstream.lock` | pinned merge base and fetch coordinates |
| `tools/sync-upstream` | the three-way merge against upstream |
| `tests/` | `utils.test.cjs` (the shared logic) and `charge-types.test.cjs` (the helper) |

## Relationship to upstream

`Panel.qml` and `Model.js` are a copy of `shell/plugins/panels/power/` from [basecamp/omarchy][omarchy]. `Model.js` is unchanged; `Panel.qml` is the installed omarchy's panel plus the charge-type section. `manifest.json` is the only other upstream file this fork changes. `Utils.js`, `bin/`, `policy/` and `tests/` are new.

`manifest.json` declares `omarchy.clonedFrom: omarchy.power`, which is how Omarchy lets a plugin replace a built-in one. A panel builds its own contents inline; there is no API for another plugin to add a section to one, and `clonedFrom` replaces the original rather than layering on top of it. The alternative to forking is a separate bar widget with its own panel and IPC target, which sits beside the Power panel instead of inside it.

`Panel.qml` keeps `moduleName` and `ipcTarget` at `omarchy.power` on purpose: `clonedFrom` is what routes IPC and the bar slot, so rewriting those two identifiers would detach the widget from its place in the bar and break `omarchy-shell omarchy.power`.

[omarchy]: https://github.com/basecamp/omarchy

## Keeping `Panel.qml` mergeable

`Panel.qml` is upstream's. Everything this fork adds is an insertion, never an edit of a line upstream owns, and every change is marked, so the fork's delta is visible at a glance and checked by machine:

- **An inserted block** is fenced at both ends:

  ```qml
  // ---- charge-types: start ----
  Process {
    id: chargeTypesProbe
    ...
  }
  // ---- charge-types: end ----
  ```

- **An edited line** - upstream's line, changed - carries a tail marker:

  ```qml
  onActivateRequested: root.activateCursor() // charge-types
  ```

The fence is demarcation, not protection. `git merge-file` merges by line and treats the markers as ordinary comments, so an upstream change *can* land inside a fence and auto-merge there. The rules below are what keep merges clean; the markers make the result legible.

The merge is clean whenever the two sides do not share a line, so:

- Adding a whole new `Process { }`, function, or panel section is free.
- Changing a line upstream owns costs a conflict every time.
- Reformatting, reordering, or tidying upstream code costs a conflict forever and buys nothing.

Do not reformat `Model.js` unless a feature needs it. Upstream tests it in `test/shell.d/power-test.sh`, so churn there makes future merges noisy.

The only edits of lines upstream owns are the keyboard-cursor ones: the key dispatcher's `onMoveRequested` and `onActivateRequested` handlers, the key catcher's `blocked` line (suspended while the dropdown's popup owns the keys), and the profile `Button`'s `hasCursor` and `onHovered`. A row that is not ours must not light, and the cursor must walk *between* rows, which cannot be expressed from outside the components that draw it. Two more lines are edited for non-cursor reasons: `refresh()`'s closing brace (it carries the tail marker because our probe hook is fenced inside the function) and the battery `InfoPair` line, which the health row replaces. Each such line carries a tail marker, and so must any you add: the coverage check below fails on a changed line that has neither.

Two files escape the rule, on purpose:

- `manifest.json` is JSON, which has no comments. Its delta - id, name, description, `clonedFrom` - is visible only in the diff.
- `Utils.js` is new, so the whole file is the fork's; the file boundary is the fence.

**The markers are checked, not merely conventional.** `bin/check` runs two stages over the tracked files: the fences must balance (every start its end, no end unmet), and every line this fork has added to `Panel.qml` against the pinned base must sit inside a fence or carry a tail marker - an unmarked change fails the check. `tools/sync-upstream` additionally refuses to merge over unbalanced fences, the way it already refuses to merge over leftover conflict markers.

**Check a change stays mergeable rather than assuming it.** Three-way merge `Panel.qml` against a deliberately adversarial upstream:

```bash
sha=$(sed -n 's/^sha=//p' upstream.lock)
git --git-dir=/tmp/omarchy-power-charge-types-upstream.git \
    show "$sha:shell/plugins/panels/power/Panel.qml" > /tmp/base.qml
cp /tmp/base.qml /tmp/theirs.qml   # then add an upstream edit to theirs.qml
git merge-file --diff3 -p Panel.qml /tmp/base.qml /tmp/theirs.qml > /tmp/merged.qml
```

Insert into `theirs.qml` at the exact lines this fork appends to. A conflict whose `||||||| base` section is empty means both sides only added lines, so resolving is a matter of picking an order. A conflict with content in the base section means something was edited, and that is the thing to avoid.

## Upstream

`upstream.lock` records the omarchy commit this fork tracks, and that commit is the common ancestor for every merge.

```bash
tools/sync-upstream --check    # what upstream has done, and what we have, touches nothing
tools/sync-upstream --diff     # our changes against the pinned base, as a patch
tools/sync-upstream            # merge it in
```

`--check` and `--diff` change nothing and can be combined.

### Reading the fork's own diff before syncing

`tools/sync-upstream --diff` is the answer to "what have we changed here?", as a patch rather than a line count. It diffs each tracked file against the pinned sha, so it is this fork's delta whatever upstream has done since: it reads the same when you are up to date, when upstream has moved, and before a merge has run. Output is `git diff`, so it pages on a terminal and is a valid patch when redirected:

```bash
tools/sync-upstream --diff > fork.patch
git apply --check --reverse fork.patch   # confirm it is exactly the current delta
```

A file that matches the pinned base does not appear at all (`Model.js` in practice), which is the same signal `--check` gives as "identical to upstream".

### The merge

`sync-upstream` fetches `basecamp/omarchy` into a bare mirror under `$TMPDIR` (override with `OMARCHY_UPSTREAM_MIRROR` if you want to keep it), then runs `git merge-file --diff3` over `Panel.qml`, `Model.js` and `manifest.json`:

- **current** - this fork's file
- **base** - the file at the pinned sha
- **other** - the file at the current upstream tip

Changes that do not overlap combine on their own. Only genuinely conflicting hunks stop for a human, and the markers are labelled so it is obvious which side is which:

```
<<<<<<< ours (Panel.qml)
  Button { text: root.modeLabel() }   // FORK: ours
||||||| base (upstream c668141e)
  Button { }
=======
  Button { text: root.heroStatusText }   // upstream
>>>>>>> upstream (v4-0-4 c668141e)
```

The pin only advances when every file merged clean. Resolve a conflict, commit the resolution, then re-run: it merges again from the still-unpinned base, which by then matches your resolved file, so the second run comes back clean and re-pins.

### Which upstream branch, and the ordering rule

**It tracks the omarchy you have installed: the release branch, not omarchy's development branch.** That is the part worth understanding, because getting it wrong is invisible until the widget fails to appear.

Every release has its own branch (`v4-0-1`, `v4-0-4`, ...), and they form a fast-forward chain, so after `omarchy update` the pin walks forward from one release to the next. `quattro` is omarchy's development branch and the repo's default; merging against it would import panel code that no released omarchy has yet.

A cloned first-party panel is not self-contained. It imports types and singleton members that the shell provides, so panel code from a newer omarchy can reference API this machine does not have:

| upstream commit | what `Panel.qml` gained | what happens on an older omarchy |
| --- | --- | --- |
| `c231097d` | `ShellIpc`, plus its `qmldir` entry | `ShellIpc is not a type`; the widget never loads and the bar slot is simply empty |
| `b18ab495` | `Style.duration()`, `Style.reduceMotion` | `Style` exists, so these fail as missing members |

Neither produces an error anyone sees. So the order is: **update omarchy first, then run `tools/sync-upstream`** to advance the pin. Until then, `--check` reporting drift is correct information rather than an action item, and `bin/check` fails if the panel ever outruns the shell again.

`--check` also compares the lock's `branch=` against the omarchy installed on this machine and warns when they disagree, so that ordering rule is checked rather than only written down. It warns and carries on: a fork tracking an older omarchy is still a fork worth keeping in step.

After merging, run `bin/check`. The `Model.js` stage will tell you if the merge touched something it should not have, and the shell API stages will tell you if the merge outran the omarchy you are running.

## Checks

```bash
bin/check
```

Run it before committing. It is everything CI runs, plus the two stages that need an Omarchy box. Any failing stage exits non-zero, and skipped stages are listed, so a partial run never reads as green.

| Stage | Fails on |
| --- | --- |
| `bash -n`, once per script | a shell script that does not parse |
| `bin/check-agent-files` | an agent-instruction file anywhere in the tree |
| `manifest.json` parse | invalid JSON |
| `node --test`, both suites | any test failure |
| fork marker balance | a `charge-types` fence that starts and does not end, or vice versa (runs in CI too) |
| `Model.js` against the pinned upstream sha | any divergence at all (runs in CI too) |
| fork marker coverage | a `Panel.qml` line this fork changed that is neither fenced nor tail-marked |
| `qmllint` type resolution | `Panel.qml` referencing shell API this omarchy lacks |
| `Style` members | `Panel.qml` using a `Style` member the installed omarchy lacks |
| `omarchy plugin validate` | manifest schema |
| `tools/sync-upstream --check` | never; reports where this fork sits |

Five of those deserve a note.

**`Model.js` must stay byte-identical to upstream.** The README calls it unchanged, and every line added to it is a line that can conflict on the next sync. Upstream tests it in `test/shell.d/power-test.sh`, so churn there is noise for them as well. If this stage fails, the fix is almost always to revert `Model.js` and put the code somewhere else.

**The marker stages keep the fork's delta marked.** Balance is comment-only and needs nothing, so it runs in CI too. Coverage diffs `Panel.qml` against the pinned base and requires that every added line sit inside a `charge-types` fence or carry a tail marker - it is the machine's eye on the rule that every change from upstream is marked, and it is why an unmarked insertion is a failed check rather than a style gripe.

**The shell API stages are the important ones.** A cloned first-party panel is not self-contained: it imports types and singleton members the shell provides, so panel code from a newer omarchy can reference API this machine does not have. `ShellIpc` and `Style.duration()` both shipped here first and both failed silently, the widget just never appearing in the bar. Type resolution reuses qmllint's own resolver rather than a hand-rolled list, so nothing new to maintain; `signal-handler-parameters` is excluded because upstream's own file produces it. The `Style` check exists separately because qmllint structurally cannot catch a missing member on a singleton that does resolve.

**`qmllint` is otherwise gated on its exit status, not its output.** qmllint reports everything as `Warning: ... [category]`, a fatal syntax error included, so grepping for `Error` finds nothing. The exit code is the signal: 0 when the file parses, 255 when it does not.

**The two shell API stages are gated separately, because they need different things.** The `Style` check is `grep` against the installed `Style.qml` and needs
nothing but `$SHELL_DIR`; only type resolution runs `qmllint`. They used to sit in one `if/elif`, so a box with Qt installed but unlinked skipped both and reported the missing shell directory as the reason, which was false. `qmllint` lives in `/usr/lib/qt6/bin` without a symlink into `/usr/bin`, so `command -v` misses it on most boxes; `bin/check` probes that directory and the `x86_64-linux-gnu` variant, then falls back to `PATH`. Each skip now names its own cause, and a skip is a skip of one stage rather than two.

Stages skipped: no `omarchy` (off-box), no `qmllint` (not installed), no upstream shell tree. The shell API stages can never run in CI, which has no Omarchy; they run for anyone who clones the repo on an Omarchy box. The `Style` stage runs anywhere `$SHELL_DIR` exists, so it runs with or without `qmllint`.

`bin/check` guards the two ways this fork has broken before: `Model.js` drifting from upstream, and `Panel.qml` outrunning the shell API you are running.

## Tests

```bash
node --test tests/utils.test.cjs      # the logic
node --test tests/charge-types.test.cjs  # the helper's arguments and writes
```

Neither needs root, a particular battery, or anything in `/sys`. The helper's privileged path is exercised through `unshare -r`, which maps the caller to uid 0 in a throwaway user namespace, with the sysfs glob rewritten to point at a temporary tree. The host is untouched.

`tests/utils.test.cjs` covers `Utils.js`: the words the helper prints, the state mapping, the value check that gates `pkexec`, and the battery-health rendering. `tests/charge-types.test.cjs` covers `bin/charge-types`: argument validation, exit codes, the write, and the agreement between the helper, `install.sh`, `uninstall.sh` and `Panel.qml` about the path they share.

One gap, on purpose. The branch that reports a write the kernel refused needs a sysfs attribute that rejects a value, which a plain file cannot be, so that test asserts the check is present rather than pretending to exercise it.

## Keyboard navigation

The panel's keyboard cursor is upstream's own: `cursorActive` plus a flat `profileIndex` into the profile buttons. We extend that rather than replace it. The rows below the stats are the charge row and the profile row, in display order, and the cursor over them is `cursorRow: -1 | 0 | 1` - an index into that display order, where `-1` means "not armed" - instead of the boolean a single row would need, because the walk now moves *between* the two rows.

- `h`/`l` and the left/right arrows move between profiles, unchanged.
- `j`/`k` and up/down walk between the two rows (`Utils.moveRowFocus`), lighting exactly one row at a time, clamped at both ends, no wrap. From unarmed, the first move press arms and lands on the first available row down, or the last up.
- Return or Space activates whichever row the cursor is on: on the charge row it opens the dropdown, on the profile row it activates the selected profile.
- Hovering a row moves the cursor there, so mouse and keyboard agree and only one row is lit. The charge row only claims the cursor when it is ready.
- While the dropdown's popup is open the panel's key catcher suspends (`blocked`), so `j`/`k`, Return and Esc drive the popup instead of the panel; on close the catcher resumes and the cursor is back on the charge row.

Two deliberate differences from a stock panel:

- Upstream sends `j`/`k` into the profile list. Here they change rows, and only `h`/`l` move between profiles.
- Our row is skipped entirely while it cannot act - before `install.sh` has run, or the type has not been read - so the cursor cannot park on a dropdown that would refuse to act. The cost is that the row's "run `sudo ./install.sh`" caption cannot be read with the keyboard alone.

The row's label is bold because the shared `Dropdown` component hardcodes `font.bold` on its label and offers no property to turn it off. Matching regular weight, as the network panel's list rows use, would mean replacing a shared component with a local one - and losing its tab focus and popup handling with it.

On (re)opening the panel the cursor resets to unarmed along with `cursorActive`, so a row focused in the last session does not light on the first key press; the first move press re-arms it. Within a session the cursor stays where it was last put, and hovering a row leaves it lit after the mouse moves away, because that is upstream's behaviour: `cursorActive` is only ever cleared when the battery appears, so a profile button stays lit the same way. We match it rather than giving our row a second hover model.

The keyboard cursor is the one place where adding a feature meant changing upstream's code rather than only adding to it: the key dispatcher's `onMoveRequested` and `onActivateRequested` handlers, the key catcher's `blocked` line, and the profile `Button`'s `hasCursor` and `onHovered` - a row that is not ours must not light, and hovering it must not steal the cursor. The handlers now call one function of ours, and upstream's `selectProfileByDelta`, `activateSelectedProfile` and `setProfile` are untouched behind them. The rules in [Keeping `Panel.qml` mergeable](#keeping-panelqml-mergeable) apply to those from now on.

## Security

The reasoning behind the root-owned helper lives in the README's *How the privileged part works* section. The short version: the installed copy is the only thing ever elevated, it takes no path from its caller, and it writes only values it just read from the attribute's own list.

If you touch `bin/charge-types`, `install.sh`, `uninstall.sh` or `policy/`, read that section first. Two invariants the tests currently only partly cover, and which you should not weaken:

- The helper never re-executes itself. `set` requires already being root, so a copy in a user-writable directory cannot elevate itself.
- `install.sh` must not copy the rules example into `/etc/polkit-1`. Nothing should persist in the system's authorisation policy unless a person asked for it. There is a test asserting exactly that.

## Not allowed in this tree

No `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`, `.claude/`, `.cursor/` or anything else `bin/check-agent-files` recognises. `omarchy plugin add` copies this repository into a path coding agents auto-discover, and the marketplace refuses plugins carrying those files. `bin/check` enforces it.

Also: no symlinks inside the plugin folder, no personal paths, no secrets, and nothing machine-specific in fixtures or history.
