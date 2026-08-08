import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseVmx, writeVmx, patchVmx, getVmxValue, cdromEntries, ethernetEntries, diskEntries, findVmxInDir, removeCdrom } from "./vmx.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vmmcp-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeVmx(content: string): string {
  const p = path.join(tmpDir, "test.vmx");
  fs.writeFileSync(p, content, "utf8");
  return p;
}

describe("parseVmx", () => {
  it("parses simple key-value pairs", () => {
    const p = makeVmx('.encoding = "windows-1252"\nmemsize = "4096"\nnumvcpus = "4"\n');
    const cfg = parseVmx(p);
    expect(cfg.get(".encoding")).toBe("windows-1252");
    expect(cfg.get("memsize")).toBe("4096");
    expect(cfg.get("numvcpus")).toBe("4");
  });

  it("stores keys lowercase", () => {
    const p = makeVmx('DisplayName = "test-vm"\n');
    const cfg = parseVmx(p);
    expect(cfg.has("displayname")).toBe(true);
    expect(cfg.get("displayname")).toBe("test-vm");
  });

  it("strips surrounding double quotes from values", () => {
    const p = makeVmx('guestOS = "windows9-64"\n');
    const cfg = parseVmx(p);
    expect(cfg.get("guestos")).toBe("windows9-64");
  });

  it("ignores comments", () => {
    const p = makeVmx('# This is a comment\nmemsize = "1024"\n# Another comment\n');
    const cfg = parseVmx(p);
    expect(cfg.size).toBe(1);
    expect(cfg.get("memsize")).toBe("1024");
  });

  it("ignores blank lines", () => {
    const p = makeVmx('\nmemsize = "512"\n\nnumvcpus = "2"\n\n');
    const cfg = parseVmx(p);
    expect(cfg.has("memsize")).toBe(true);
    expect(cfg.has("numvcpus")).toBe(true);
  });

  it("handles values containing equals signs", () => {
    const p = makeVmx('annotation = "some=value=here"\n');
    const cfg = parseVmx(p);
    expect(cfg.get("annotation")).toBe("some=value=here");
  });
});

describe("writeVmx", () => {
  it("writes a valid .vmx and keeps .encoding first", () => {
    const p = path.join(tmpDir, "out.vmx");
    const cfg = new Map<string, string>();
    cfg.set(".encoding", "utf-8");
    cfg.set("memsize", "4096");
    cfg.set("numvcpus", "2");
    writeVmx(p, cfg);

    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    expect(lines[0]).toBe('.encoding = "utf-8"');
  });

  it("preserves entries after round-trip", () => {
    const original = '.encoding = "windows-1252"\nmemsize = "4096"\ndisplayName = "test"\n';
    const p = makeVmx(original);
    const cfg = parseVmx(p);
    writeVmx(p, cfg);
    const cfg2 = parseVmx(p);
    expect(cfg2.get("memsize")).toBe("4096");
    expect(cfg2.get("displayname")).toBe("test");
  });
});

describe("patchVmx", () => {
  it("adds new entries", () => {
    const p = makeVmx("memsize = \"1024\"\n");
    patchVmx(p, { numvcpus: "4" });
    const cfg = parseVmx(p);
    expect(cfg.get("memsize")).toBe("1024");
    expect(cfg.get("numvcpus")).toBe("4");
  });

  it("updates existing entries", () => {
    const p = makeVmx("memsize = \"1024\"\n");
    patchVmx(p, { memsize: "8192" });
    const cfg = parseVmx(p);
    expect(cfg.get("memsize")).toBe("8192");
  });

  it("deletes entries with null values", () => {
    const p = makeVmx("memsize = \"1024\"\nnumvcpus = \"2\"\n");
    patchVmx(p, { numvcpus: null });
    const cfg = parseVmx(p);
    expect(cfg.has("numvcpus")).toBe(false);
    expect(cfg.get("memsize")).toBe("1024");
  });

  it("returns the updated config", () => {
    const p = makeVmx("memsize = \"1024\"\n");
    const cfg = patchVmx(p, { firmware: "efi" });
    expect(cfg.get("firmware")).toBe("efi");
  });
});

