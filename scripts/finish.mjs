// Finish the lab-debian provision and exercise the guest tools against it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["C:\\Users\\trite\\projects\\vmware-mcp\\dist\\index.js"],
  env: { ...process.env, VM_ROOT: "G:\\VMs", ISO_LIBRARY: "G:\\iso" },
  stderr: "inherit",
});
const client = new Client({ name: "finish", version: "1.0.0" });
await client.connect(transport);

async function call(name, args, timeout = 180000) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout, maxTotalTimeout: timeout });
  const out = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${r.isError ? "[ERROR]" : ""}\n${out.slice(0, 3000)}`);
  return r;
}

const VM = "lab-debian";
const CRED = "lab-debian";

await call("finalize_provision", { vm: VM, credentialRef: CRED, waitMinutes: 35, snapshotName: "clean" }, 45 * 60 * 1000);
await call("guest_exec_capture", { vm: VM, command: "uname -a; id; hostname; cat /var/log/vmware-mcp-ready", credentialRef: CRED });
await call("get_guest_ip", { vm: VM, wait: true }, 300000);
await call("guest_write_file", { vm: VM, guestPath: "/tmp/hello.txt", content: "written by vmware-mcp\n", credentialRef: CRED });
await call("guest_read_file", { vm: VM, guestPath: "/tmp/hello.txt", credentialRef: CRED });
await call("guest_list_processes", { vm: VM, filter: "vmtoolsd", credentialRef: CRED });
await call("snapshot_list", { vm: VM });
await call("fleet_status", { selector: "*" });
await call("fleet_run", { selector: "tag:lab", command: "echo fleet-ok; uptime" });

await client.close();
process.exit(0);
