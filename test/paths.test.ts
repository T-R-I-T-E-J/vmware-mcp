import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The config module caches, so the environment must be set before it loads.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vmroot-"));
const ISOS = fs.mkdtempSync(path.join(os.tmpdir(), "isos-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "work-"));
const SHARED = fs.mkdtempSync(path.join(os.tmpdir(), "shared-"));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
process.env.VM_ROOT = ROOT;
process.env.ISO_LIBRARY = ISOS;
process.env.VMWARE_MCP_WORK_DIR = WORK;
process.env.HOST_SHARED_DIR = SHARED;
process.env.VMWARE_DIR ??= "C:\\Program Files (x86)\\VMware\\VMware Workstation";

const { assertVmPathAllowed, assertHostPathAllowed, assertIsoAllowed, PathNotAllowedError } =
  await import("../src/paths.js");

before(() => {
  fs.mkdirSync(path.join(ROOT, "vm1"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "vm1", "vm1.vmx"), 'displayName = "vm1"\n');
  fs.writeFileSync(path.join(ISOS, "x.iso"), "iso");
  fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "secret");
});
after(() => {
  for (const d of [ROOT, ISOS, WORK, SHARED, OUTSIDE]) fs.rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------- VM paths

test("a VM inside VM_ROOT is allowed", () => {
  assert.ok(assertVmPathAllowed(path.join(ROOT, "vm1", "vm1.vmx")));
});

test("a path outside VM_ROOT is refused", () => {
  assert.throws(() => assertVmPathAllowed(path.join(OUTSIDE, "evil.vmx")), PathNotAllowedError);
});

test("`..` cannot climb out of VM_ROOT", () => {
  assert.throws(
    () => assertVmPathAllowed(path.join(ROOT, "vm1", "..", "..", "escape.vmx")),
    PathNotAllowedError,
  );
});

test("a sibling directory sharing a prefix is not treated as inside", () => {
  // "…/vmroot-x-other" must not pass just because it starts with "…/vmroot-x".
  assert.throws(() => assertVmPathAllowed(`${ROOT}-other${path.sep}vm.vmx`), PathNotAllowedError);
});

test("an empty path is refused", () => {
  assert.throws(() => assertVmPathAllowed("   "), PathNotAllowedError);
});

// ---------------------------------------------------------------- ISO paths

test("ISOs must come from the library", () => {
  assert.ok(assertIsoAllowed(path.join(ISOS, "x.iso")));
  assert.throws(() => assertIsoAllowed(path.join(OUTSIDE, "x.iso")), PathNotAllowedError);
});

// ---------------------------------------------------------------- host paths (#20)

test("host writes are refused outside the allowed roots", () => {
  // The bug this guards: guest_copy_from could overwrite any file on the host.
  assert.throws(
    () => assertHostPathAllowed(path.join(OUTSIDE, "overwrite-me.txt"), "write"),
    PathNotAllowedError,
  );
});

test("host reads are refused outside the allowed roots", () => {
  // The other half: guest_copy_to could lift ~/.ssh/id_rsa into a guest.
  assert.throws(() => assertHostPathAllowed(path.join(OUTSIDE, "secret.txt"), "read"), PathNotAllowedError);
});

test("the work directory, VM_ROOT and HOST_SHARED_DIR are allowed both ways", () => {
  for (const dir of [WORK, ROOT, SHARED]) {
    assert.ok(assertHostPathAllowed(path.join(dir, "f.txt"), "read"), `read ${dir}`);
    assert.ok(assertHostPathAllowed(path.join(dir, "f.txt"), "write"), `write ${dir}`);
  }
});

test("the ISO library is readable but not writable", () => {
  assert.ok(assertHostPathAllowed(path.join(ISOS, "x.iso"), "read"));
  assert.throws(() => assertHostPathAllowed(path.join(ISOS, "new.iso"), "write"), PathNotAllowedError);
});

test("the refusal explains how to allow the path", () => {
  try {
    assertHostPathAllowed(path.join(OUTSIDE, "f.txt"), "write");
    assert.fail("should have thrown");
  } catch (e) {
    assert.match((e as Error).message, /HOST_SHARED_DIR/);
    assert.match((e as Error).message, /VMWARE_MCP_ALLOW_ANY_HOST_PATH/);
  }
});

test("the escape hatch disables the gate", async () => {
  process.env.VMWARE_MCP_ALLOW_ANY_HOST_PATH = "1";
  try {
    assert.ok(assertHostPathAllowed(path.join(OUTSIDE, "f.txt"), "write"));
  } finally {
    delete process.env.VMWARE_MCP_ALLOW_ANY_HOST_PATH;
  }
});
