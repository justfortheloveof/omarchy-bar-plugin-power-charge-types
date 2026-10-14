# Power - with Charge Types

Adds a charge-type selector and battery-health readout to Omarchy's Quattro power bar.

**Only tested on a Lenovo ThinkBook 13x G2 IAP.**

The kernel exposes the power supply's `charge_types` attribute on batteries since Linux 6.14 (December 2024). `Long_Life` typically stops charging around 80%, helping preserve battery capacity when a machine stays plugged in.

![preview](preview.png)

We use a drop-down instead of buttons because different hardware may support fewer or more charge profiles/types. The plugin reads the `charge_types` list and shows the active type, so it works with any battery that exposes `charge_types` and `energy_full_design`.

## What it does

- Replaces Omarchy's stock Power panel; removing this plugin restores it.
- Shows the active charge type and offers a drop-down of the battery's supported types. Failed writes trigger a notification.
- Shows battery health (remaining vs. design capacity, from `energy_full` / `energy_full_design`) in place of the stock battery-size row.
- Uses polkit for elevated operations; the default is to require authentication for each change, but an optional rule can allow passwordless changes.

## Install

The `charge_types` attribute requires **kernel ≥ 6.14**. On older kernels, the selector explains that the battery has no charge-type control and remains disabled.

```bash
omarchy plugin add https://github.com/justfortheloveof/omarchy-bar-plugin-power-charge-types.git --enable
sudo ~/.config/omarchy/plugins/io.github.justfortheloveof.power-charge-types/install.sh
omarchy-restart-shell
```

### Optional: skip authentication

By default, changing a type opens the Omarchy password dialog. To allow passwordless changes, install the example polkit rule:

```bash
cd ~/.config/omarchy/plugins/io.github.justfortheloveof.power-charge-types
sudo cp policy/power-charge-types.rules.example \
     /etc/polkit-1/rules.d/50-power-charge-types.rules
omarchy-restart-shell
cd -
```

This permanently grants the exact `charge-types set <type>` command to wheel members in a local session; it grants no other command. Delete the rule to revoke it. This is an explicit, optional exception to the default authentication requirement.

## Charge-type selector

The **CHARGE PROFILE** section appears below POWER PROFILE. Its drop-down is enabled when the battery's type list and active type can be read. Otherwise, the caption explains why:

| Caption | Meaning |
| --- | --- |
| `Current charge type unknown. Run sudo ./install.sh in the plugin directory to enable changes.` | The helper is not installed; even the active type cannot be read. See [Install](#install). |
| `No charge-type control on this battery, so the type cannot be changed.` | The battery's `charge_types` list is missing or unusable (for example, on a pre-6.14 kernel). |
| `Current charge type unknown: the battery reported a value this plugin does not recognise.` | The list was read but is malformed, so the plugin will not guess. |

With no caption, the battery's types are listed and the active one is selected.

### “Charge limit” row

When charging is held at a ceiling, the stats row uses the UI label **Charge limit** to show the charge ceiling:

| Battery state | Value |
| --- | --- |
| A threshold is set | The threshold the battery is charging to |
| No threshold; `Long_Life` active | `~80%`, the model-typical ceiling. The exact value is firmware-defined. |
| No threshold; another type active | `-` (no charge ceiling) |

## CLI and panel IPC

```bash
charge-types list
charge-types status
pkexec /usr/local/libexec/io.github.justfortheloveof.power-charge-types/charge-types set <type>
```

`list` prints one type per line, with the active type in brackets; `status` prints the active name. Both are unprivileged and return `unsupported` (exit 3) if no suitable battery exists or `unknown` (exit 4) if its list cannot be parsed. `set` requires root, accepts spaces or underscores (`Long Life` / `Long_Life`), and confirms the write by reading the new type back.

The panel exposes the same information over IPC:

```bash
omarchy-shell omarchy.power chargeTypeStatus
omarchy-shell omarchy.power setChargeType Long_Life
```

`chargeTypeStatus` returns the panel's last read immediately. `setChargeType` queues a background write and immediately returns the requested type (or nothing if it could not act), not the outcome. Dismissing the dialog leaves the type unchanged without a notification; other failures notify. The panel rereads the type when the write completes.

## Update

```bash
omarchy plugin update io.github.justfortheloveof.power-charge-types --yes
```

## Uninstall

```bash
sudo ~/.config/omarchy/plugins/io.github.justfortheloveof.power-charge-types/uninstall.sh
omarchy plugin remove io.github.justfortheloveof.power-charge-types --yes
```

Plugin removal restores the stock Power panel but only removes files under `~/.config/omarchy/plugins`; the root-owned helper and any optional polkit rule remain. `uninstall.sh` removes the helper and asks whether to remove the rule (`y` removes it; any other answer leaves it in place and prints the removal command).

## How the privileged part works

Reading `charge_types` is allowed to regular users; writing it requires root. The panel reads through the helper script, so the selector cannot read the active type until the helper is installed, though reading never prompts for a password. Because the plugin directory is user-writable, `install.sh` copies the helper to a root-owned location and only that installed copy is elevated:

```
/usr/local/libexec/io.github.justfortheloveof.power-charge-types/charge-types  root:root, mode 0755
```

The helper takes no caller-supplied path and writes only a type from the battery's own list. By default, `pkexec` uses the system's `org.freedesktop.policykit.exec` action (`auth_admin`), so every change authenticates; no sudoers entry is used. The optional rule above is the only persistent passwordless grant and is never installed automatically:

```
/etc/polkit-1/rules.d/50-power-charge-types.rules
```

Both files include their source repository and license in their headers.

## Development

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## License

MIT - see `LICENSE`. `Panel.qml` and `Model.js` are Copyright (c) David Heinemeier Hansson and Omarchy contributors.
