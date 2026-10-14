// Tests for bin/charge-types, the `charge_types` helper - run with:
//   node --test tests/charge-types.test.cjs
//
// The helper hardcodes its power_supply glob and its installed path, both on
// purpose, so the tests run a copy with those two constants rewritten into a
// temporary sysfs-shaped tree. Under test are the supply resolution, the
// bracket parsing and the list/status contracts, not the literal paths.
//
// The write path needs to look like root, which is what `unshare -r` is for: a
// user namespace where the caller is uid 0. That exercises the real privileged
// branch, including the PATH pin and the read-back, with no root on the host
// and nothing on /sys touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const HELPER = path.join(__dirname, "..", "bin", "charge-types");

// How this file fakes root. Probed once, up front, and the answer kept: without
// it, a host that forbids unprivileged user namespaces hands back *unshare's*
// exit code instead of the helper's, and every asRoot assertion below misreads.
// Ubuntu 24.04 sets kernel.apparmor_restrict_unprivileged_userns=1 and ships no
// AppArmor profile for unshare, so the unshare is refused (LP #2046477).
const ROOT_SIM = (() => {
  const probe = spawnSync("unshare", ["-r", "true"], { encoding: "utf8" });

  if (probe.error) {
    return { ok: false, why: `unshare could not be run (${probe.error.code || probe.error.message})` };
  }
  if (probe.status !== 0) {
    const detail = probe.stderr.trim().replace(/\s*\n\s*/g, "; ") || "no output";
    return { ok: false, why: `\`unshare -r true\` exited ${probe.status}: ${detail}` };
  }
  return { ok: true };
})();

