// Unit tests for Utils.js - run with: node --test tests/utils.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(`${__dirname}/../Utils.js`, "utf8"), ctx);
const { parseChargeTypes, isAcceptedValue, describe, shouldNotify, moveRowFocus, hoverClaimsFocus, healthText, ceilingText } = ctx;

// Exactly what bin/charge-types prints for `list`, and the word
// the panel's own wrapper supplies when the helper is missing.
const LIST_OK = "Fast\nStandard\n[Long_Life]\n";
const NO_SUCH_MACHINE = "unsupported";
const NOT_INSTALLED = "not-installed";

// The parsed object comes back from the vm realm, whose Array prototype is
// not this realm's, so a strict deep-equal rejects it on prototype alone.
// Re-box the fields here, in this realm, before comparing.
const asPlain = (p) => ({ installed: p.installed, supported: p.supported, known: p.known, activeType: p.activeType, options: [...p.options] });

test("parseChargeTypes reads the helper's list output", () => {
  // The working case: every entry becomes an option, brackets stripped, and
  // the bracketed one is the active type.
  assert.deepEqual(
    asPlain(parseChargeTypes(LIST_OK)),
    { installed: true, supported: true, known: true, activeType: "Long_Life", options: ["Fast", "Standard", "Long_Life"] }
  );
});

test("parseChargeTypes tolerates missing brackets on a line and extra whitespace", () => {
  assert.deepEqual(
    asPlain(parseChargeTypes("\n  Fast\nStandard  [Long_Life]  \n\n")),
    { installed: true, supported: true, known: true, activeType: "Long_Life", options: ["Fast", "Standard", "Long_Life"] }
  );
});

test("parseChargeTypes reads a one-line list", () => {
  // The helper prints one type per line; a space-joined list is the raw
  // attribute form, and reading it the same way keeps the parse forgiving.
  assert.deepEqual(
    asPlain(parseChargeTypes("Fast Standard [Long_Life]")),
    { installed: true, supported: true, known: true, activeType: "Long_Life", options: ["Fast", "Standard", "Long_Life"] }
  );
});

test("parseChargeTypes reports a list with no active entry as known:false", () => {
  // A battery that lists types but names none active: the options are still
  // worth showing, but the state is unreadable, and unreadable must not
  // collapse to a guess.
  assert.deepEqual(
    asPlain(parseChargeTypes("Fast\nStandard\n")),
    { installed: true, supported: true, known: false, activeType: null, options: ["Fast", "Standard"] }
  );
});

test("parseChargeTypes separates a machine without the attribute from an uninstalled helper", () => {
  // Both leave the row unusable, but only one is worth telling the user to fix.
  const unsupported = asPlain(parseChargeTypes(NO_SUCH_MACHINE + "\n"));
  assert.equal(unsupported.installed, true, "the helper ran, so it is installed");
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.known, false);
  assert.equal(unsupported.activeType, null);
  assert.deepEqual(unsupported.options, []);

  const missing = asPlain(parseChargeTypes(NOT_INSTALLED + "\n"));
  assert.equal(missing.installed, false);
  assert.equal(missing.supported, false);
  assert.equal(missing.known, false);
  assert.equal(missing.activeType, null);
  assert.deepEqual(missing.options, []);
});

test("parseChargeTypes reports an unparseable read as known:false", () => {
  const parsed = asPlain(parseChargeTypes("unknown\n"));
  assert.equal(parsed.installed, true);
  assert.equal(parsed.supported, true, "the attribute is there");
  assert.equal(parsed.known, false, "but its value means nothing to us");
  assert.equal(parsed.activeType, null);
  assert.deepEqual(parsed.options, []);
});

test("parseChargeTypes treats silence as not installed", () => {
  // The helper failed to run at all. Nothing is claimed about the hardware.
  for (const raw of ["", "\n", "   \n\n", null, undefined]) {
    const parsed = asPlain(parseChargeTypes(raw));
    assert.equal(parsed.installed, false, JSON.stringify(raw));
    assert.equal(parsed.supported, false);
    assert.equal(parsed.known, false);
    assert.equal(parsed.activeType, null);
    assert.deepEqual(parsed.options, []);
  }
});

