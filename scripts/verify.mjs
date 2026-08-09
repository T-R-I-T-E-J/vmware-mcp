// Verify a provisioned VM's guest layer end to end.
// Usage: node scripts/verify.mjs <vm-name>
//
// Paths and commands live in JS, not in shell arguments — Windows argv parsing
// mangles the backslashes in a JSON string passed on a command line.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const vm = process.argv[2];
if (!vm) { console.error("usage: node scripts/verify.mjs <vm-name>"); process.exit(1); }

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["C:\\Users\\trite\\projects\\vmware-mcp\\dist\\index.js"],
  env: {
    ...process.env,
    VM_ROOT: process.env.VM_ROOT ?? "C:\\Users\\trite\\VMs",
    ISO_LIBRARY: process.env.ISO_LIBRARY ?? "C:\\Users\\trite\\iso",
  },
  stderr: "ignore",
});
const client = new Client({ name: "verify", version: "1.0.0" });
await client.connect(transport);

async function call(name, args, timeoutSec = 300) {
  const t = timeoutSec * 1000;
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: t, maxTotalTimeout: t });
    const out = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { ok: !r.isError, out };
  } catch (e) {
    return { ok: false, out: String(e.message ?? e) };
  }
}

const info = await call("get_vm_info", { vm });
const isWindows = /windows|win/i.test(info.out.match(/"guestOsId":\s*"([^"]+)"/)?.[1] ?? "");
const cred = vm;
const tmp = isWindows ? "C:\\Windows\\Temp\\vmware-mcp-verify.txt" : "/tmp/vmware-mcp-verify.txt";
const probe = isWindows
  ? "$env:COMPUTERNAME; whoami; (Get-CimInstance Win32_OperatingSystem).Caption"
  : "uname -a; id; hostname; cat /var/log/vmware-mcp-ready";

const results = [];
const step = async (label, name, args, timeoutSec) => {
  const r = await call(name, args, timeoutSec);
  results.push({ label, ok: r.ok, detail: r.out.replace(/\s+/g, " ").slice(0, 160) });
  console.log(`${r.ok ? "OK " : "FAIL"}  ${label}\n      ${r.out.replace(/\s+/g, " ").slice(0, 200)}`);
};

console.log(`\n=== verifying ${vm} (${isWindows ? "windows" : "linux"}) ===\n`);
await step("guest_exec_capture", "guest_exec_capture", { vm, command: probe, credentialRef: cred, timeoutSec: 180 }, 300);
await step("get_guest_ip", "get_guest_ip", { vm, wait: true }, 300);
await step("guest_write_file", "guest_write_file", { vm, guestPath: tmp, content: "written by vmware-mcp\n", credentialRef: cred }, 180);
await step("guest_read_file", "guest_read_file", { vm, guestPath: tmp, credentialRef: cred }, 180);
await step("guest_path_exists", "guest_path_exists", { vm, guestPath: tmp, credentialRef: cred }, 180);
await step("guest_list_processes", "guest_list_processes", { vm, filter: "vmtoolsd", credentialRef: cred }, 180);
await step("snapshot_list", "snapshot_list", { vm }, 120);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) console.log(failed.map((f) => `  FAIL ${f.label}: ${f.detail}`).join("\n"));

await client.close();
process.exit(failed.length ? 1 : 0);
