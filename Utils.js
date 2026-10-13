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

// The charge type the kernel spells for conservation: it stops charging early,
// at a firmware-defined cap, so the ceiling readout can hedge a typical value.
var LONG_LIFE = "Long_Life"

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

// Which row the panel's cursor lands on for a vertical move. `row` is the
// cursor's current row in display order, or -1 while unarmed; `availableRows`
// says, per row in the same order, which rows the walk may enter, and keeps an
// unusable row out of it. Moving past either end clamps onto the last available
// row in that direction, because wrapping would land on the wrong control.
// An unarmed cursor arms on the first available row in the move direction.

// The first available row at, or in `step`'s direction from, `from` - or -1
// when the walk runs off the end of the row list without finding one. The
// one shape behind every walk moveRowFocus performs: arm, step, and clamp all
// differ only in where they start and which way they go.
function firstAvailable(rows, from, step) {
  var i = Number(from)
  var last = rows.length - 1
  for (; step > 0 ? i <= last : i >= 0; i += step) {
    if (rows[i] === true) return i
  }
  return -1
}

function moveRowFocus(row, delta, availableRows) {
  var rows = Array.isArray(availableRows) ? availableRows : []
  var current = Number(row)
  if (current !== current) current = -1

  // Unarmed: down lands on the first available row, up on the last; with
  // none available the cursor has nowhere to arm, so it stays at -1.
  if (current < 0) {
    if (delta > 0) return firstAvailable(rows, 0, 1)
    if (delta < 0) return firstAvailable(rows, rows.length - 1, -1)
    return -1
  }

  // Armed: walk in the move direction to the next available row.
  if (delta > 0) {
    var next = firstAvailable(rows, current + 1, 1)
    if (next !== -1) return next
  } else if (delta < 0) {
    var prev = firstAvailable(rows, current - 1, -1)
    if (prev !== -1) return prev
  } else {
    return current
  }

  // Nothing in that direction: clamp onto the end available row, staying put
  // when the walk has nowhere left to go.
  if (delta > 0) {
    var end = firstAvailable(rows, rows.length - 1, -1)
    if (end !== -1) return end
  } else {
    var start = firstAvailable(rows, 0, 1)
    if (start !== -1) return start
  }

  return current
}

// Whether the charge row should claim the cursor when hovered. Only a row
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
// not-measurable dash. The tilde is honest: the Long Life ceiling is
// firmware-defined (60-80%), not something we read back.
function ceilingText(threshold, activeType) {
  if (threshold) return String(threshold)
  if (activeType === LONG_LIFE) return "~80%"
  return "-"
}

if (typeof module !== "undefined") {
  module.exports = {
    parseChargeTypes: parseChargeTypes,
    describe: describe,
    isAcceptedValue: isAcceptedValue,
    normalizeChargeType: normalizeChargeType,
    shouldNotify: shouldNotify,
    moveRowFocus: moveRowFocus,
    hoverClaimsFocus: hoverClaimsFocus,
    healthText: healthText,
    ceilingText: ceilingText,
  };
}
