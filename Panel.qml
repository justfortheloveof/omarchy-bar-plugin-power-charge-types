import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.UPower
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model
// ---- charge-types: start ----
import "Utils.js" as Utils
// ---- charge-types: end ----

Panel {
  id: root
  moduleName: "omarchy.power"
  ipcTarget: "omarchy.power"
  // manageIpc: false so this panel can own the single IpcHandler the target
  // permits — needed for the togglePercentage method below.
  manageIpc: false
  property var batteryInfo: ({})
  property var systemInfo: ({})
  property var profiles: []
  property string activeProfile: ""
  property int profileIndex: 0
  property bool cursorActive: false
  // ---- charge-types: start ----
  // The installed helper is the only thing that touches the charge_types
  // attribute. Every flag below starts pessimistic, so a probe that never runs
  // leaves a plainly unusable row rather than a dropdown that looks live.
  readonly property string chargeTypesHelper: "/usr/local/libexec/io.github.justfortheloveof.power-charge-types/charge-types"
  property bool chargeTypesInstalled: false
  property bool chargeTypesSupported: false
  property bool chargeTypesKnown: false
  property bool chargeTypesBusy: false
  // The active type as the attribute read it, "" while unreadable. A string the
  // dropdown and the ceiling readout both consume, not a boolean: the battery's
  // state is a name, and a name is what the write sends back.
  property string chargeTypesActiveType: ""
  // The battery's own listed names, brackets stripped: the write's gate and the
  // dropdown's source. Empty while the list was never read.
  property var chargeTypesOptions: []
  // The same names in the kit's { value, label } option shape: the label is the
  // type with underscores as spaces, so Long_Life reads "Long Life".
  readonly property var chargeTypesOptionList: {
    var out = []
    for (var i = 0; i < chargeTypesOptions.length; i++) {
      var name = chargeTypesOptions[i]
      out.push({ value: name, label: String(name).replace(/_/g, " ") })
    }
    return out
  }
  // Held until the write process exits: whether to say anything depends on an
  // exit code we only learn at the end.
  property var chargeTypesErrors: []
  // The row cursor over the rows below the stats, in display order: -1 none,
  // 0 the profile row, 1 the charge row. An index rather than the old boolean,
  // because the walk now moves *between* the two rows, not just onto ours.
  property int cursorRow: -1
  // The Battery health row's value, from energy_full / energy_full_design.
  // Starts pessimistic: a read that never ran shows the dash, not a stale number.
  property string batteryHealthText: "—"
  // Only a dropdown whose current value we actually read may be opened.
  readonly property bool chargeTypesReady:
    chargeTypesInstalled && chargeTypesSupported && chargeTypesKnown && !chargeTypesBusy
  readonly property string chargeTypesDescription: {
    // A disabled row still renders as an ordinary row, so each not-ready state
    // has to say in text whether what it shows is a fact or a guess. The ready
    // state returns "": the caption's visible guard then hides the line.
    if (!chargeTypesInstalled) return "Current charge type unknown. Run `sudo ./install.sh` in the plugin directory to enable changes."
    if (!chargeTypesSupported) return "No charge-type control on this battery, so the type cannot be changed."
    if (!chargeTypesKnown) return "Current charge type unknown: the battery reported a value this plugin does not recognise."
    return ""
  }
  // ---- charge-types: end ----
  readonly property bool showPercentage: setting("showPercentage", false) === true
  // With the percentage shown the button paints a text block wider than an
  // icon, so the open-panel mark takes the painted width instead of the
  // icon-sized fraction of the slot the fallback assumes.
  readonly property real openPanelIndicatorWidth: showPercentage && !button.vertical ? button.glyphPaintedWidth : 0
  readonly property bool batteryPresent: {
    var device = UPower.displayDevice
    return !!(device && device.isPresent)
  }

  function upowerStates() {
    return {
      Charging: UPowerDeviceState.Charging,
      Discharging: UPowerDeviceState.Discharging,
      FullyCharged: UPowerDeviceState.FullyCharged,
      PendingCharge: UPowerDeviceState.PendingCharge
    }
  }

  function selectProfileByDelta(delta) {
    profileIndex = Model.selectProfileIndex(profileIndex, delta, profiles)
  }

  function activateSelectedProfile() {
    if (profileIndex < 0 || profileIndex >= profiles.length) return
    setProfile(profiles[profileIndex])
  }

  function batteryIcon() {
    var device = UPower.displayDevice
    return Model.batteryIcon(device, root.discharging, upowerStates())
  }

  function modeLabel() {
    var device = UPower.displayDevice
    return Model.modeLabel(device, root.discharging, upowerStates())
  }

  function profileIcon(name) {
    return Model.profileIcon(name)
  }

  // ---- charge-types: start ----
  // Fold whatever the helper printed into the flags. Anything unreadable leaves
  // chargeTypesKnown false, which keeps the row disabled rather than showing a
  // type nobody read.
  function ingestChargeTypesStatus(raw) {
    var state = Utils.describe(raw)
    root.chargeTypesInstalled = state.installed
    root.chargeTypesSupported = state.supported
    root.chargeTypesKnown = state.known
    root.chargeTypesActiveType = state.activeType === null ? "" : state.activeType
    root.chargeTypesOptions = state.options
  }

  function refreshChargeTypes() {
    if (!chargeTypesProbe.running) chargeTypesProbe.running = true
  }

  // The value asked for, or "" if nothing was. The write is asynchronous: pkexec
  // prompts, so the state on screen only changes once chargeTypesAction reports
  // back.
  function requestSetChargeType(value) {
    if (!root.chargeTypesReady) return ""

    if (!Utils.isAcceptedValue(value, root.chargeTypesOptions)) return ""

    root.chargeTypesBusy = true
    chargeTypesAction.command = ["pkexec", root.chargeTypesHelper, "set", value]
    chargeTypesAction.running = true
    return value
  }

  // Vertical navigation: walk between the profile row and the charge row,
  // skipping whichever is unavailable. dx never reaches here, so left/right
  // stay on profiles.
  function moveRowFocus(delta) {
    cursorRow = Utils.moveRowFocus(
      cursorRow,
      delta,
      [root.profiles.length > 0, root.chargeTypesReady]
    )
  }

  // Return/Space on whichever row the cursor is on; the key dispatcher calls
  // this rather than activateSelectedProfile. Row 0 acts on the selected
  // profile; row 1 opens the dropdown (whose popup then owns the keys until
  // it closes); an armed cursor on no row does nothing.
  function activateCursor() {
    if (!root.cursorActive) return
    if (root.cursorRow === 0) root.activateSelectedProfile()
    else if (root.cursorRow === 1) root.chargeTypesDropdown.open()
  }
  // ---- charge-types: end ----

  readonly property bool fullyCharged: {
    var device = UPower.displayDevice
    return device && device.isPresent && device.state === UPowerDeviceState.FullyCharged && !root.chargeThresholdActive
  }
  readonly property bool discharging: {
    var device = UPower.displayDevice
    return !!(device && device.isPresent && UPower.onBattery)
  }
  readonly property bool chargeThresholdActive: {
    var device = UPower.displayDevice
    return Model.chargeThresholdActive(device, root.discharging, upowerStates())
  }
  readonly property bool batteryFull: fullyCharged || (!root.discharging && batteryFraction >= 1)
  readonly property bool batteryFlowIdle: batteryFull || chargeThresholdActive

  // 0..1 charge level, used by the visual progress bar.
  readonly property real batteryFraction: {
    var d = UPower.displayDevice
    return Model.batteryFraction(d)
  }

  readonly property bool charging: {
    var d = UPower.displayDevice
    return d && d.isPresent && !UPower.onBattery && !root.batteryFlowIdle
  }

  readonly property color batteryFillColor: {
    return root.bar ? root.bar.foreground : Commons.Color.foreground
  }

  // Cute agent-flavored phrases shown in the hero status line, rotated on a
  // timer so the panel feels alive when current is flowing (either direction).
  readonly property var chargingPhrases: [
    "Pumping power",
    "Injecting electrons",
    "Pouring juice",
    "Amassing watts",
    "Hoarding joules",
    "Sucking volts",
    "Topping reserves",
    "Soaking amps",
    "Inhaling kilowatts"
  ]
  readonly property var onBatteryPhrases: [
    "Slurping power",
    "Spending joules",
    "Draining watts",
    "Burning electrons",
    "Sipping juice",
    "Spending coulombs",
    "Bleeding amps",
    "Guzzling volts",
    "Munching reserves"
  ]
  property int phraseIndex: 0

  // Whichever list is "active" given the current power state.
  readonly property var activePhrases: {
    if (fullyCharged) return []
    if (charging) return chargingPhrases
    if (discharging) return onBatteryPhrases
    return []
  }
  readonly property bool rotatingPhrases: activePhrases.length > 0

  readonly property string heroStatusText: {
    if (fullyCharged) return "Fully charged"
    if (rotatingPhrases) return activePhrases[phraseIndex % activePhrases.length]
    return modeLabel()
  }

  function refresh() {
    if (!batteryPresent) return

    if (!batteryProc.running) batteryProc.running = true
    if (!profilesProc.running) profilesProc.running = true
    if (!systemProc.running) systemProc.running = true
    // ---- charge-types: start ----
    root.refreshChargeTypes()
    // ---- charge-types: end ----
  } // charge-types

  // ---- charge-types: start ----
  // The health read is one-shot per panel session: the value barely moves,
  // so a transient empty payload renders as the dash it already is, and no
  // keep-last-known-good guard is needed.
  function updateHealth(raw) {
    batteryHealthText = Utils.healthText(raw)
  }
  // ---- charge-types: end ----

  function updateKeyValue(raw, targetName) {
    var next = Model.parseKeyValue(raw)
    // Keep last known good data if a refresh briefly returns nothing — happens
    // around AC plug/unplug events. Avoids the section collapsing mid-transition.
    if (Object.keys(next).length === 0) return
    if (targetName === "battery") batteryInfo = next
    else systemInfo = next
  }

  function updateProfiles(raw) {
    var parsed = Model.parseProfiles(raw, profileIndex)
    // Same guard as battery: preserve the last known profile list across
    // transient empty payloads so the buttons don't blink out.
    if (parsed.profiles.length === 0) return
    profiles = parsed.profiles
    activeProfile = parsed.activeProfile
    profileIndex = parsed.profileIndex
    if (opened && !cursorActive) {
      var idx = profiles.indexOf(activeProfile)
      if (idx >= 0) profileIndex = idx
    }
  }

  function setProfile(profile) {
    if (!profile || actionProc.running) return
    actionProc.command = ["omarchy-powerprofiles-set", root.discharging ? "battery" : "ac", profile]
    actionProc.running = true
  }

  function togglePercentage() {
    root.settings = Object.assign({}, root.settings, { showPercentage: !root.showPercentage })
    if (root.bar && root.bar.shell) root.bar.shell.updateEntryInline(root.moduleName, root.settings)
  }

  IpcHandler {
    target: "omarchy.power"

    function open() { root.open() }
    function close() { root.close() }
    function show() { root.open() }
    function hide() { root.close() }
    function toggle() { root.toggle() }
    function togglePercentage() { root.togglePercentage() }
    // ---- charge-types: start ----
    // The value asked for, not the result: pkexec prompts, so the write has not
    // happened yet when this replies.
    function setChargeType(type): string { return root.requestSetChargeType(type) }
    function chargeTypeStatus(): string {
      if (!root.chargeTypesKnown) return "unknown"
      return root.chargeTypesActiveType
    }
    // ---- charge-types: end ----
  }

  onOpenedChanged: {
    if (opened) {
      if (!batteryPresent) {
        close()
        return
      }

      refresh()
      var idx = profiles.indexOf(activeProfile)
      profileIndex = idx >= 0 ? idx : 0
      cursorActive = false
      // ---- charge-types: start ----
      // Reset with cursorActive: a row focused in the last session would
      // otherwise light on the first key press after reopening.
      cursorRow = -1
      // One-shot: read the health files once per panel session.
      if (!healthProc.running) healthProc.running = true
      // ---- charge-types: end ----
    }
  }

  onBatteryPresentChanged: if (!batteryPresent) close()

  visible: batteryPresent
  implicitWidth: batteryPresent ? button.implicitWidth : 0
  implicitHeight: batteryPresent ? button.implicitHeight : 0

  Process {
    id: batteryProc
    command: ["omarchy-battery-status", "--shell"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.updateKeyValue(text, "battery") }
  }

  Process {
    id: profilesProc
    command: ["omarchy-powerprofiles-list", "--active-state"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.updateProfiles(text) }
  }

  Process {
    id: systemProc
    command: ["omarchy-system-stats"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.updateKeyValue(text, "system") }
  }

  // ---- charge-types: start ----
  // Reading is unprivileged. Walk batteries in shell-glob order, leaving
  // unusable pairs blank for Utils.healthText() to skip. The paths are fixed,
  // so no caller-controlled text reaches the shell.
  Process {
    id: healthProc
    command: ["sh", "-c",
      "for supply in /sys/class/power_supply/*; do " +
      "type=$(cat \"$supply/type\" 2>/dev/null) || continue; " +
      "[ \"$type\" = Battery ] || continue; " +
      "full=$(cat \"$supply/energy_full\" 2>/dev/null) || full=; " +
      "design=$(cat \"$supply/energy_full_design\" 2>/dev/null) || design=; " +
      "printf '%s %s\\n' \"$full\" \"$design\"; " +
      "done"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.updateHealth(text) }
  }
  // ---- charge-types: end ----

  Process {
    id: actionProc
    onExited: root.refresh()
  }

  // ---- charge-types: start ----
  // Reading needs no privilege, so this never prompts. The helper's path is
  // passed as an argument, and the string itself is fixed, so nothing the
  // caller controls reaches the shell.
  Process {
    id: chargeTypesProbe
    command: ["sh", "-c", "if [ -x \"$0\" ]; then exec \"$0\" list; else echo not-installed; fi", root.chargeTypesHelper]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.ingestChargeTypesStatus(text)
        // The kit's selectCurrent() assigns the dropdown's value, tearing the
        // binding it made to chargeTypesActiveType: from the first selection
        // on, a re-probed change (a dismissed write, a switch outside the
        // panel) no longer moves the displayed value. Re-sync it on every
        // probe so the display tracks the attribute again; the initial binding
        // still covers probes before any selection.
        root.chargeTypesDropdown.value = root.chargeTypesActiveType
      }
    }
  }

  Process {
    id: chargeTypesAction
    // The helper's stdout is the new active type, one bare word - not its
    // `list` output, so it must not go through the list parser: a word with
    // no bracket parses as known:false, and on every write the caption would
    // flicker to the unrecognised-value message and the dropdown disable
    // until the re-probe lands. Capture it and throw it away; the re-probe
    // is the source of truth.
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {} }
    // Collected rather than announced on sight: whether to speak at all depends
    // on the exit code, and Utils.shouldNotify decides that.
    stderr: SplitParser {
      onRead: function(line) { root.chargeTypesErrors.push(String(line)) }
    }
    onExited: function(exitCode) {
      var why = root.chargeTypesErrors
      root.chargeTypesErrors = []

      if (Utils.shouldNotify(exitCode, why)) {
        Quickshell.execDetached([
          "omarchy-notification-send",
          "-g", "󰂅",
          "Charge type",
          why.filter(function(line) { return line.trim() !== "" }).join("\n")
        ])
      }

      // Re-read rather than trust the write: the helper verifies it, but the
      // state on screen should come from the attribute, not from what we asked.
      root.chargeTypesBusy = false
      root.refreshChargeTypes()
    }
  }
  // ---- charge-types: end ----

  Timer { interval: 5000; running: root.opened; repeat: true; onTriggered: root.refresh() }

  // Rotate the status phrase while the panel is open and we're in a
  // rotating state (charging or on battery). The text swap is wrapped in a
  // fade so the changeover reads as one organism rather than a hard cut.
  Timer {
    id: phraseTimer
    interval: 2800
    running: root.opened && root.rotatingPhrases
    repeat: true
    triggeredOnStart: false
    onTriggered: phraseSwap.restart()
  }

  SequentialAnimation {
    id: phraseSwap
    PropertyAnimation {
      target: heroStatus; property: "opacity"
      to: 0.0; duration: 180; easing.type: Easing.OutQuad
    }
    ScriptAction {
      script: {
        var n = root.activePhrases.length
        if (n > 0) root.phraseIndex = (root.phraseIndex + 1) % n
      }
    }
    PropertyAnimation {
      target: heroStatus; property: "opacity"
      to: 1.0; duration: 260; easing.type: Easing.InQuad
    }
  }

  // If we leave a rotating state mid-swap, halt the animation and snap back
  // to full opacity so "FULLY CHARGED" is legible immediately rather than
  // appearing dimmed.
  Connections {
    target: root
    function onRotatingPhrasesChanged() {
      if (!root.rotatingPhrases) {
        phraseSwap.stop()
        heroStatus.opacity = 1.0
      }
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.showPercentage && !vertical
      ? Math.round(root.batteryFraction * 100) + "% " + root.batteryIcon()
      : root.batteryIcon()
    slotSize: Style.bar.iconSlot * (root.showPercentage && !vertical ? 2 : 1)
    tooltipText: ""
    onPressed: function(b) {
      if (!root.batteryPresent) return
      if (b === Qt.RightButton) root.togglePercentage()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened && root.batteryPresent
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Suspends the panel's dispatcher while the dropdown's popup owns the keys. // charge-types
      blocked: chargeTypesDropdown.popupOpen // charge-types
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        if (dx !== 0) root.selectProfileByDelta(dx)
        else if (dy !== 0) root.moveRowFocus(dy) // charge-types
      }
      onActivateRequested: root.activateCursor() // charge-types
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        // ---------- Hero: battery icon · title/status · percentage ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight, heroPercent.implicitHeight)

          Text {
            id: heroIcon
            textFormat: Text.PlainText
            text: root.batteryIcon()
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter

            Behavior on color { ColorAnimation { duration: 200 } }
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: heroPercent.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "Battery"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              id: heroStatus
              textFormat: Text.PlainText
              text: root.heroStatusText.toUpperCase()
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }

          Text {
            id: heroPercent
            textFormat: Text.PlainText
            text: root.batteryInfo.percentage || "—"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.displayLarge
            font.bold: true
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter

            Behavior on color { ColorAnimation { duration: 200 } }
          }
        }

        // ---------- Battery progress bar ----------
        Item {
          width: parent.width
          implicitHeight: Style.space(8)

          Rectangle {
            id: barTrack
            anchors.fill: parent
            radius: height / 2
            color: Qt.rgba(root.bar.foreground.r, root.bar.foreground.g, root.bar.foreground.b, 0.12)
          }

          Rectangle {
            id: barFill
            anchors.left: barTrack.left
            anchors.verticalCenter: barTrack.verticalCenter
            height: barTrack.height
            radius: barTrack.radius
            color: root.batteryFillColor
            width: Math.max(barTrack.height, barTrack.width * root.batteryFraction)

            Behavior on width { NumberAnimation { duration: 320; easing.type: Easing.OutCubic } }
            Behavior on color { ColorAnimation { duration: 220 } }

            // Subtle pulse while charging — visible signal that energy is flowing in.
            SequentialAnimation on opacity {
              running: root.charging && !root.fullyCharged && root.opened
              loops: Animation.Infinite
              alwaysRunToEnd: true
              NumberAnimation { from: 1.0; to: 0.55; duration: 950; easing.type: Easing.InOutSine }
              NumberAnimation { from: 0.55; to: 1.0; duration: 950; easing.type: Easing.InOutSine }
            }
          }
        }

        // ---------- Stats ----------
        // Visibility is intentionally only gated by "we've ever loaded data" so
        // the section never collapses mid-transition. fullyCharged is *not* part
        // of the condition: UPower briefly reports FullyCharged on plug-in when
        // the battery sits above the charge-control start threshold, and we
        // refuse to flicker the whole panel for that ~1s window.
        Row {
          visible: root.batteryInfo.percentage !== undefined
          width: parent.width
          spacing: Style.space(20)

          Column {
            width: (parent.width - parent.spacing) / 2
            spacing: Style.spacing.labelGap
            InfoPair { label: "Battery health"; value: root.batteryHealthText } // charge-types
            InfoPair { label: "Charge cycles"; value: root.batteryInfo.cycles || "—" }
          }

          Column {
            width: (parent.width - parent.spacing) / 2
            spacing: Style.spacing.labelGap
            InfoPair {
              label: root.chargeThresholdActive ? "Charge limit" : (root.discharging ? "Time left" : "Time to full")
              // ---- charge-types: start ----
              value: root.chargeThresholdActive
                ? Utils.ceilingText(root.batteryInfo.threshold, root.chargeTypesActiveType)
                : (root.batteryFlowIdle ? "-" : (root.batteryInfo.time || "—"))
              // ---- charge-types: end ----
            }
            InfoPair {
              label: root.chargeThresholdActive ? "Battery state" : (root.discharging ? "Discharging" : "Charging")
              value: root.chargeThresholdActive ? "Holding" : (root.batteryFull ? "-" : (root.batteryInfo.rate || ""))
            }
          }
        }

        // ---------- Power profile picker ----------
        PanelSeparator {
          foreground: root.bar.foreground
        }

        Column {
          width: parent.width
          spacing: Style.space(10)

          PanelSectionHeader {
            text: "POWER PROFILE"
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
          }

          Row {
            id: profileRow
            width: parent.width
            spacing: Style.space(6)

            readonly property real cellWidth: root.profiles.length > 0
              ? (width - spacing * (root.profiles.length - 1)) / root.profiles.length
              : 0

            Repeater {
              model: root.profiles
              Button {
                required property var modelData
                required property int index
                width: profileRow.cellWidth
                iconText: root.profileIcon(String(modelData))
                iconSize: Style.font.title
                text: String(modelData).charAt(0).toUpperCase() + String(modelData).slice(1)
                fontSize: Style.font.bodySmall
                foreground: root.bar.foreground
                fontFamily: root.bar.fontFamily
                horizontalPadding: Style.spacing.controlPaddingX
                verticalPadding: Style.spacing.controlPaddingY + Style.space(2)
                bordered: true
                active: root.activeProfile === modelData
                hasCursor: root.cursorActive && root.cursorRow === 0 && root.profileIndex === index // charge-types
                onClicked: root.setProfile(modelData)
                onHovered: function(h) {
                  if (h) {
                    root.cursorActive = true
                    root.profileIndex = index
                    root.cursorRow = 0 // charge-types
                  }
                }
              }
            }
          }

        }

        // ---- charge-types: start ----
        // ---------- Charge profile picker ----------
        PanelSeparator {
          foreground: root.bar.foreground
        } // charge-types

        Column {
          width: parent.width
          spacing: Style.space(10)

          PanelSectionHeader {
            text: "CHARGE PROFILE"
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
          }

          Dropdown {
            id: chargeTypesDropdown
            width: parent.width
            // No field label: the section header above names this, and a
            // second "Charge type" line under it was just noise.
            label: ""
            value: root.chargeTypesActiveType
            options: root.chargeTypesOptionList
            enabled: root.chargeTypesReady
            foreground: root.bar.foreground
            accent: Color.accent
            fontFamily: root.bar.fontFamily
            // Same cursor flag the profile Buttons use, which is all the
            // highlight needed: Dropdown's _hot is
            // hasCursor || mouse hover, same as Button's.
            hasCursor: root.cursorActive && root.cursorRow === 1
            onHovered: function(h) {
              if (!h || !Utils.hoverClaimsFocus(root.chargeTypesReady)) return
              root.cursorActive = true
              root.cursorRow = 1
            }
            // The popup's selection is the write request; the pkexec round-trip
            // and the re-probe happen in requestSetChargeType.
            onChanged: function(value) { root.requestSetChargeType(value) }
            // On close the panel's keyCatcher resumes; per the spec the cursor
            // is back on the charge row, so restore it: a hover during the
            // open popup, or a row the cursor sat on, would otherwise strand
            // it. Unready means no row to land on, so it stays unarmed.
            onPopupOpenChanged: if (!chargeTypesDropdown.popupOpen)
              root.cursorRow = root.chargeTypesReady ? 1 : -1
          }

          Text {
            textFormat: Text.PlainText
            visible: root.chargeTypesDescription !== ""
            text: root.chargeTypesDescription
            color: Qt.darker(root.bar.foreground, 1.5)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
            width: parent.width
          }
        } // charge-types
        // ---- charge-types: end ----
      }
    }
  }

  component InfoPair: Row {
    property string label: ""
    property string value: ""

    width: parent.width
    spacing: Style.space(8)

    InfoLabel { text: label }
    Item { width: Math.max(0, parent.width - parent.children[0].implicitWidth - parent.children[2].implicitWidth - parent.spacing * 2); height: 1 }
    InfoValue { text: value }
  }

  component InfoLabel: Text {
    textFormat: Text.PlainText
    color: root.bar.foreground
    opacity: 0.6
    font.family: root.bar.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  component InfoValue: Text {
    textFormat: Text.PlainText
    color: root.bar.foreground
    font.family: root.bar.fontFamily
    font.pixelSize: Style.font.bodySmall
  }
}
