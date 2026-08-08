import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { assertVmPathAllowed, assertVmxExists, assertIsoAllowed, resolveVmxByNameOrPath, PathNotAllowedError } from "./paths.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vmmcp-path-test-"));
const vmRoot = path.join(tmpDir, "vms");
const isoLib = path.join(tmpDir, "iso");

const mockConfig = {
  vmwareDir: "C:\\Program Files (x86)\\VMware\\VMware Workstation",
  vmrun: "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe",
  vmcli: "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmcli.exe",
  vdiskmanager: "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmware-vdiskmanager.exe",
  toolsWindowsIso: null,
  vmRoot,
  isoLibrary: isoLib,
  extraVmPaths: [] as string[],
  workDir: path.join(tmpDir, "work"),
  credentialsFile: path.join(tmpDir, "creds.json"),
  execTimeoutMs: 120000,
  defaultConcurrency: 4,
  maxRunningVms: 8,
};

vi.mock("./config.js", () => ({
  loadConfig: () => mockConfig,
}));

beforeEach(() => {
  fs.mkdirSync(vmRoot, { recursive: true });
  fs.mkdirSync(isoLib, { recursive: true });
  mockConfig.extraVmPaths = [];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("assertVmPathAllowed", () => {
  it("allows a path inside VM_ROOT", () => {
    const target = path.join(vmRoot, "test-vm");
    fs.mkdirSync(target, { recursive: true });
    const result = assertVmPathAllowed(target);
    expect(result).toBe(path.resolve(target));
  });

  it("rejects an empty path", () => {
    expect(() => assertVmPathAllowed("")).toThrow(PathNotAllowedError);
  });

  it("rejects a path outside VM_ROOT", () => {
    const outside = path.join(os.tmpdir(), "outside-dir");
    fs.mkdirSync(outside, { recursive: true });
    try {
      expect(() => assertVmPathAllowed(outside)).toThrow(PathNotAllowedError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows a path in extraVmPaths", () => {
    const extra = path.join(tmpDir, "extra-vm");
    fs.mkdirSync(extra, { recursive: true });
    mockConfig.extraVmPaths = [extra];
    const result = assertVmPathAllowed(extra);
    expect(result).toBe(path.resolve(extra));
  });
});

describe("assertVmxExists", () => {
  it("accepts a valid .vmx path", () => {
    const vmDir = path.join(vmRoot, "existing-vm");
    fs.mkdirSync(vmDir, { recursive: true });
    const vmx = path.join(vmDir, "existing-vm.vmx");
    fs.writeFileSync(vmx, '.encoding = "utf-8"\n');
    const result = assertVmxExists(vmx);
    expect(result).toBe(path.resolve(vmx));
  });

  it("rejects a non-.vmx path", () => {
    const vmDir = path.join(vmRoot, "bad-ext");
    fs.mkdirSync(vmDir, { recursive: true });
    const bad = path.join(vmDir, "file.txt");
    fs.writeFileSync(bad, "test");
    expect(() => assertVmxExists(bad)).toThrow(PathNotAllowedError);
  });

  it("rejects a non-existent .vmx", () => {
    const target = path.join(vmRoot, "missing.vmx");
    expect(() => assertVmxExists(target)).toThrow();
  });
});

describe("assertIsoAllowed", () => {
  it("allows an ISO inside the ISO library", () => {
    const iso = path.join(isoLib, "test.iso");
    fs.writeFileSync(iso, "mock iso content");
    const result = assertIsoAllowed(iso);
    expect(result).toBe(path.resolve(iso));
  });

  it("rejects an ISO outside the ISO library", () => {
    const outsideIso = path.join(tmpDir, "bad.iso");
    fs.writeFileSync(outsideIso, "bad");
    expect(() => assertIsoAllowed(outsideIso)).toThrow(PathNotAllowedError);
  });

  it("rejects a non-existent ISO", () => {
    const missing = path.join(isoLib, "nonexistent.iso");
    expect(() => assertIsoAllowed(missing)).toThrow();
  });
});

describe("resolveVmxByNameOrPath", () => {
  it("resolves direct .vmx path", () => {
    const vmDir = path.join(vmRoot, "direct-vm");
    fs.mkdirSync(vmDir, { recursive: true });
    const vmx = path.join(vmDir, "direct-vm.vmx");
    fs.writeFileSync(vmx, '.encoding = "utf-8"\n');
    const result = resolveVmxByNameOrPath(vmx);
    expect(result.toLowerCase()).toBe(vmx.toLowerCase());
  });

  it("resolves by name when folder exists under VM_ROOT", () => {
    const vmDir = path.join(vmRoot, "named-vm");
    fs.mkdirSync(vmDir, { recursive: true });
    const vmx = path.join(vmDir, "named-vm.vmx");
    fs.writeFileSync(vmx, '.encoding = "utf-8"\n');
    const result = resolveVmxByNameOrPath("named-vm");
    expect(result.toLowerCase()).toBe(vmx.toLowerCase());
  });

  it("throws for a name that does not match any VM", () => {
    expect(() => resolveVmxByNameOrPath("nonexistent-vm")).toThrow();
  });
});
