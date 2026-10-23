# Contributing

## Where things live

| Path | Purpose |
| --- | --- |
| `Panel.qml` | Upstream power panel plus marked fork additions |
| `Model.js` | Upstream file; keep byte-identical |
| `Utils.js` | Charge-type state and battery-health rendering |
| `manifest.json` | Plugin metadata and `clonedFrom: omarchy.power` |
| `bin/charge-types` | Privileged helper |
| `install.sh`, `uninstall.sh` | Install/remove helper; uninstall offers to remove the polkit rule |
| `policy/power-charge-types.rules.example` | Optional, manually installed passwordless grant |
| `upstream.lock`, `tools/sync-upstream` | Pinned merge base and sync workflow |
| `tests/` | `utils.test.cjs` and `charge-types.test.cjs` |

## Relationship to upstream

`Panel.qml` and `Model.js` come from [`omacom/omarchy`][omarchy]'s `shell/plugins/panels/power/`. `Model.js` stays unchanged; `Panel.qml` contains marked additions and a few necessary edits. `manifest.json` is the only other changed upstream file; `Utils.js`, `bin/`, `policy/`, and `tests/` are new.

`manifest.json`'s `omarchy.clonedFrom: omarchy.power` makes this plugin replace the built-in panel. Panels have no API for another plugin to add a section, and `clonedFrom` does not layer panels. Keep `moduleName` and `ipcTarget` as `omarchy.power`; changing them breaks the bar slot and `omarchy-shell omarchy.power` IPC.

[omarchy]: https://github.com/omacom/omarchy

## Keeping `Panel.qml` mergeable

Treat `Panel.qml` as upstream-owned: add code in marked insertions, not by changing upstream lines. `git merge-file` treats markers as comments, so an upstream edit can still merge inside a fence; markers make the delta visible but do not protect it.

- Fence each inserted block with `// ---- charge-types: start ----` and `// ---- charge-types: end ----`.
- Add `// charge-types` to every edited upstream line.
- Add new functions, processes, and sections rather than reformatting, reordering, or tidying upstream code; overlapping edits conflict on every sync.

The only intentional upstream-line edits are keyboard-cursor hooks (`onMoveRequested`, `onActivateRequested`, the key catcher's `blocked`, and the profile button's `hasCursor` / `onHovered`), `refresh()`'s closing brace for the fenced probe hook, and the battery `InfoPair` replaced by the health row. Any new changed line also needs a tail marker. The coverage check rejects unmarked changes.

`Model.js` must stay byte-identical; upstream tests it in `test/shell.d/power-test.sh`. `manifest.json` cannot carry comment markers, so review its metadata delta in the diff. `Utils.js` is new and wholly fork-owned.

`bin/check` checks that fences balance and every `Panel.qml` addition against the pinned base is fenced or tail-marked. `tools/sync-upstream` also rejects unbalanced fences.

To test a merge against an upstream edit at a line this fork appends to, create an adversarial `theirs.qml` and run:

```bash
sha=$(sed -n 's/^sha=//p' upstream.lock)
git --git-dir=/tmp/omarchy-power-charge-types-upstream.git \
    show "$sha:shell/plugins/panels/power/Panel.qml" > /tmp/base.qml
cp /tmp/base.qml /tmp/theirs.qml   # then add an upstream edit to theirs.qml
git merge-file --diff3 -p Panel.qml /tmp/base.qml /tmp/theirs.qml > /tmp/merged.qml
```

An empty `||||||| base` conflict section means both sides only inserted lines; choose an order. Content in that section means an upstream-owned line was edited and should be avoided.

## Upstream sync

`upstream.lock` pins the common ancestor for each merge. Inspect the state and fork delta, then merge:

```bash
tools/sync-upstream --check    # report upstream and fork state; no changes
tools/sync-upstream --diff     # fork delta against the pinned base
tools/sync-upstream            # merge upstream
```

`--check` and `--diff` are read-only and can be combined. `--diff` shows the same fork delta before or after upstream moves; redirect it to validate the patch:

```bash
tools/sync-upstream --diff > fork.patch
git apply --check --reverse fork.patch
```

Files identical to the pinned base (normally `Model.js`) do not appear. The sync fetches `omacom/omarchy` to a bare mirror under `$TMPDIR` (`OMARCHY_UPSTREAM_MIRROR` can override it), then merges `Panel.qml`, `Model.js`, and `manifest.json` with `git merge-file --diff3`: current fork, pinned base, current upstream. Non-overlapping changes combine; conflicting hunks need resolution. The pin advances only after all files merge cleanly. Resolve and commit a conflict, then rerun the sync to merge from the still-pinned base and advance the pin.

### Track the installed release

Sync against the Omarchy **release branch installed on your machine**, not the `quattro` development branch. Releases form a fast-forward chain; `quattro` can introduce APIs not present in any released shell. Update Omarchy first, then run `tools/sync-upstream`.