// Build a helper wired to a throwaway /sys/class/power_supply tree and report
// back a runner.
//
// `supplies` maps a supply directory name (BAT0, ADP1, ...) to an object:
//   type:            contents of the supply's `type` file (omit to leave it absent)
//   chargeTypes:     contents of its `charge_types` file (omit to leave it absent)
//   chargeTypesMode: chmod for that file (e.g. 0o000 to make the read fail)
//   chargeTypesFifo: make the attribute three FIFOs (ct_list, ct_write,
//                    ct_confirm) whose other sides the fake kernel (below)
//                    plays, so a write/read-back round trip can be faked: a
//                    plain file cannot keep the brackets the real attribute
//                    re-emits. Three, not one: the helper reads the attribute
//                    twice and writes it once, and two readers on one FIFO
//                    would race over each other's data.
function harness(supplies = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "power-charge-types-"));
  const psDir = path.join(root, "sys", "class", "power_supply");
  const dirs = {};

  for (const [name, s] of Object.entries(supplies)) {
    const dir = path.join(psDir, name);
    fs.mkdirSync(dir, { recursive: true });
    if (s.type !== undefined) fs.writeFileSync(path.join(dir, "type"), s.type);
    if (s.chargeTypes !== undefined) {
      fs.writeFileSync(path.join(dir, "charge_types"), s.chargeTypes);
      if (s.chargeTypesMode !== undefined) fs.chmodSync(path.join(dir, "charge_types"), s.chargeTypesMode);
    }
    if (s.chargeTypesFifo) {
      // Node's fs module has no mkfifo, so ask the utility for one.
      for (const f of ["ct_list", "ct_write", "ct_confirm"]) {
        const r = spawnSync("mkfifo", [path.join(dir, f)]);
        if (r.status !== 0) throw new Error(`mkfifo ${f} failed: ${r.stderr}`);
      }
    }
    dirs[name] = dir;
  }

  // Rewrite the two constants so the copy looks at our tree instead of /sys.
  // Everything else in the script is the code under test.
  let rewritten = fs
    .readFileSync(HELPER, "utf8")
    .replace(/^readonly PACKAGED_PATH=.*$/m, `readonly PACKAGED_PATH=${root}/libexec/io.github.justfortheloveof.power-charge-types/charge-types`)
    .replace(/^readonly SUPPLY_GLOB=.*$/m, `readonly SUPPLY_GLOB='${psDir}/*'`);

  // The FIFO variant points the helper's three attribute touches at the three
  // FIFOs: the resolution read at ct_list, the write at ct_write, the
  // read-back at ct_confirm. The write and read-back lines derive their paths
  // from the (ct_list-valued) ATTR_PATH; the parsing and the comparison are
  // the helper's own code, untouched.
  if (Object.values(supplies).some((s) => s.chargeTypesFifo)) {
    rewritten = rewritten
      .replaceAll("$path/charge_types", "$path/ct_list")
      .replaceAll('>"$ATTR_PATH"', '>"${ATTR_PATH%ct_list}ct_write"')
      .replaceAll('cat -- "$ATTR_PATH"', 'cat -- "${ATTR_PATH%ct_list}ct_confirm"');
  }
  fs.writeFileSync(path.join(root, "helper"), rewritten, { mode: 0o755 });
  const script = path.join(root, "helper");

  const run = (args, { asRoot = false } = {}) => {
    // Fail here, with the remedy, rather than letting unshare's exit code
    // masquerade as the helper's. Not a throw at module scope: the tests needing
    // no root are still worth running, and still passing.
    if (asRoot && !ROOT_SIM.ok) {
      throw new Error(
        `root simulation unavailable, so the helper's privileged branch cannot be ` +
          `exercised: ${ROOT_SIM.why}\n` +
          `This is a broken test environment, not a helper failure.\n` +
          `On Ubuntu 24.04+:\n` +
          `  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
      );
    }

    // The rewritten copy, not HELPER: the real one reads the real /sys.
    // A timeout, so a pairing the fake kernel never completes fails the test
    // in seconds instead of hanging the whole run.
    const res = asRoot
      ? spawnSync("unshare", ["-r", script, ...args], { encoding: "utf8", timeout: 15000 })
      : spawnSync(script, [...args], { encoding: "utf8", timeout: 15000 });
    if (res.error) throw res.error;
    return { code: res.status, out: res.stdout.replace(/\n$/, ""), err: res.stderr.trim() };
  };

  // Play the kernel for a FIFO attribute. The helper touches the attribute
  // three times - a resolution read, the write, a read-back - and a FIFO
  // open() blocks until its peer opens, so this child sequences one open per
  // helper step: serve `currentList` to the resolution read, drain the write
  // (recording it in `logFile`), then serve `readback` to the read-back.
  // The pairings make it deterministic - no sleeps, no races.
  const fakeKernel = (supplyName, currentList, readback, logFile) => {
    const dir = dirs[supplyName];
    const kernelSh = path.join(root, "kernel.sh");
    fs.writeFileSync(
      kernelSh,
      [`#!/bin/bash`, "set -eu",
        // One command per helper touch, on a separate FIFO each, so no two
        // peers ever share a pipe. Each redirect's open() blocks until the
        // helper opens its end, and the helper's touches are strictly
        // ordered, so the pairings are deterministic - no sleeps, no races.
        'printf \'%s\' "$3" > "$1/ct_list"',   // the helper's resolution read
        'cat -- "$1/ct_write" > "$2"',         // the helper's write, drained to the log
        'printf \'%s\' "$4" > "$1/ct_confirm"', // the helper's read-back read
        ""].join("\n"),
      { mode: 0o755 }
    );
    return spawn("bash", [kernelSh, dir, logFile, currentList, readback], { stdio: "ignore" });
  };

  return { run, root, dirs, fakeKernel, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Resolution: which supply does the helper act on, and when is there none.
// ---------------------------------------------------------------------------

test("a machine with no power supplies at all reports unsupported", (t) => {
  const h = harness();
  t.after(h.cleanup);
  // This is what a machine with an empty /sys/class/power_supply gets.
  // Exit 3, not a failure: the panel hides the row.
  const r = h.run(["list"]);
  assert.equal(r.code, 3);
  assert.equal(r.out, "unsupported");
  assert.equal(h.run(["status"]).code, 3);
});

test("non-battery supplies are rejected by the resolution filter", (t) => {
  // Stock mainline puts charge_types on *every* supply, AC adapters included,
  // so file existence is not detection: the filter requires type = Battery.
  const h = harness({
    ADP1: { type: "Mains", chargeTypes: "Fast [Standard]" },
    USBC: { type: "USB", chargeTypes: "Fast [Standard]" },
    "ucsi-source-psy-USBC000:001": { type: "USB" },
  });
  t.after(h.cleanup);
  const r = h.run(["list"]);
  assert.equal(r.code, 3, "Mains/USB supplies must not count as a battery");
  assert.equal(r.out, "unsupported");
});

test("a battery with no charge_types file is rejected", (t) => {
  // The omarchy kernel only creates the attribute for batteries that have one;
  // a battery directory without it offers no control.
  const h = harness({ BAT0: { type: "Battery" } });
  t.after(h.cleanup);
  const r = h.run(["list"]);
  assert.equal(r.code, 3);
  assert.equal(r.out, "unsupported");
});

test("a battery whose charge_types cannot be read is rejected", (t) => {
  // Present but unreadable is "no supply", not "unparseable": the distinction
  // is what keeps an unreadable attribute out of the unknown bucket. Runs
  // unprivileged on purpose - the unreadability is the point.
  const h = harness({ BAT0: { type: "Battery", chargeTypes: "Fast Standard", chargeTypesMode: 0o000 } });
  t.after(h.cleanup);
  const r = h.run(["list"]);
  assert.equal(r.code, 3);
  assert.equal(r.out, "unsupported");
});

test("a battery that reads a list with no bracketed entry is unknown", (t) => {
  // Present and readable, but no active entry: the helper cannot tell the
  // caller what is active, and must not guess. Exit 4, the word "unknown".
  const h = harness({ BAT0: { type: "Battery", chargeTypes: "Fast Standard" } });
  t.after(h.cleanup);
  const r = h.run(["list"]);
  assert.equal(r.code, 4);
  assert.equal(r.out, "unknown");
  assert.equal(h.run(["status"]).code, 4);
});

test("a list with more than one bracketed entry is unknown", (t) => {
  const h = harness({ BAT0: { type: "Battery", chargeTypes: "[Fast] Standard [Long_Life]" } });
  t.after(h.cleanup);
  const r = h.run(["status"]);
  assert.equal(r.code, 4);
  assert.equal(r.out, "unknown");
});

test("the first qualifying battery in lexical glob order wins", (t) => {
  // Dual-battery machines: BAT0 before BAT1, the way the glob expands.
  const h = harness({
    BAT0: { type: "Battery", chargeTypes: "Fast [Standard]" },
    BAT1: { type: "Battery", chargeTypes: "[Fast] Standard" },
  });
  t.after(h.cleanup);
  assert.equal(h.run(["status"]).out, "Standard", "BAT0 must win over BAT1");
});

test("a battery that fails the filter yields to a later one", (t) => {
  // BAT0 exists but has no attribute; BAT1 is the first that qualifies.
  const h = harness({
    BAT0: { type: "Battery" },
    BAT1: { type: "Battery", chargeTypes: "Fast [Long_Life]" },
  });
  t.after(h.cleanup);
  assert.equal(h.run(["status"]).out, "Long_Life");
});

// ---------------------------------------------------------------------------
// list / status: the stdout contract.
// ---------------------------------------------------------------------------

test("list prints one type per line, the active one in brackets", (t) => {
  const h = harness({ BAT0: { type: "Battery", chargeTypes: "Fast Standard [Long_Life]" } });
  t.after(h.cleanup);
  const r = h.run(["list"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "Fast\nStandard\n[Long_Life]");
});

test("list splits the attribute's entries on any whitespace", (t) => {
  // The kernel emits spaces; accept the other separators the attribute could
  // plausibly carry, since word splitting sees them all alike.
  const h = harness({ BAT0: { type: "Battery", chargeTypes: "Fast\tStandard\n[Long_Life]" } });
  t.after(h.cleanup);
  const r = h.run(["list"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "Fast\nStandard\n[Long_Life]");
});

test("status prints the active type name alone, brackets stripped", (t) => {
  for (const [seed, expected] of [
    ["[Fast] Standard Long_Life", "Fast"],
    ["Fast [Standard] Long_Life", "Standard"],
    ["Fast Standard [Long_Life]", "Long_Life"],
  ]) {
    const h = harness({ BAT0: { type: "Battery", chargeTypes: seed } });
    const r = h.run(["status"]);
    assert.equal(r.code, 0, `"${seed}"`);
    assert.equal(r.out, expected);
  }
});

test("a trailing newline in the attribute is tolerated", (t) => {
  const h = harness({ BAT0: { type: "Battery", chargeTypes: "Fast Standard [Long_Life]\n" } });
  t.after(h.cleanup);
  assert.equal(h.run(["status"]).out, "Long_Life");
});

test("list and status take no arguments, and unknown subcommands are refused", (t) => {
  const h = harness({ BAT0: { type: "Battery", chargeTypes: "Fast [Standard]" } });
  t.after(h.cleanup);
  for (const args of [
    ["list", "extra"],
    ["status", "extra"],
    ["set"],
    ["set", "Fast", "Standard"],
    ["set", "Fast", "Standard", "Long_Life"],
    [],
    ["help"],
    ["--help"],
    ["LIST"],
    ["Status"],
    ["SET", "Fast"],
    ["--status"],
    ["status", "--json"],
    ["set", "--", "Fast"],
    [""],
  ]) {
    assert.equal(h.run(args, { asRoot: true }).code, 2, `${JSON.stringify(args)} should be a usage error`);
  }
});

// ---------------------------------------------------------------------------
// set: the only write, root-gated, validated, and confirmed by read-back.
// ---------------------------------------------------------------------------

test("set is refused without root, says what to run, and writes nothing", (t) => {
  const h = harness({ BAT0: { type: "Battery", chargeTypes: "Fast Standard [Long_Life]" } });
  t.after(h.cleanup);
  const attr = path.join(h.dirs.BAT0, "charge_types");
  const r = h.run(["set", "Standard"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /needs root/);
  assert.match(r.err, /pkexec/, "the error should name the command to run");
  assert.equal(fs.readFileSync(attr, "utf8"), "Fast Standard [Long_Life]", "and it must not have written anything");
});

test("set refuses a type not in the list it just read, even as root", (t) => {
  // The entire validation surface after normalization: membership in the
  // battery's own list. Each of these would be a different thing to hand to a
  // root shell if it got through; the old 0/1 vocabulary is dead too.
  const h = harness({ BAT0: { type: "Battery", chargeTypes: "Fast Standard [Long_Life]" } });
  t.after(h.cleanup);
  const attr = path.join(h.dirs.BAT0, "charge_types");
  // Note the deliberately absent near-miss "Long_Life ": the spec trims first,
  // so it normalizes to the listed member and is *valid* - it proceeds to the
  // write and fails the read-back, which is a different test's territory.
  const bad = ["Turbo", "0", "1", "01", "", " ", "long_life", "Standard; rm -rf /", "$(id)", "`id`", "Fast && reboot", "Standard|0"];
  for (const value of bad) {
    const r = h.run(["set", value], { asRoot: true });
    assert.equal(r.code, 2, `set ${JSON.stringify(value)} should be a usage error`);
    assert.equal(fs.readFileSync(attr, "utf8"), "Fast Standard [Long_Life]", `set ${JSON.stringify(value)} must not write`);
  }
});

test("set normalizes spaces to underscores and writes the canonical listed form", (t) => {
  // The kernel accepts both "Long Life" and "Long_Life" on write but reads
  // emit the underscore form, so the dual-variant tolerance is absorbed here:
  // the helper writes exactly the form the list spells it.
  // A fresh harness per value: the fake kernel plays its three open() pairings
  // exactly once, so it cannot serve a second run.
  for (const value of ["Long Life", "  Long Life  "]) {
    const h = harness({ BAT0: { type: "Battery", chargeTypesFifo: true } });
    const log = path.join(h.root, "written");
    const kernel = h.fakeKernel("BAT0", "Fast Standard [Long_Life]\n", "Fast [Long_Life]\n", log);
    t.after(() => {
      kernel.kill();
      h.cleanup();
    });
    const r = h.run(["set", value], { asRoot: true });
    assert.equal(r.code, 0, `set ${JSON.stringify(value)} should succeed`);
    assert.equal(r.out, "Long_Life");
    assert.equal(fs.readFileSync(log, "utf8"), "Long_Life", `the canonical listed form must be what is written for ${JSON.stringify(value)}`);
  }
});

test("set switches the active type and reports the new one", (t) => {
  const h = harness({ BAT0: { type: "Battery", chargeTypesFifo: true } });
  const log = path.join(h.root, "written");
  const kernel = h.fakeKernel("BAT0", "Fast [Standard]\n", "[Standard] Long_Life\n", log);
  t.after(() => {
    kernel.kill();
    h.cleanup();
  });
  const r = h.run(["set", "Standard"], { asRoot: true });
  assert.equal(r.code, 0);
  assert.equal(r.out, "Standard", "stdout is the new active type name, one word");
  assert.equal(fs.readFileSync(log, "utf8"), "Standard");
});

test("a read-back that does not show the written type active is an error", (t) => {
  // The kernel is free to keep the old value active: a write that returned
  // zero is not a switch, and the helper must say so, not celebrate. Long_Life
  // is active, Standard is written, and the read-back still shows Long_Life.
  const h = harness({ BAT0: { type: "Battery", chargeTypesFifo: true } });
  const log = path.join(h.root, "written");
  const kernel = h.fakeKernel("BAT0", "[Long_Life] Standard\n", "[Long_Life] Standard\n", log);
  t.after(() => {
    kernel.kill();
    h.cleanup();
  });
  const r = h.run(["set", "Standard"], { asRoot: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /Standard/);
});

test("a read-back with no bracketed entry is an error, not a success", (t) => {
  // A plain file plays the attribute here: it takes the written value and
  // re-emits it bare, brackets and all. The real attribute always re-emits
  // brackets, so a bracketless read-back is a state the switch did not land
  // in, and it must not be reported as the new active type.
  const h = harness({ BAT0: { type: "Battery", chargeTypes: "Fast Standard [Long_Life]" } });
  t.after(h.cleanup);
  const r = h.run(["set", "Standard"], { asRoot: true });
  assert.equal(r.code, 1);
  assert.equal(r.out, "", "a failed set must not print a success value");
});

test("set with no qualifying battery reports the resolution failure", (t) => {
  let h = harness({});
  t.after(h.cleanup);
  assert.equal(h.run(["set", "Fast"], { asRoot: true }).code, 3);

  h = harness({ ADP1: { type: "Mains" } });
  t.after(h.cleanup);
  assert.equal(h.run(["set", "Fast"], { asRoot: true }).code, 3);

  h = harness({ BAT0: { type: "Battery", chargeTypes: "Fast Standard" } });
  t.after(h.cleanup);
  assert.equal(h.run(["set", "Fast"], { asRoot: true }).code, 4);
});

// ---------------------------------------------------------------------------
// The installed path: the helper, install.sh, uninstall.sh and Panel.qml must
// all agree on where the installed copy lives, or the panel would probe a file
// install.sh never made.
// ---------------------------------------------------------------------------

test("the helper, install.sh, uninstall.sh, Panel.qml, and the polkit rule agree on the installed path", () => {
  const dir = "/usr/local/libexec/io.github.justfortheloveof.power-charge-types";
  const full = `${dir}/charge-types`;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const helper = fs.readFileSync(`${__dirname}/../bin/charge-types`, "utf8");
  const install = fs.readFileSync(`${__dirname}/../install.sh`, "utf8");
  const uninstall = fs.readFileSync(`${__dirname}/../uninstall.sh`, "utf8");
  const panel = fs.readFileSync(`${__dirname}/../Panel.qml`, "utf8");
  const rules = fs.readFileSync(`${__dirname}/../policy/power-charge-types.rules.example`, "utf8");

  assert.match(helper, new RegExp(`^readonly PACKAGED_PATH=${esc(full)}$`, "m"), "the helper names the installed path");
  assert.match(install, new RegExp(`^readonly PACKAGED_DIR=${esc(dir)}$`, "m"), "install.sh names the installed directory");
  assert.match(install, /^readonly PACKAGED_PATH="\$PACKAGED_DIR\/charge-types"$/m, "install.sh installs into it");
  assert.match(uninstall, new RegExp(`^readonly PACKAGED_DIR=${esc(dir)}$`, "m"), "uninstall.sh removes the installed directory");
  assert.match(uninstall, /^readonly PACKAGED_PATH="\$PACKAGED_DIR\/charge-types"$/m, "uninstall.sh removes the helper from it");
  assert.match(panel, new RegExp(`chargeTypesHelper: "${esc(full)}"`), "Panel.qml invokes the installed copy");
  // The rules file spells the path already regex-escaped (slashes and dots
  // backslashed in its own pattern), so the text to match literally *is* that
  // escaped form - escape it once more, and the pattern matches the file.
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  assert.match(rules, new RegExp(`${escRe(escRe(full))} set `), "the polkit rule matches the installed path");
});

// The rules file runs in polkitd's Duktape engine, whose regex dialect is not
// the one Node (V8) implements: Duktape parses `\|` as a *literal* pipe, so an
// "escaped" alternation matches a string no battery will ever report and the
// rule silently grants nothing - the stock policy then prompts on every write.
// Node cannot catch that, so the guard is textual: no backslash-pipe, ever.
test("the polkit rule contains no escaped pipes (Duktape reads \\| as a literal pipe)", () => {
  const rules = fs.readFileSync(`${__dirname}/../policy/power-charge-types.rules.example`, "utf8");
  assert.doesNotMatch(rules, /\\\|/, "no \\| in the rules file: Duktape would turn the alternation into a literal pipe and the rule would match nothing");
});
