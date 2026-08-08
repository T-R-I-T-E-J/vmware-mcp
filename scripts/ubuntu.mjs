import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["C:\\Users\\trite\\projects\\vmware-mcp\\dist\\index.js"],
  env: { ...process.env, VM_ROOT: "G:\\VMs", ISO_LIBRARY: "G:\\iso" },
  stderr: "inherit",
});
const client = new Client({ name: "ubuntu", version: "1.0.0" });
await client.connect(transport);

async function call(name, args, timeout = 180000) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout, maxTotalTimeout: timeout });
  const out = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${r.isError ? "[ERROR]" : "[ok]"}\n${out.slice(0, 3000)}`);
  return { out, isError: r.isError };
}

const VM = "ubuntu-lab";

await call("provision_vm", {
  name: VM,
  installIso: "ubuntu-24.04.3-desktop-amd64.iso",
  guestOsId: "ubuntu-64",
  username: "labuser",
  password: process.env.LAB_PASSWORD ?? "ChangeMe123!",
  credentialRef: VM,
  memoryMb: 4096,
  cpus: 2,
  diskGb: 40,
  autologin: true,
  tags: ["lab", "linux"],
  installTimeoutMin: 75,
  snapshotWhenReady: true,
  wait: true,
}, 90 * 60 * 1000);

await call("guest_exec_capture", { vm: VM, command: "uname -a; id; hostname; lsb_release -d", credentialRef: VM }, 300000);
await call("get_guest_ip", { vm: VM, wait: true }, 300000);
await call("guest_write_file", { vm: VM, guestPath: "/tmp/hello.txt", content: "written by vmware-mcp\n", credentialRef: VM });
await call("guest_read_file", { vm: VM, guestPath: "/tmp/hello.txt", credentialRef: VM });
await call("snapshot_list", { vm: VM });

await client.close();
process.exit(0);