A cloned panel depends on shell-provided types and singleton members. Newer panel code can silently fail to load on an older shell:

| Upstream commit | New API | Failure on an older shell |
| --- | --- | --- |
| `c231097d` | `ShellIpc` and its `qmldir` entry | `ShellIpc is not a type`; panel does not load |
| `b18ab495` | `Style.duration()`, `Style.reduceMotion` | Missing `Style` members |

Until Omarchy is updated, `--check` reporting upstream drift is informational. It also warns if `upstream.lock`'s `branch=` differs from the installed release. After syncing, run `bin/check`; it verifies `Model.js` and checks that `Panel.qml` does not outrun the installed shell API.

## Checks

Run `bin/check` before committing. It is CI's check entry point plus local Omarchy-shell checks. Failures exit non-zero; unavailable environment-dependent stages are reported as skipped.

| Check | Detects |
| --- | --- |
| `bash -n` | Invalid shell syntax |
| `bin/check-agent-files` | Publishable agent-instruction files |
| `manifest.json` parse / `omarchy plugin validate` | Invalid JSON or manifest schema |
| Both `node --test` suites | Test failures |
| Fork marker balance / coverage | Unbalanced fences or unmarked `Panel.qml` changes (balance also runs in CI) |
| `Model.js` vs pinned upstream | Any divergence (also runs in CI) |
| `qmllint` type resolution / `Style` members | Shell APIs missing from the installed Omarchy |
| `tools/sync-upstream --check` | Reports sync state; does not fail |

Keep `Model.js` unchanged and keep every fork addition marked. The shell checks guard against a cloned panel silently failing to load because it uses an API newer than the installed Omarchy. Type resolution uses `qmllint` (excluding `signal-handler-parameters`, which upstream also reports); the separate `Style` check is needed because `qmllint` cannot detect missing members on a resolved singleton. `qmllint`'s exit code, not its warning text, indicates parse failure.

The shell API stages need `$SHELL_DIR`; type resolution also needs `qmllint` (searched under `/usr/lib/qt6/bin` and its `x86_64-linux-gnu` variant, then `PATH`). Each stage reports its own skip reason. The shell API checks cannot run in CI; the `Style` check can run wherever `$SHELL_DIR` exists.

## Tests

```bash
node --test tests/utils.test.cjs
node --test tests/charge-types.test.cjs
```

Tests need no root, battery, or `/sys` access. The helper's privileged path uses `unshare -r` and a temporary sysfs tree, leaving the host untouched. The first suite covers shared logic, state mapping, `pkexec` gating, and battery-health rendering; the second covers helper arguments, exit codes, writes, and the shared helper path. The kernel-rejected-write case cannot be exercised with a plain file, so its test checks the validation rather than simulating a rejection.

## Keyboard navigation

The panel extends upstream's `cursorActive` / `profileIndex` navigation with `cursorRow: -1 | 0 | 1` for the profile and charge rows (`-1` means unarmed).

- `h`/`l` and left/right move between profiles.
- `j`/`k` and up/down move between rows via `Utils.moveRowFocus`; movement is clamped, does not wrap, and lights one row. From unarmed, the first move selects the first available row in that direction.
- Return/Space activates the selected profile or opens the charge dropdown. Hover moves the cursor to the hovered row; the charge row takes focus only when ready.
- While the popup is open, the panel key catcher is blocked so the popup receives `j`/`k`, Return, and Esc. On close, focus returns to the charge row.
- Unlike upstream, `j`/`k` move between rows and `h`/`l` move between profiles. An unavailable charge row is skipped, so keyboard users cannot focus the install-needed caption.
- Reopening the panel resets the cursor to unarmed. Within a session it stays on the last row, including after hover ends, matching upstream's `cursorActive` behavior.

The shared `Dropdown` forces a bold label; making it regular would require replacing it and losing its tab-focus and popup handling. The cursor hooks are the only feature edits to upstream-owned keyboard code; preserve upstream's `selectProfileByDelta`, `activateSelectedProfile`, and `setProfile` behavior. See [Keeping `Panel.qml` mergeable](#keeping-panelqml-mergeable) before changing those lines.

## Security

See the README's [privileged-helper explanation](../README.md#how-the-privileged-part-works) before changing `bin/charge-types`, `install.sh`, `uninstall.sh`, or `policy/`. Preserve these invariants:

- The installed root-owned copy is the only elevated helper; it takes no path from its caller and writes only listed charge types.
- The helper never re-executes itself; `set` only runs when invoked as root.
- `install.sh` never installs the example polkit rule. System-wide passwordless authorization is opt-in.

## Not allowed in this tree

Do not include `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`, `.claude/`, `.cursor/`, or other files recognized by `bin/check-agent-files`. The plugin is copied to a path coding agents discover, and the marketplace rejects these files; `bin/check` enforces the rule. Also exclude symlinks within the plugin, personal paths, secrets, and machine-specific fixtures or history.
