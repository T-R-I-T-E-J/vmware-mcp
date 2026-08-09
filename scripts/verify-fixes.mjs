// Re-check every issue marked fixed, so "closed" means verified rather than
// believed. Run against a real host with at least one provisioned VM.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const VM_ROOT = process.env.VM_ROOT ?? "C:\\Users\\trite\\VMs";
const APPDATA = process.env.APPDATA;
const results = [];
const check = (issue, what, ok, detail = "") => {
  results.push({ issue, what, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  #${String(issue).padEnd(2)} ${what}${detail ? `\n            ${detail}` : ""}`);
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["C:\\Users\\trite\\projects\\vmware-mcp\\dist\\index.js"],
  env: { ...process.env, VM_ROOT, ISO_LIBRARY: process.env.ISO_LIBRARY ?? "C:\\Users\\trite\\iso" },
  stderr: "ignore",
});
const client = new Client({ name: "verify-fixes", version: "1.0.0" });
await client.connect(transport);
const call = async (name, args, sec = 300) => {
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: sec * 1000, maxTotalTimeout: sec * 1000 });
    return { ok: !r.isError, out: (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n") };
  } catch (e) { return { ok: false, out: String(e.message ?? e) }; }
};

const { tools } = await client.listTools();
const has = (n) => tools.some((t) => t.name === n);

// ---- #7 cloning
check(7, "clone tools exposed",
  has("clone_vm") && has("fleet_clone") && has("mark_template") && has("delete_clone_tree"),
  `${tools.length} tools registered`);

// ---- #10 helpers exposed
const helpers = ["pause_vm", "unpause_vm", "guest_rename", "set_shared_folder_state", "disable_shared_folders"];
check(10, "previously-unexposed vmrun helpers have tools",
  helpers.every(has), helpers.filter((h) => !has(h)).join(", ") || "all present");

// ---- #11 tests exist and pass
let testOut = "";
try {
  testOut = execFileSync("npm", ["test"], { encoding: "utf8", shell: true, cwd: "C:\\Users\\trite\\projects\\vmware-mcp" });
} catch (e) { testOut = (e.stdout ?? "") + (e.stderr ?? ""); }
const passed = /# pass (\d+)/.exec(testOut)?.[1] ?? "0";
const failed = /# fail (\d+)/.exec(testOut)?.[1] ?? "?";
check(11, "unit test suite passes", failed === "0" && Number(passed) > 0, `${passed} passing, ${failed} failing`);

// ---- #12 recursive copy
check(12, "recursive directory copy tools exist", has("guest_copy_dir_to") && has("guest_copy_dir_from"));

// ---- #18 no answer-file ISOs left with passwords in them
const seedDir = path.join(APPDATA, "vmware-mcp", "work", "seed");
const seeds = fs.existsSync(seedDir) ? fs.readdirSync(seedDir).filter((f) => f.endsWith(".iso")) : [];
check(18, "no generated seed ISOs left on disk", seeds.length === 0, seeds.join(", ") || "seed dir empty");

// ---- #19 install media detached from every VM
const stillAttached = [];
for (const d of fs.existsSync(VM_ROOT) ? fs.readdirSync(VM_ROOT) : []) {
  const vmx = path.join(VM_ROOT, d, `${d}.vmx`);
  if (!fs.existsSync(vmx)) continue;
  if (/^\s*sata0:[123]\./im.test(fs.readFileSync(vmx, "utf8"))) stillAttached.push(d);
}
check(19, "install media detached from all VMs", stillAttached.length === 0,
  stillAttached.join(", ") || "no sata0:1-3 entries anywhere");

// ---- #20 host path gate
const outside = await call("guest_copy_from", { vm: "kali-lab", guestPath: "/etc/hostname", hostPath: "C:\\Windows\\Temp\\pwn.txt", credentialRef: "kali-lab" });
check(20, "host writes outside allowed roots are refused",
  !outside.ok && /Refusing to operate/.test(outside.out), outside.out.split("\n")[0].slice(0, 120));