describe("getVmxValue", () => {
  it("returns undefined for missing keys", () => {
    const p = makeVmx("memsize = \"1024\"\n");
    const cfg = parseVmx(p);
    expect(getVmxValue(cfg, "nonexistent")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    const p = makeVmx("memsize = \"1024\"\n");
    const cfg = parseVmx(p);
    expect(getVmxValue(cfg, "MEMSIZE")).toBe("1024");
    expect(getVmxValue(cfg, "MemSize")).toBe("1024");
  });
});

describe("cdromEntries", () => {
  it("generates correct CD-ROM entries", () => {
    const entries = cdromEntries({ device: "sata0:1", isoPath: "/path/to/install.iso" });
    expect(entries["sata0:1.present"]).toBe("TRUE");
    expect(entries["sata0:1.devicetype"]).toBe("cdrom-image");
    expect(entries["sata0:1.filename"]).toBe("/path/to/install.iso");
    expect(entries["sata0:1.startconnected"]).toBe("TRUE");
  });

  it("respects startConnected: false", () => {
    const entries = cdromEntries({ device: "sata0:2", isoPath: "/path/to/tools.iso", startConnected: false });
    expect(entries["sata0:2.startconnected"]).toBe("FALSE");
  });
});

describe("ethernetEntries", () => {
  it("generates NAT network entry", () => {
    const entries = ethernetEntries(0, "nat");
    expect(entries["ethernet0.present"]).toBe("TRUE");
    expect(entries["ethernet0.connectiontype"]).toBe("nat");
    expect(entries["ethernet0.virtualdev"]).toBe("e1000e");
    expect(entries["ethernet0.startconnected"]).toBe("TRUE");
  });

  it("generates 'none' network as not present", () => {
    const entries = ethernetEntries(1, "none");
    expect(entries["ethernet1.present"]).toBe("FALSE");
  });

  it("generates custom vnet entry", () => {
    const entries = ethernetEntries(0, "custom", "VMnet2");
    expect(entries["ethernet0.connectiontype"]).toBe("custom");
    expect(entries["ethernet0.vnet"]).toBe("VMnet2");
  });

  it("throws on custom without vnet name", () => {
    expect(() => ethernetEntries(0, "custom")).toThrow('"custom"');
  });
});

describe("diskEntries", () => {
  it("generates NVMe disk entry", () => {
    const entries = diskEntries({ device: "nvme0:0", vmdkFileName: "test.vmdk" });
    expect(entries["nvme0.present"]).toBe("TRUE");
    expect(entries["nvme0:0.present"]).toBe("TRUE");
    expect(entries["nvme0:0.filename"]).toBe("test.vmdk");
    expect(entries["nvme0:0.devicetype"]).toBe("disk");
  });

  it("generates SCSI disk with virtualdev", () => {
    const entries = diskEntries({ device: "scsi0:0", vmdkFileName: "test.vmdk" });
    expect(entries["scsi0.virtualdev"]).toBe("lsisas1068");
  });
});

describe("removeCdrom", () => {
  it("removes all keys with device prefix", () => {
    const cfg = new Map<string, string>();
    cfg.set("sata0:2.present", "TRUE");
    cfg.set("sata0:2.filename", "seed.iso");
    cfg.set("memsize", "4096");
    removeCdrom(cfg, "sata0:2");
    expect(cfg.has("sata0:2.present")).toBe(false);
    expect(cfg.has("sata0:2.filename")).toBe(false);
    expect(cfg.get("memsize")).toBe("4096");
  });
});

describe("findVmxInDir", () => {
  it("finds a .vmx file in a directory", () => {
    fs.writeFileSync(path.join(tmpDir, "test.vmx"), "");
    const found = findVmxInDir(tmpDir);
    expect(found).toBe(path.join(tmpDir, "test.vmx"));
  });

  it("returns null for directory with no .vmx", () => {
    const found = findVmxInDir(tmpDir);
    expect(found).toBeNull();
  });

  it("returns null for non-existent directory", () => {
    const found = findVmxInDir(path.join(tmpDir, "nope"));
    expect(found).toBeNull();
  });
});
