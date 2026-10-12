// The panel's shared logic: conservation-mode state, and the battery-health
// rendering.
//
// Conservation mode is the kernel's ideapad_acpi conservation_mode attribute:
// a root-owned sysfs file holding "1" (stop charging early) or "0". The
// helper in bin/ is the only thing that touches it, and all it hands back is
// one word. Everything here is pure and testable on any machine.

// What `status` prints. "not-installed" comes from the panel's own wrapper;
// the rest come from the helper.
var NOT_INSTALLED = "not-installed"
var UNSUPPORTED = "unsupported"
var UNKNOWN = "unknown"

var VALUE_OFF = "0"
var VALUE_ON = "1"

// pkexec's exit code when the auth dialog was dismissed. The one non-zero exit
// that is not a failure.
var DISMISSED = 126

// Whether a write that did not succeed is worth telling the user about. 126 is
// a dismissal, not a fault: nobody typed a password on purpose, so announcing
// it would be scolding someone. Any other non-zero exit is worth a word, because
// the toggle looked like it worked and did not - and nothing is announced without
// stderr text to pass on.
function shouldNotify(exitCode, errors) {
  var code = Number(exitCode)
  if (code === 0) return false
  if (code === DISMISSED) return false

  var lines = Array.isArray(errors) ? errors : []
  return lines.some(function (line) {
    return String(line || "").trim().length > 0
  })
}

// Normalise whatever the helper printed into the single word we reason about.
function statusWord(raw) {
  if (raw === null || raw === undefined) return ""

  var lines = String(raw).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var word = lines[i].trim()
    if (word) return word
  }

  return ""
}

// Read the word for what the mode is doing: true when conservation is on, false
// when off, null when nothing useful was said - not installed, no such machine,
// or an unrecognised value. Null is deliberately not false, because treating an
// unreadable state as "off" would invite a toggle derived from a value nobody read.
function parseState(word) {
  var value = String(word || "").trim()
  if (value === VALUE_ON) return true
  if (value === VALUE_OFF) return false
  return null
}

// Everything the panel needs to know, from one word.
//
// `installed` and `supported` are separate: a machine with no Lenovo attribute
// is not broken, while a helper that was never installed is a setup step worth
// mentioning.
function describe(raw) {
  var word = statusWord(raw)
  var installed = word !== "" && word !== NOT_INSTALLED
  var supported = installed && word !== UNSUPPORTED

  return {
    installed: installed,
    supported: supported,
    active: supported ? parseState(word) : null,
  };
}

// The value that turns conservation mode into `active`.
//
// The opposite of what is asked for, so toggling is nextValue(state). Unknown
// states give null: writing a value derived from a state we could not read would
// be guessing.
function nextValue(active) {
  if (active === true) return VALUE_OFF;
  if (active === false) return VALUE_ON;
  return null;
}

// Whether a value is one this plugin will ever send to the kernel.
//
// Only those two exact strings. This runs before pkexec is invoked, so the
// helper's own check is a second line of defence rather than the only one.
function isAcceptedValue(value) {
  return value === VALUE_OFF || value === VALUE_ON;
}

// Which row the panel's cursor lands on for a vertical move. Ours sits below the
// profile buttons, the panel's one focusable row, and movement alternates between
// the two. `focused` is "the cursor is on our row", `available` keeps an unusable
// row out of the walk, and `hasProfiles` says whether there is a profile row to
// move to. Moving past either end stays put, because wrapping would change a profile.
function moveFocusRow(focused, delta, available, hasProfiles) {
  if (available !== true) return focused === true

  // Down always lands on our row: it is the last thing below the profiles.
  if (delta > 0) return true

  // Up returns to the profiles, and stays put when there are none.
  if (delta < 0) return hasProfiles === true ? false : true

  return focused
}

// Whether the conservation row should claim the cursor when hovered. Only a row
// that could also be activated by keyboard takes the cursor, or hovering an
// unusable row would strand it there with nothing for Return to do.
function hoverClaimsFocus(available) {
  return available === true
}

// The text for the Battery health row, from the combined output of
// `cat .../energy_full .../energy_full_design`: two lines of µWh
// integers, in that order. Only the ratio is used, so units never
// matter. Anything unreadable is the dash, matching the "Charge
// cycles" fallback: the row says "not measurable", not "0%".
function healthText(raw) {
  // The trailing newline in `cat` output splits to an empty token; drop
  // empties before counting, or a healthy battery would read as "—".
  var tokens = String(raw || "").split(/\s+/).filter(function (t) { return t })
  var full = Number(tokens[0])
  var design = Number(tokens[1])
  if (tokens.length !== 2) return "—"
  if (!isFinite(full) || !isFinite(design)) return "—"
  if (full < 0 || design <= 0) return "—"
  return (full / design * 100).toFixed(1) + "%"
}

if (typeof module !== "undefined") {
  module.exports = {
    statusWord: statusWord,
    parseState: parseState,
    describe: describe,
    nextValue: nextValue,
    isAcceptedValue: isAcceptedValue,
    shouldNotify: shouldNotify,
    moveFocusRow: moveFocusRow,
    hoverClaimsFocus: hoverClaimsFocus,
    healthText: healthText,
  };
}