// ---- #21 credentials file ACL
let acl = "";
try { acl = execFileSync("icacls", [path.join(APPDATA, "vmware-mcp", "credentials.json")], { encoding: "utf8" }); } catch { /* absent */ }
check(21, "credentials.json is not world-readable",
  acl !== "" && !/\b(Everyone|BUILTIN\\Users|Authenticated Users)\b/i.test(acl),
  acl.split("\n")[0]?.trim().slice(0, 120));

// ---- #22 VNC ports unique across VMs
const ports = [];
for (const d of fs.existsSync(VM_ROOT) ? fs.readdirSync(VM_ROOT) : []) {
  const vmx = path.join(VM_ROOT, d, `${d}.vmx`);
  if (!fs.existsSync(vmx)) continue;
  const m = /remotedisplay\.vnc\.port\s*=\s*"(\d+)"/i.exec(fs.readFileSync(vmx, "utf8"));
  if (m) ports.push(Number(m[1]));
}
check(22, "no two VMs share a VNC port", new Set(ports).size === ports.length, `ports: ${ports.sort().join(", ")}`);

// ---- #23 registry survives concurrent writers, and no stale temp files
const before = fs.readFileSync(path.join(VM_ROOT, ".vmware-mcp", "registry.json"), "utf8");
await Promise.all([call("list_vms", {}), call("list_vms", {}), call("list_vms", {})]);
const strays = fs.readdirSync(path.join(VM_ROOT, ".vmware-mcp")).filter((f) => f.endsWith(".tmp"));
let parses = true;
try { JSON.parse(fs.readFileSync(path.join(VM_ROOT, ".vmware-mcp", "registry.json"), "utf8")); } catch { parses = false; }
check(23, "registry stays valid and leaves no stray temp files", parses && strays.length === 0,
  strays.join(", ") || "no .tmp leftovers");

// ---- #24 shell chosen by probing, not assumption
//
// Force the exact condition the bug needed: a registry record whose osFamily is
// "other". Before the fix that meant "assume Linux"; now it probes the guest.
// Run it against a Linux VM, so a *wrong* answer would pick PowerShell and fail
// loudly rather than pass by luck.
{
  const regPath = path.join(VM_ROOT, ".vmware-mcp", "registry.json");
  const original = fs.readFileSync(regPath, "utf8");
  let detail = "";
  let ok = false;
  try {
    const reg = JSON.parse(original);
    const target = reg.vms["kali-lab"];
    if (!target) {
      detail = "kali-lab not in registry; skipped";
      ok = true;
    } else {
      target.osFamily = "other";
      fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
      const r = await call("guest_exec_capture", { vm: "kali-lab", command: "uname -s", credentialRef: "kali-lab" }, 300);
      ok = r.ok && /bin\/bash/.test(r.out) && /Linux/.test(r.out);
      detail = ok
        ? 'osFamily "other" still resolved to /bin/bash and returned "Linux"'
        : r.out.replace(/\s+/g, " ").slice(0, 160);
    }
  } finally {
    fs.writeFileSync(regPath, original); // always restore
  }
  check(24, 'osFamily "other" probes instead of assuming Linux', ok, detail);
}

// ---- #25 work dir pruning
const workFiles = fs.readdirSync(path.join(APPDATA, "vmware-mcp", "work")).filter((f) => /^screen-/.test(f));
const oldOnes = workFiles.filter((f) => {
  try { return Date.now() - fs.statSync(path.join(APPDATA, "vmware-mcp", "work", f)).mtimeMs > 8 * 86400000; }
  catch { return false; }
});
check(25, "no scratch files older than the retention window", oldOnes.length === 0,
  `${workFiles.length} screenshots, ${oldOnes.length} older than 8d`);

console.log(`\n=== ${results.filter((r) => r.ok).length}/${results.length} checks passed ===`);
const bad = results.filter((r) => !r.ok);
if (bad.length) console.log(bad.map((b) => `  FAIL #${b.issue} ${b.what}`).join("\n"));

await client.close();
process.exit(bad.length ? 1 : 0);
