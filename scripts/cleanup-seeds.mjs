// Retroactively detach install media and delete generated answer-file ISOs.
//
// Answer files embed the guest password in clear text, so a leftover seed ISO
// leaves that password readable on the host. VMs provisioned before this was
// fixed still reference theirs.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const VMRUN = "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe";
const VM_ROOT = process.env.VM_ROOT ?? "C:\\Users\\trite\\VMs";
const SEED_DIR = path.join(process.env.APPDATA ?? "", "vmware-mcp", "work", "seed");

const running = new Set(
  (() => { try { return execFileSync(VMRUN, ["-T","ws","list"], { encoding: "utf8" }); } catch { return ""; } })()
    .split(/\r?\n/).filter((l) => l.trim().toLowerCase().endsWith(".vmx")).map((l) => l.trim().toLowerCase()),
);

const reg = JSON.parse(fs.readFileSync(path.join(VM_ROOT, ".vmware-mcp", "registry.json"), "utf8"));

for (const vm of Object.values(reg.vms)) {
  const vmx = vm.vmxPath;
  if (!fs.existsSync(vmx)) continue;
  if (running.has(vmx.toLowerCase())) {
    console.log(`${vm.name}: RUNNING — skipped (edits to a live .vmx are overwritten at power-off)`);
    continue;
  }

  const lines = fs.readFileSync(vmx, "utf8").split(/\r?\n/);
  const kept = lines.filter((l) => !/^\s*sata0:[123]\./i.test(l));
  const removed = lines.length - kept.length;
  if (removed > 0) fs.writeFileSync(vmx, kept.join("\n"), "utf8");

  const seed = path.join(SEED_DIR, `${vm.name}-seed.iso`);
  let seedNote = "no seed ISO";
  if (fs.existsSync(seed)) { fs.rmSync(seed, { force: true }); seedNote = "seed ISO deleted"; }

  console.log(`${vm.name}: ${removed} media line(s) removed, ${seedNote}`);
}

const leftovers = fs.existsSync(SEED_DIR) ? fs.readdirSync(SEED_DIR) : [];
console.log(`\nseed dir now: ${leftovers.length ? leftovers.join(", ") : "(empty)"}`);
