import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseVmx, writeVmx, patchVmx, getVmxValue, cdromEntries, removeCdrom,
  ethernetEntries, diskEntries, findVmxInDir,
} from "../src/vmx.js";

function tmpVmx(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vmx-test-"));
  const p = path.join(dir, "t.vmx");
  fs.writeFileSync(p, body, "utf8");
  return p;
}

test("parses key = \"value\" and strips quotes", () => {
  const p = tmpVmx('displayName = "my vm"\nmemsize = "4096"\n');
  const cfg = parseVmx(p);
  assert.equal(getVmxValue(cfg, "displayName"), "my vm");
  assert.equal(getVmxValue(cfg, "memsize"), "4096");
});

test("keys are case-insensitive, as VMware treats them", () => {
  const p = tmpVmx('RemoteDisplay.vnc.port = "5910"\n');
  const cfg = parseVmx(p);
  assert.equal(getVmxValue(cfg, "remotedisplay.vnc.port"), "5910");
  assert.equal(getVmxValue(cfg, "RemoteDisplay.VNC.Port"), "5910");
});

test("comments and blank lines are ignored", () => {
  const p = tmpVmx('#!/usr/bin/vmware\n\n# a comment\nmemsize = "2048"\n');
  assert.equal(parseVmx(p).size, 1);
});

test("patch round-trips and preserves untouched keys", () => {
  const p = tmpVmx('displayName = "vm"\nmemsize = "1024"\nnumvcpus = "1"\n');
  patchVmx(p, { memsize: "4096" });
  const cfg = parseVmx(p);
  assert.equal(getVmxValue(cfg, "memsize"), "4096");
  assert.equal(getVmxValue(cfg, "displayName"), "vm");
  assert.equal(getVmxValue(cfg, "numvcpus"), "1");
});

test("patching null deletes a key", () => {
  const p = tmpVmx('memsize = "1024"\nmemory.maxsize = "880"\n');
  patchVmx(p, { "memory.maxsize": null });
  assert.equal(getVmxValue(parseVmx(p), "memory.maxsize"), undefined);
});

test("values containing quotes survive a round trip", () => {
  const p = tmpVmx('displayName = "plain"\n');
  patchVmx(p, { annotation: 'has "quotes" inside' });
  assert.match(fs.readFileSync(p, "utf8"), /annotation/);
});

test(".encoding stays on the first line", () => {
  const p = tmpVmx('.encoding = "windows-1252"\nzzz = "last"\naaa = "first"\n');
  const cfg = parseVmx(p);
  writeVmx(p, cfg);
  assert.match(fs.readFileSync(p, "utf8").split("\n")[0], /^\.encoding/);
});

test("cdromEntries builds a connected image device", () => {
  const e = cdromEntries({ device: "sata0:1", isoPath: "C:\\iso\\x.iso" });
  assert.equal(e["sata0:1.present"], "TRUE");
  assert.equal(e["sata0:1.devicetype"], "cdrom-image");
  assert.equal(e["sata0:1.filename"], "C:\\iso\\x.iso");
  assert.equal(e["sata0:1.startconnected"], "TRUE");
});

test("removeCdrom deletes every key for that device only", () => {
  // Regression guard for #19: leaving any sata0:2.* key behind kept the
  // password-bearing seed ISO attached.
  const p = tmpVmx(
    'sata0:1.present = "TRUE"\nsata0:1.filename = "a.iso"\n' +
    'sata0:2.present = "TRUE"\nsata0:2.filename = "seed.iso"\nsata0:2.startconnected = "TRUE"\n',
  );
  const cfg = parseVmx(p);
  removeCdrom(cfg, "sata0:2");
  assert.equal([...cfg.keys()].filter((k) => k.startsWith("sata0:2.")).length, 0);
  assert.equal(getVmxValue(cfg, "sata0:1.filename"), "a.iso");
});

test("ethernet entries cover each connection type", () => {
  assert.equal(ethernetEntries(0, "nat")["ethernet0.connectiontype"], "nat");
  assert.equal(ethernetEntries(0, "none")["ethernet0.present"], "FALSE");
  assert.equal(ethernetEntries(1, "custom", "VMnet2")["ethernet1.vnet"], "VMnet2");
  assert.throws(() => ethernetEntries(0, "custom"), /requires a vnet/);
});

test("diskEntries wires the controller for its bus", () => {
  const scsi = diskEntries({ device: "scsi0:0", vmdkFileName: "d.vmdk" });
  assert.equal(scsi["scsi0.present"], "TRUE");
  assert.equal(scsi["scsi0.virtualdev"], "lsisas1068");
  const nvme = diskEntries({ device: "nvme0:0", vmdkFileName: "d.vmdk" });
  assert.equal(nvme["nvme0.present"], "TRUE");
  assert.equal(nvme["nvme0.virtualdev"], undefined);
});

test("findVmxInDir finds a .vmx and tolerates junk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vmdir-"));
  assert.equal(findVmxInDir(dir), null);
  fs.writeFileSync(path.join(dir, "a.log"), "");
  fs.writeFileSync(path.join(dir, "vm.vmx"), "");
  assert.equal(path.basename(findVmxInDir(dir)!), "vm.vmx");
  assert.equal(findVmxInDir(path.join(dir, "nope")), null);
});
