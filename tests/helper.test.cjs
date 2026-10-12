// Tests for bin/lenovo-power-conservation, now the `charge_types` helper -
// run with:
//   node --test tests/helper.test.cjs
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

const HELPER = path.join(__dirname, "..", "bin", "lenovo-power-conservation");

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
//   chargeTypesFifo: make `charge_types` a FIFO, whose read side the fake
//                    kernel (below) plays, so a write/read-back round trip can
//                    be faked: a plain file cannot keep the brackets the real
//                    attribute re-emits.
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
    if (s.chargeTypesFifo) fs.mkfifo(path.join(dir, "charge_types"));
    dirs[name] = dir;
  }

  // Rewrite the two constants so the copy looks at our tree instead of /sys.
  // Everything else in the script is the code under test.
  const script = path.join(root, "helper");
  const rewritten = fs
    .readFileSync(HELPER, "utf8")
    .replace(/^readonly PACKAGED_PATH=.*$/m, `readonly PACKAGED_PATH=${root}/libexec/lenovo-power/conservation`)
    .replace(/^readonly SUPPLY_GLOB=.*$/m, `readonly SUPPLY_GLOB='${psDir}/*'`);
  fs.writeFileSync(script, rewritten, { mode: 0o755 });

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
    const res = asRoot
      ? spawnSync("unshare", ["-r", script, ...args], { encoding: "utf8" })
      : spawnSync(script, [...args], { encoding: "utf8" });
    if (res.error) throw res.error;
    return { code: res.status, out: res.stdout.replace(/\n$/, ""), err: res.stderr.trim() };
  };

  // Play the kernel for a FIFO attribute: pair with the helper's write-open,
  // record what it wrote, then serve `readback` to the helper's read-back.
  // The open() pairings make this deterministic - no sleeps, no races.
  const fakeKernel = (supplyName, readback, logFile) => {
    const fifo = path.join(dirs[supplyName], "charge_types");
    const prog = [
      "const fs = require('node:fs');",
      `const f = ${JSON.stringify(fifo)};`,
      "let fd = fs.openSync(f, 'r');", // pairs with the helper's write-open
      "const written = fs.readFileSync(fd);",
      "fs.closeSync(fd);",
      `fs.writeFileSync(${JSON.stringify(logFile)}, written);`,
      "fd = fs.openSync(f, 'w');", // pairs with the helper's read-back open
      `fs.writeSync(fd, ${JSON.stringify(readback)});`,
      "fs.closeSync(fd);",
    ].join("\n");
    return spawn(process.execPath, ["-e", prog], { stdio: "ignore" });
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
    [],
    ["help"],
    ["--help"],
    ["LIST"],
    ["Status"],
    ["--status"],
    ["status", "--json"],
    [""],
  ]) {
    assert.equal(h.run(args).code, 2, `${JSON.stringify(args)} should be a usage error`);
  }
});
