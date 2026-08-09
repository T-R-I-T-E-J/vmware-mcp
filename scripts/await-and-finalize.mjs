// Wait for an in-flight install to finish, then finalize and verify it.
//
// The guest install runs inside the VM, so it survives this process being
// killed — but the post-install steps (verify login, eject media, snapshot)
// do not. This picks those up. Usage:
//   node scripts/await-and-finalize.mjs <vm> [maxWaitMin]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";

const vm = process.argv[2];
const maxWaitMin = Number(process.argv[3] || 90);
if (!vm) { console.error("usage: node scripts/await-and-finalize.mjs <vm> [maxWaitMin]"); process.exit(1); }

const VMRUN = "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe";
const VM_ROOT = process.env.VM_ROOT ?? "C:\\Users\\trite\\VMs";
const vmx = `${VM_ROOT}\\${vm}\\${vm}.vmx`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toolsState() {
  try {
    return execFileSync(VMRUN, ["-T", "ws", "checkToolsState", vmx], { encoding: "utf8" }).trim().split(/\r?\n/).pop();
  } catch { return "unknown"; }
}

// Wait for VMware Tools to appear, which means the OS is installed and booted.
const deadline = Date.now() + maxWaitMin * 60_000;
let state = toolsState();
while (!["running", "installed"].includes(state) && Date.now() < deadline) {
  console.log(`waiting for Tools in ${vm} (state=${state}) ...`);
  await sleep(60_000);
  state = toolsState();
}
console.log(`Tools state: ${state}`);
if (!["running", "installed"].includes(state)) {
  console.log("Tools never appeared; the install has not finished.");
  process.exit(1);
}

// Windows installs Tools with reboot suppressed, so the handshake often needs a
// restart before guest operations work. Cheap insurance either way.
if (state !== "running") {
  console.log("Tools present but not running — rebooting once to complete the handshake.");
  try { execFileSync(VMRUN, ["-T", "ws", "reset", vmx, "soft"], { encoding: "utf8" }); } catch {}
  await sleep(120_000);
  console.log(`after reboot: ${toolsState()}`);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["C:\\Users\\trite\\projects\\vmware-mcp\\dist\\index.js"],
  env: { ...process.env, VM_ROOT, ISO_LIBRARY: process.env.ISO_LIBRARY ?? "C:\\Users\\trite\\iso" },
  stderr: "ignore",
});
const client = new Client({ name: "finalize", version: "1.0.0" });
await client.connect(transport);

async function call(name, args, timeoutSec = 900) {
  const t = timeoutSec * 1000;
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: t, maxTotalTimeout: t });
    const out = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    console.log(`\n=== ${name} ${r.isError ? "[ERROR]" : "[ok]"}\n${out.slice(0, 2000)}`);
    return { ok: !r.isError, out };
  } catch (e) {
    console.log(`\n=== ${name} [THREW] ${e.message ?? e}`);
    return { ok: false, out: String(e.message ?? e) };
  }
}

const fin = await call("finalize_provision", {
  vm, credentialRef: vm, waitMinutes: 20, snapshotName: "clean",
}, 1800);

await client.close();
console.log(fin.ok ? "\nFINALIZED" : "\nFINALIZE FAILED");
process.exit(fin.ok ? 0 : 1);
