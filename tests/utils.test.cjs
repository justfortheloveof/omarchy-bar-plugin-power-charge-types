// Unit tests for Utils.js - run with: node --test tests/utils.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(`${__dirname}/../Utils.js`, "utf8"), ctx);
const { statusWord, parseState, nextValue, isAcceptedValue, describe, shouldNotify, moveFocusRow, hoverClaimsFocus, healthText, ceilingText } = ctx;

// Exactly what bin/lenovo-power-conservation prints for `status`.
const INSTALLED_ON = "1";
const INSTALLED_OFF = "0";
const INSTALLED_UNKNOWN = "unknown";
const NO_SUCH_MACHINE = "unsupported";
const NOT_INSTALLED = "not-installed";

test("statusWord takes the first non-blank line", () => {
  assert.equal(statusWord("1\n"), "1");
  assert.equal(statusWord("  0  \n"), "0");
  assert.equal(statusWord("\n\n1\n"), "1");
  assert.equal(statusWord("unknown"), "unknown");
});

test("statusWord reports nothing for empty output", () => {
  // A helper that printed nothing, or was never run.
  assert.equal(statusWord(""), "");
  assert.equal(statusWord("\n"), "");
  assert.equal(statusWord("   \n\n"), "");
  assert.equal(statusWord(null), "");
  assert.equal(statusWord(undefined), "");
});

test("parseState maps the two values the mode can hold", () => {
  assert.equal(parseState(INSTALLED_ON), true);
  assert.equal(parseState(INSTALLED_OFF), false);
});

test("parseState reports unknown rather than guessing", () => {
  // Unknown must not collapse to false: that would invite a toggle derived
  // from a value nobody actually read.
  for (const word of [INSTALLED_UNKNOWN, NO_SUCH_MACHINE, NOT_INSTALLED, "", "2", "true", "01"]) {
    assert.equal(parseState(word), null, `"${word}" must not read as off`);
  }
  assert.equal(parseState(null), null);
});

test("nextValue flips a known state", () => {
  assert.equal(nextValue(true), "0", "was on, so turn it off");
  assert.equal(nextValue(false), "1", "was off, so turn it on");
});

test("nextValue refuses an unknown state", () => {
  assert.equal(nextValue(null), null);
  assert.equal(nextValue(undefined), null);
  assert.equal(nextValue("1"), null, "strings are not booleans here");
  assert.equal(nextValue(0), null);
});

test("nextValue round-trips through parseState", () => {
  for (const word of [INSTALLED_ON, INSTALLED_OFF]) {
    assert.equal(parseState(nextValue(parseState(word))), !parseState(word));
  }
});

test("isAcceptedValue allows only the two exact strings", () => {
  assert.equal(isAcceptedValue("0"), true);
  assert.equal(isAcceptedValue("1"), true);
});

test("isAcceptedValue rejects everything else", () => {
  // This gates the pkexec call, so anything loose here would be loose on the
  // way to root.
  const bad = ["", " ", "01", "2", "-1", "0\n", "1 ", true, false, 0, 1, null, undefined, {}, "unknown"];
  for (const value of bad) {
    assert.equal(isAcceptedValue(value), false, `${JSON.stringify(value)} must be rejected`);
  }
});

test("isAcceptedValue only ever admits what nextValue produces", () => {
  for (const state of [true, false]) {
    assert.equal(isAcceptedValue(nextValue(state)), true);
  }
  assert.equal(isAcceptedValue(nextValue(null)), false);
});

test("shouldNotify stays quiet when the user dismissed the dialog", () => {
  // 126 is pkexec saying "nobody typed a password on purpose". The mode is
  // unchanged and that was the user's choice, so a notification here would be
  // scolding someone for changing their mind.
  assert.equal(shouldNotify(126, [""]), false);
  assert.equal(shouldNotify(126, ["something pkexec happened to print"]), false);
  assert.equal(shouldNotify("126", ["nope"]), false, "the code may arrive as a string");
});

test("shouldNotify stays quiet on success", () => {
  assert.equal(shouldNotify(0, []), false);
  assert.equal(shouldNotify(0, ["warning: no such device"]), false, "stderr on success is not a failure");
});

test("shouldNotify speaks up for a real failure", () => {
  assert.equal(shouldNotify(1, ["conservation: refusing to write '2'"]), true);
  assert.equal(shouldNotify(127, ["command not found"]), true);
});

test("shouldNotify has nothing to say without an explanation", () => {
  // A non-zero exit with no stderr gives us nothing to put in a notification,
  // and inventing a message would be worse than staying quiet.
  assert.equal(shouldNotify(1, []), false);
  assert.equal(shouldNotify(1, ["", "   "]), false, "blank lines are not an explanation");
  assert.equal(shouldNotify(1, undefined), false);
  assert.equal(shouldNotify(1, "not an array"), false);
});

test("shouldNotify keeps the real explanation in a noisy stream", () => {
  assert.equal(shouldNotify(1, ["", "conservation: no attribute found", ""]), true);
});

test("describe reports a working machine with the mode on or off", () => {
  assert.deepEqual({ ...describe(INSTALLED_ON) }, { installed: true, supported: true, active: true });
  assert.deepEqual({ ...describe(INSTALLED_OFF) }, { installed: true, supported: true, active: false });
  assert.deepEqual({ ...describe("1\n") }, { installed: true, supported: true, active: true });
});

test("describe separates a machine without the attribute from an uninstalled helper", () => {
  // Both leave the row unusable, but only one is worth telling the user to fix.
  const unsupported = describe(NO_SUCH_MACHINE);
  assert.equal(unsupported.installed, true, "the helper ran, so it is installed");
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.active, null);

  const missing = describe(NOT_INSTALLED);
  assert.equal(missing.installed, false);
  assert.equal(missing.supported, false);
  assert.equal(missing.active, null);
});

