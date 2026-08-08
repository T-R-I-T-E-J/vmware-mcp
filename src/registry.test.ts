import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vmmcp-rg-test-"));
const registryDir = path.join(tmpRoot, ".vmware-mcp");
const registryFile = path.join(registryDir, "registry.json");
const credFile = path.join(tmpRoot, "credentials.json");

vi.mock("./config.js", () => ({
  loadConfig: () => ({
    vmwareDir: "C:\\VMware",
    vmrun: "C:\\VMware\\vmrun.exe",
    vmcli: "C:\\VMware\\vmcli.exe",
    vdiskmanager: "C:\\VMware\\vmware-vdiskmanager.exe",
    toolsWindowsIso: null,
    vmRoot: tmpRoot,
    isoLibrary: path.join(tmpRoot, "iso"),
    extraVmPaths: [] as string[],
    workDir: path.join(tmpRoot, "work"),
    credentialsFile: credFile,
    execTimeoutMs: 120000,
    defaultConcurrency: 4,
    maxRunningVms: 8,
  }),
}));

import {
  upsertRecord, updateRecord, getRecord, listRecords, removeRecord,
  readRegistry, appendNote, selectRecords, type VmRecord,
} from "./registry.js";

beforeEach(() => {
  fs.rmSync(registryDir, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeRecord(name: string, overrides: Partial<VmRecord> = {}): Omit<VmRecord, "createdAt" | "updatedAt" | "notes" | "tags"> & { tags?: string[] } {
  return {
    name,
    vmxPath: `C:\\VMs\\${name}\\${name}.vmx`,
    guestOsId: "debian12-64",
    osFamily: "debian",
    lifecycle: "created",
    tags: overrides.tags ?? [],
  };
}

describe("registry CRUD", () => {
  it("upserts a new record", () => {
    const rec = upsertRecord(makeRecord("vm1"));
    expect(rec.name).toBe("vm1");
    expect(rec.lifecycle).toBe("created");
    expect(rec.createdAt).toBeTruthy();
    expect(rec.updatedAt).toBeTruthy();
  });

  it("upsert preserves existing fields not in the update", () => {
    upsertRecord({ ...makeRecord("vm1"), lifecycle: "provisioning" } as any);
    upsertRecord({ ...makeRecord("vm1"), lifecycle: "ready" } as any);
    const rec = getRecord("vm1");
    expect(rec?.lifecycle).toBe("ready");
    expect(rec?.guestOsId).toBe("debian12-64");
  });

  it("updateRecord modifies an existing record", () => {
    upsertRecord(makeRecord("vm2"));
    const updated = updateRecord("vm2", { lifecycle: "ready" });
    expect(updated?.lifecycle).toBe("ready");
  });

  it("updateRecord returns undefined for unknown VM", () => {
    expect(updateRecord("nonexistent", { lifecycle: "ready" })).toBeUndefined();
  });

  it("removeRecord deletes a record", () => {
    upsertRecord(makeRecord("vm3"));
    removeRecord("vm3");
    expect(getRecord("vm3")).toBeUndefined();
  });

  it("appendNote adds timestamped notes", () => {
    upsertRecord(makeRecord("vm4"));
    appendNote("vm4", "Installer started");
    appendNote("vm4", "Tools running");
    const rec = getRecord("vm4");
    expect(rec?.notes.length).toBe(2);
    expect(rec?.notes[0]).toContain("Installer started");
  });

  it("appendNote caps at 100 notes", () => {
    upsertRecord(makeRecord("vm5"));
    for (let i = 0; i < 110; i++) appendNote("vm5", `note ${i}`);
    const rec = getRecord("vm5");
    expect(rec?.notes.length).toBe(100);
  });

  it("listRecords returns records sorted by name", () => {
    upsertRecord(makeRecord("bbb"));
    upsertRecord(makeRecord("aaa"));
    upsertRecord(makeRecord("ccc"));
    const list = listRecords();
    expect(list.map((r) => r.name)).toEqual(["aaa", "bbb", "ccc"]);
  });
});

describe("registry corrupt file recovery", () => {
  it("recovers from corrupt JSON", () => {
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(registryFile, "{{{{ not valid", "utf8");
    const reg = readRegistry();
    expect(reg.vms).toEqual({});
  });

  it("recovers from a file with .vms being non-object", () => {
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({ version: 1, vms: null }), "utf8");
    const reg = readRegistry();
    expect(reg.vms).toEqual({});
  });
});

describe("selectRecords", () => {
  beforeEach(() => {
    upsertRecord({ ...makeRecord("win10-lab", { tags: ["windows", "lab"] }) });
    upsertRecord({ ...makeRecord("ubuntu-lab", { tags: ["ubuntu", "lab"] }) });
    upsertRecord({ ...makeRecord("debian-server", { tags: ["debian", "server"] }) });
    upsertRecord({ ...makeRecord("kali-attack", { tags: ["kali"] }) });
  });

  it("selects all with *", () => {
    expect(selectRecords("*")).toHaveLength(4);
  });

  it("selects by exact name", () => {
    expect(selectRecords("win10-lab")).toHaveLength(1);
  });

  it("selects by tag", () => {
    const labVms = selectRecords("tag:lab");
    expect(labVms).toHaveLength(2);
  });

  it("selects by glob", () => {
    const winVms = selectRecords("win*");
    expect(winVms).toHaveLength(1);
  });

  it("glob matches question mark", () => {
    // "kali-attack" doesn't match "kali-??????" pattern exactly
    upsertRecord({ ...makeRecord("node-01") });
    const matched = selectRecords("node-??");
    expect(matched).toHaveLength(1);
  });

  it("glob escapes regex special chars in names", () => {
    upsertRecord({ ...makeRecord("test.vm") });
    // The regex `.` escaping means "test.vm" matches "test.vm" literally, not "testXvm"
    upsertRecord({ ...makeRecord("testXvm") });
    const matched = selectRecords("test.vm");
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe("test.vm");
  });

  it("returns empty array for no matches", () => {
    expect(selectRecords("nonexistent")).toEqual([]);
  });
});
