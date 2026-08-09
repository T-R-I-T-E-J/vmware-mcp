// Provision Ubuntu 24.04 desktop and verify the guest layer against it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["C:\\Users\\trite\\projects\\vmware-mcp\\dist\\index.js"],
  env: {
    ...process.env,
    VM_ROOT: process.env.VM_ROOT ?? "C:\\Users\\trite\\VMs",
    ISO_LIBRARY: process.env.ISO_LIBRARY ?? "C:\\Users\\trite\\iso",
  },
  stderr: "inherit",
});
const client = new Client({ name: "ubuntu", version: "1.0.0" });
await client.connect(transport);

async function call(name, args, timeout = 300000) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout, maxTotalTimeout: timeout });
  const out = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${r.isError ? "[ERROR]" : "[ok]"}\n${out.slice(0, 3000)}`);
  return { out, isError: r.isError };
}

const VM = "ubuntu-lab";
const PW = process.env.LAB_PASSWORD ?? "ChangeMe123!";

const p = await call("provision_vm", {
  name: VM,
  installIso: "ubuntu-24.04.3-desktop-amd64.iso",
  guestOsId: "ubuntu-64",
  username: "labuser",
  password: PW,
  credentialRef: VM,
  memoryMb: 4096,
  cpus: 2,
  diskGb: 35,
  autologin: true,
  tags: ["lab", "linux"],
  installTimeoutMin: 75,
  snapshotWhenReady: true,
  wait: true,
}, 95 * 60 * 1000);

if (!p.isError) {
  await call("guest_exec_capture", { vm: VM, command: "uname -a; id; hostname; lsb_release -ds; cat /var/log/vmware-mcp-ready", credentialRef: VM });
  await call("get_guest_ip", { vm: VM, wait: true });
  await call("guest_write_file", { vm: VM, guestPath: "/tmp/hello.txt", content: "written by vmware-mcp\n", credentialRef: VM });
  await call("guest_read_file", { vm: VM, guestPath: "/tmp/hello.txt", credentialRef: VM });
  await call("snapshot_list", { vm: VM });
  await call("fleet_status", { selector: "*" });
}

await client.close();
process.exit(0);