test("describe reports present-but-unreadable separately from absent", () => {
  const unknown = describe(INSTALLED_UNKNOWN);
  assert.equal(unknown.installed, true);
  assert.equal(unknown.supported, true, "the attribute is there");
  assert.equal(unknown.active, null, "but its value means nothing to us");
});

test("describe treats silence as not installed", () => {
  // The helper failed to run at all. Nothing is claimed about the hardware.
  assert.deepEqual({ ...describe("") }, { installed: false, supported: false, active: null });
});

test("the helper's status words are the ones this module knows", () => {
  // If bin/lenovo-power-conservation ever changes what it prints, these tests
  // should be the thing that notices.
  const helper = fs.readFileSync(`${__dirname}/../bin/lenovo-power-conservation`, "utf8");
  assert.match(helper, /printf 'unsupported\\n'/, "prints the unsupported word");
  assert.match(helper, /printf 'unknown\\n'/, "prints the unknown word");
  assert.match(helper, /printf '0\\n'/, "prints 0");
  assert.match(helper, /printf '1\\n'/, "prints 1");
});

test("the README quotes the row's strings verbatim", () => {
  // The reading-the-row table tells a user which sentence in their panel maps to
  // which explanation, so it has to quote exactly what the panel prints. A
  // reword of any of them silently breaks the lookup.
  const panel = fs.readFileSync(`${__dirname}/../Panel.qml`, "utf8");
  const readme = fs.readFileSync(`${__dirname}/../README.md`, "utf8");

  const block = panel.slice(
    panel.indexOf("readonly property string conservationDescription")
  );
  const strings = [
    ...block.slice(0, block.indexOf("\n  }")).matchAll(/return "([^"]+)"/g),
  ].map((m) => m[1]);

  assert.equal(strings.length, 4, "expected the four panel states");
  for (const s of strings) {
    assert.ok(readme.includes(s), `README should quote verbatim: ${s}`);
  }
});

test("moveFocusRow walks between the profile row and ours", () => {
  assert.equal(moveFocusRow(false, 1, true, true), true, "down lands on ours");
  assert.equal(moveFocusRow(true, -1, true, true), false, "up returns to profiles");
});

test("moveFocusRow leaves the cursor at the end rather than wrapping", () => {
  assert.equal(moveFocusRow(true, 1, true, true), true);
  assert.equal(moveFocusRow(false, -1, true, true), false);
});

test("moveFocusRow ignores vertical moves when our row is unavailable", () => {
  assert.equal(moveFocusRow(false, 1, false, true), false, "not installed");
  assert.equal(moveFocusRow(true, -1, false, true), true, "stays put, no escape");
});

test("moveFocusRow reaches ours directly when there are no profiles", () => {
  assert.equal(moveFocusRow(false, 1, true, false), true);
});

test("moveFocusRow ignores a zero delta", () => {
  assert.equal(moveFocusRow(false, 0, true, true), false);
  assert.equal(moveFocusRow(true, 0, true, true), true);
});

test("hoverClaimsFocus follows whether the row could be activated", () => {
  assert.equal(hoverClaimsFocus(true), true);
  assert.equal(hoverClaimsFocus(false), false);
});

// healthText: the text for the Battery health row, from the combined output
// of `cat .../energy_full .../energy_full_design`. String literals only - no
// /sys access, so it runs on any machine.
test("healthText renders remaining capacity as a one-decimal percentage", () => {
  assert.equal(healthText("44650000\n56000000\n"), "79.7%");
});

test("healthText handles output without a trailing newline", () => {
  assert.equal(healthText("10000000\n10000000"), "100.0%");
});

test("healthText renders full > design as the computed value, not an error", () => {
  // A battery replaced with a bigger one reports more than its design figure.
  assert.equal(healthText("60000000\n56000000"), "107.1%");
});

test("healthText is a dash when one of the two files is missing", () => {
  assert.equal(healthText("44650000\n"), "—");
});

test("healthText is a dash when nothing was read", () => {
  // Both files unreadable: stderr is discarded, stdout is empty.
  assert.equal(healthText(""), "—");
  assert.equal(healthText(null), "—");
  assert.equal(healthText(undefined), "—");
});

test("healthText is a dash for non-numeric output", () => {
  assert.equal(healthText("banana\n56000000"), "—");
});

test("healthText is a dash when the design capacity is zero", () => {
  assert.equal(healthText("100\n0"), "—");
});

test("healthText is a dash for more than two tokens", () => {
  assert.equal(healthText("100\n200\n300"), "—");
});

// ceilingText: the "Charge limit" row's value. A real upstream threshold wins;
// a conservation-capped battery shows the model-typical ceiling; else the dash.
test("ceilingText shows a real upstream threshold, even with conservation on", () => {
  assert.equal(ceilingText("80%", true), "80%");
  assert.equal(ceilingText("75-80%", false), "75-80%");
});

test("ceilingText falls back to the conservation ceiling when no threshold is set", () => {
  // The tilde is the honest hedge: the conservation ceiling is firmware-defined
  // (60-80%), not something we read back, so we assert the typical value.
  assert.equal(ceilingText(undefined, true), "~80%");
  assert.equal(ceilingText("", true), "~80%");
});

test("ceilingText is a dash when neither a threshold nor conservation applies", () => {
  assert.equal(ceilingText(undefined, false), "-");
  assert.equal(ceilingText("", false), "-");
});
