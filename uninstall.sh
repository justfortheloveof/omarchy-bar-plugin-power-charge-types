#!/bin/bash
#
# Remove what install.sh put in place.
#
#   sudo ./uninstall.sh
#
# Removing the plugin with `omarchy plugin remove` does not do this: that
# command only knows about files under ~/.config/omarchy/plugins.

set -euo pipefail

readonly PACKAGED_DIR=/usr/local/libexec/io.github.justfortheloveof.power-charge-types
readonly PACKAGED_PATH="$PACKAGED_DIR/charge-types"

readonly RULES_PATH=/etc/polkit-1/rules.d/50-power-charge-types.rules

# The rules file is a verbatim copy of the plugin's
# policy/power-charge-types.rules.example, so this line is in it. Checking
# it before a root-owned rm proves the file is ours and re-confirms where it came
# from.
readonly RULES_MARKER='https://github.com/justfortheloveof/omarchy-bar-plugin-power-charge-types'

die() {
	printf 'uninstall.sh: %s\n' "$1" >&2
	exit 1
}

((EUID == 0)) || die "run this with sudo: sudo $0"

# Recorded before anything is removed, so the closing line can say what this run
# left behind rather than what happens to be on disk by then.
helper_was_installed=0

if [[ ! -e $PACKAGED_PATH ]]; then
	printf 'Nothing installed at %s\n' "$PACKAGED_PATH"
else
	helper_was_installed=1

	# Refuse to delete a file we cannot identify: this is a root-owned rm and the
	# check costs one grep.
	if ! grep -qF 'charge-types: installed by' "$PACKAGED_PATH"; then
		die "$PACKAGED_PATH does not look like our helper; leaving it alone"
	fi

	rm -f "$PACKAGED_PATH"
	printf 'Removed %s\n' "$PACKAGED_PATH"
fi

rmdir "$PACKAGED_DIR" 2>/dev/null && printf 'Removed %s\n' "$PACKAGED_DIR"

# The rules file is opt-in and install.sh never puts it there, so it is offered
# rather than taken. Left behind, it keeps a passwordless grant pointing at a
# helper that is no longer there.
if [[ -e $RULES_PATH ]]; then
	printf '\nAlso present:\n  %s\n' "$RULES_PATH"
	printf 'It grants this helper without a password. Remove it as well? [y/N] '

	reply=""
	if [[ -t 0 ]]; then
		read -r reply || reply=""
	else
		# No terminal to ask on, so do not block waiting for an answer nobody can
		# give. Same as omarchy-dns falling through to pkexec.
		printf '\n'
	fi

	case ${reply,,} in
	y | yes)
		if grep -qF "$RULES_MARKER" "$RULES_PATH"; then
			rm -f "$RULES_PATH"
			printf 'Removed %s\n' "$RULES_PATH"
			printf 'polkitd watches rules.d, so this applies without a restart.\n'
		else
			printf 'That file does not look like ours; leaving it alone.\n'
		fi
		;;
	*)
		printf 'Left in place. Remove it yourself with:\n  rm %s\n' "$RULES_PATH"
		;;
	esac
fi

if ((helper_was_installed)); then
	printf '\nDone. The panel will now read the current charge type but refuse to change it.\n'
else
	printf '\nDone. Nothing was installed, so nothing is left behind.\n'
fi
