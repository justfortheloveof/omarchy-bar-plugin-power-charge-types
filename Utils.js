// The panel's shared logic: charge-type state, and the battery-health
// rendering.
//
// A charge type is the battery's active charging behaviour, one name from the
// power-supply class `charge_types` attribute - a root-owned sysfs file the
// helper in bin/ is the only thing that touches. The helper hands back its
// `list` output: one type per line, the active one in [brackets], or one of
// the failure words below. Everything here is pure and testable on any
// machine.

// What `list` prints on failure. "not-installed" comes from the panel's own
// wrapper, the other two from the helper.
var NOT_INSTALLED = "not-installed"
var UNSUPPORTED = "unsupported"
var UNKNOWN = "unknown"

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

// Everything the panel needs to know, from the helper's `list` output.
//
// The three flags step down a ladder of confidence: `installed` is false for
// empty output or the wrapper's "not-installed" (a helper that was never
// installed is a setup step worth mentioning); `supported` is false for
// "unsupported" (a machine without the attribute is not broken); `known` is
// false for "unknown", or for a list that names no active entry. Unreadable
// states give a null `activeType`, deliberately not a guess: acting on a type
// nobody read would be inventing hardware.
//
// `options` is the listed names with brackets stripped, in list order; the
// bracketed entry is the active type.
function parseChargeTypes(raw) {
  var text = String(raw === null || raw === undefined ? "" : raw).trim()

  if (text === "" || text === NOT_INSTALLED) {
    return { installed: false, supported: false, known: false, activeType: null, options: [] }
  }
  if (text === UNSUPPORTED) {
    return { installed: true, supported: false, known: false, activeType: null, options: [] }
  }
  if (text === UNKNOWN) {
    return { installed: true, supported: true, known: false, activeType: null, options: [] }
  }

  // The list: one type per line from the helper, so split on any whitespace
  // and drop the empties. The kernel spells the active entry [bracketed];
  // brackets are stripped for the options, and the bracketed one is the
  // active type. A list with no bracket at all is unreadable, not "none".
  var entries = text.split(/\s+/).filter(function (entry) { return entry })
  var options = []
  var activeType = null
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i].replace(/^\[/, "").replace(/\]$/, "")
    options.push(name)
    if (entries[i] !== name) activeType = name
  }

  return {
    installed: true,
    supported: true,
    known: activeType !== null,
    activeType: activeType,
    options: options,
  };
}

// The panel-facing form of the same parse: the flags the row and the ceiling
// readout reason about, re-derived from parseChargeTypes so the two can never
// disagree.
function describe(raw) {
  return parseChargeTypes(raw)
}

// Whether a value is one this plugin will ever send to the kernel.
//
// Membership in the battery's own list, with the space/underscore duality the
// kernel accepts collapsed: "Long Life" and "Long_Life" are the same choice,
// so both are checked against the listed names the same way. This runs before
// pkexec is invoked, so the helper's own check is a second line of defence
// rather than the only one.
function isAcceptedValue(value, options) {
  var wanted = normalizeChargeType(value)
  if (wanted === "") return false

  var list = Array.isArray(options) ? options : []
  for (var i = 0; i < list.length; i++) {
    if (normalizeChargeType(list[i]) === wanted) return true
  }
  return false
}

// The one spelling a charge type compares as: whitespace becomes underscores
// and the edges are trimmed, mirroring the helper's write-side normalisation
// so the two sides of the pkexec boundary agree.
function normalizeChargeType(value) {
  var text = String(value === null || value === undefined ? "" : value)
  text = text.replace(/[\s]/g, "_")
  while (text.charAt(0) === "_") text = text.slice(1)
  while (text.charAt(text.length - 1) === "_") text = text.slice(0, -1)
  return text
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

// The "Charge limit" row's value. A real upstream threshold wins: the user
// set a limit, it is theirs, whatever the charge type is doing. Else the
// Long Life charge type shows the model-typical ceiling; else the
// not-measurable dash. The tilde is honest: the conservation ceiling is
// firmware-defined (60-80%), not something we read back.
function ceilingText(threshold, activeType) {
  if (threshold) return String(threshold)
  if (activeType === "Long_Life") return "~80%"
  return "-"
}

if (typeof module !== "undefined") {
  module.exports = {
    parseChargeTypes: parseChargeTypes,
    describe: describe,
    isAcceptedValue: isAcceptedValue,
    normalizeChargeType: normalizeChargeType,
    shouldNotify: shouldNotify,
    moveFocusRow: moveFocusRow,
    hoverClaimsFocus: hoverClaimsFocus,
    healthText: healthText,
    ceilingText: ceilingText,
  };
}