test("isAcceptedValue admits the canonical listed form", () => {
  const options = ["Fast", "Standard", "Long_Life"];
  for (const name of options) {
    assert.equal(isAcceptedValue(name, options), true, `${name} is what the list spells it`);
  }
});

test("isAcceptedValue admits the space variant the kernel also accepts", () => {
  // The kernel takes "Long Life" and "Long_Life" alike and reads the
  // underscore form back, so the space variant is the same choice.
  assert.equal(isAcceptedValue("Long Life", ["Fast", "Standard", "Long_Life"]), true);
  assert.equal(isAcceptedValue("  Long_Life  ", ["Fast", "Standard", "Long_Life"]), true, "trim first");
  assert.equal(isAcceptedValue("Fast\n", ["Fast", "Standard", "Long_Life"]), true, "a trailing newline is a space, then trimmed");
});

test("isAcceptedValue rejects everything that is not in the list", () => {
  // This gates the pkexec call, so anything loose here would be loose on the
  // way to root: a name the battery does not offer is not ours to write.
  const options = ["Fast", "Standard", "Long_Life"];
  const bad = ["", " ", "Bypass", "Trickle", "long_life", true, false, 0, 1, null, undefined, {}];
  for (const value of bad) {
    assert.equal(isAcceptedValue(value, options), false, `${JSON.stringify(value)} must be rejected`);
  }
});

test("isAcceptedValue is strict about which list it checks against", () => {
  assert.equal(isAcceptedValue("Fast", ["Long_Life"]), false, "offered by another battery, not this one");
  assert.equal(isAcceptedValue("Fast", []), false, "no list, nothing is offered");
  assert.equal(isAcceptedValue("Fast", undefined), false);
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
  assert.equal(shouldNotify(1, ["charge-types: refusing to write 'Turbo'"]), true);
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
  assert.equal(shouldNotify(1, ["", "charge-types: no attribute found", ""]), true);
});

test("describe is the parsed list, for the panel's flags", () => {
  // The panel derives its ready/known/active flags from this, so it must
  // agree with parseChargeTypes on every input class.
  for (const raw of [LIST_OK, NO_SUCH_MACHINE + "\n", "unknown\n", NOT_INSTALLED + "\n", ""]) {
    assert.deepEqual(asPlain(describe(raw)), asPlain(parseChargeTypes(raw)), `describe(${JSON.stringify(raw)})`);
  }
});

test("describe reports a working machine with its active type and options", () => {
  assert.deepEqual(
    asPlain(describe(LIST_OK)),
    { installed: true, supported: true, known: true, activeType: "Long_Life", options: ["Fast", "Standard", "Long_Life"] }
  );
});

test("describe treats silence as not installed", () => {
  // The helper failed to run at all. Nothing is claimed about the hardware.
  assert.deepEqual(asPlain(describe("")), { installed: false, supported: false, known: false, activeType: null, options: [] });
});

test("the helper's failure words are the ones parseChargeTypes knows", () => {
  // parseChargeTypes recognises the words by their exact spelling. If
  // bin/charge-types ever changes what `list` prints on failure,
  // the panel would read a working battery as unparseable, and these tests
  // should be the thing that notices.
  const helper = fs.readFileSync(`${__dirname}/../bin/charge-types`, "utf8");
  assert.match(helper, /printf 'unsupported\\n'/, "prints the unsupported word");
  assert.match(helper, /printf 'unknown\\n'/, "prints the unknown word");
});

test("the panel's caption carries the four spec states verbatim", () => {
  // The readiness caption is the only text that says whether a disabled row
  // shows a fact or a guess, so its four wordings are locked to the spec's.
  // (The README-verbatim counterpart of this lock returns once the README is
  // rewritten for charge types.)
  const panel = fs.readFileSync(`${__dirname}/../Panel.qml`, "utf8");

  const at = panel.indexOf("readonly property string chargeTypesDescription");
  assert.notEqual(at, -1, "Panel.qml declares the chargeTypesDescription caption");
  const block = panel.slice(at);
  const strings = [
    ...block.slice(0, block.indexOf("\n  }")).matchAll(/return "([^"]+)"/g),
  ].map((m) => m[1]);

  assert.deepEqual(strings, [
    "Current charge type unknown. Run `sudo ./install.sh` in the plugin directory to enable changes.",
    "No charge-type control on this battery, so the type cannot be changed.",
    "Current charge type unknown: the battery reported a value this plugin does not recognise.",
    "Long Life stops charging early to reduce battery wear.",
  ]);
});

