// Print a status line per VM: lifecycle, power, Tools, disk usage, last note.
// Reads the registry directly so it works even while a provision is in flight.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const VM_ROOT = process.env.VM_ROOT ?? "C:\\Users\\trite\\VMs";
const VMWARE = "C:\\Program Files (x86)\\VMware\\VMware Workstation";

function sh(exe, args) {
  try {
    return execFileSync(path.join(VMWARE, exe), args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const running = new Set(
  sh("vmrun.exe", ["-T", "ws", "list"])
    .split(/\r?\n/)
    .filter((l) => l.trim().toLowerCase().endsWith(".vmx"))
    .map((l) => l.trim().toLowerCase()),
);

function dirMb(p) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch {} }
    }
  };
  walk(p);
  return Math.round(total / 1048576);
}

const regPath = path.join(VM_ROOT, ".vmware-mcp", "registry.json");
let vms = {};
try { vms = JSON.parse(fs.readFileSync(regPath, "utf8")).vms ?? {}; } catch {}

const rows = Object.values(vms).sort((a, b) => a.name.localeCompare(b.name));
if (rows.length === 0) console.log(`(no VMs in ${regPath})`);

for (const v of rows) {
  const isUp = running.has(v.vmxPath.toLowerCase());
  const tools = isUp ? sh("vmrun.exe", ["-T", "ws", "checkToolsState", v.vmxPath]).split(/\r?\n/).pop() : "off";
  const mb = dirMb(path.dirname(v.vmxPath));
  const note = (v.notes ?? []).slice(-1)[0] ?? "";
  const marker = v.lifecycle === "ready" ? "OK " : v.lifecycle === "failed" ? "ERR" : "...";
  console.log(
    `${marker} ${v.name.padEnd(16)} ${v.lifecycle.padEnd(12)} ${(isUp ? "running" : "stopped").padEnd(8)} tools=${String(tools).padEnd(12)} ${String(mb).padStart(6)} MB`,
  );
  if (v.lastError) console.log(`      error: ${v.lastError.slice(0, 150)}`);
  else if (note) console.log(`      ${note.replace(/^\[[^\]]+\]\s*/, "").slice(0, 150)}`);
}