test("the panel builds the CHARGE PROFILE section the spec describes", () => {
  // The section's shape is user-visible: its header, the dropdown's label,
  // and the dropdown type itself are what a user sees, so lock them.
  const panel = fs.readFileSync(`${__dirname}/../Panel.qml`, "utf8");
  assert.match(panel, /PanelSectionHeader \{[^}]*text: "CHARGE PROFILE"/s, "the section header");
  assert.match(panel, /label: "Charge type"/, "the dropdown's label");
  assert.match(panel, /Dropdown \{/, "a qs.Ui.Dropdown, not a Toggle");
  assert.ok(!/Toggle \{/.test(panel), "the old Toggle is gone");
});

// moveRowFocus: the panel's row cursor over the ordered rows below the stats
// (charge row first, profile row second). -1 is the unarmed cursor.
test("moveRowFocus from the unarmed cursor lands on an available row", () => {
  assert.equal(moveRowFocus(-1, 1, [true, true]), 0, "down lands on the first available row");
  assert.equal(moveRowFocus(-1, 1, [false, true]), 1, "skipping the unavailable one");
  assert.equal(moveRowFocus(-1, -1, [true, true]), 1, "up lands on the last available row");
  assert.equal(moveRowFocus(-1, -1, [true, false]), 0);
});

test("moveRowFocus stays unarmed when nothing is available", () => {
  assert.equal(moveRowFocus(-1, 1, [false, false]), -1);
  assert.equal(moveRowFocus(-1, -1, [false, false]), -1);
});

test("moveRowFocus walks between the available rows", () => {
  assert.equal(moveRowFocus(0, 1, [true, true]), 1, "down moves to the profile row");
  assert.equal(moveRowFocus(1, -1, [true, true]), 0, "up returns to the charge row");
});

test("moveRowFocus clamps at both ends rather than wrapping", () => {
  assert.equal(moveRowFocus(1, 1, [true, true]), 1, "past the bottom stays put");
  assert.equal(moveRowFocus(0, -1, [true, true]), 0, "past the top stays put");
});

test("moveRowFocus skips rows that became unavailable", () => {
  assert.equal(moveRowFocus(0, 1, [true, false]), 0, "no available row below, so it stays");
  assert.equal(moveRowFocus(1, -1, [false, true]), 1, "no available row above, so it stays");
  assert.equal(moveRowFocus(0, 1, [false, true]), 1, "the row under the cursor dropped out, the walk continues");
});

test("moveRowFocus ignores a zero delta", () => {
  assert.equal(moveRowFocus(0, 0, [true, true]), 0);
  assert.equal(moveRowFocus(-1, 0, [true, true]), -1);
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
// else the Long Life charge type shows the model-typical ceiling; else the dash.
test("ceilingText shows a real upstream threshold, even with Long Life active", () => {
  // The user set a limit: it is theirs, whatever the charge type is doing.
  assert.equal(ceilingText("80%", "Long_Life"), "80%");
  assert.equal(ceilingText("75-80%", "Fast"), "75-80%");
});

test("ceilingText falls back to the Long Life ceiling when no threshold is set", () => {
  // The tilde is the honest hedge: the conservation ceiling is firmware-defined
  // (60-80%), not something we read back, so we assert the typical value.
  assert.equal(ceilingText(undefined, "Long_Life"), "~80%");
  assert.equal(ceilingText("", "Long_Life"), "~80%");
});

test("ceilingText is a dash for every other charge type", () => {
  // Fast and Standard charge to the top; an unreadable active type claims
  // nothing either - the row says "not measurable", not a guess.
  assert.equal(ceilingText(undefined, "Fast"), "-");
  assert.equal(ceilingText("", "Standard"), "-");
  assert.equal(ceilingText(undefined, null), "-");
  assert.equal(ceilingText("", ""), "-");
});
