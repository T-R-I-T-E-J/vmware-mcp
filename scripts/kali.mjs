import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["C:\\Users\\trite\\projects\\vmware-mcp\\dist\\index.js"],
  // Under the user profile, not C:\VMs — a directory at the drive root is
  // ACL-restricted on Windows 11 and vmcli VM Create fails there.
  env: { ...process.env, VM_ROOT: "C:\\Users\\trite\\VMs", ISO_LIBRARY: "C:\\Users\\trite\\iso" },
  stderr: "inherit",
});
const client = new Client({ name: "kali", version: "1.0.0" });
await client.connect(transport);

async function call(name, args, timeout = 300000) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout, maxTotalTimeout: timeout });
  const out = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${r.isError ? "[ERROR]" : "[ok]"}\n${out.slice(0, 3000)}`);
  return { out, isError: r.isError };
}

const VM = "kali-lab";
const PW = process.env.LAB_PASSWORD ?? "ChangeMe123!";

const p = await call("provision_vm", {
  name: VM,
  installIso: "kali-linux-2024.4-installer-amd64.iso",
  guestOsId: "debian12-64",
  username: "labuser",
  password: PW,
  credentialRef: VM,
  memoryMb: 3072,
  cpus: 2,
  diskGb: 30,
  autologin: true,
  tags: ["lab", "linux"],
  installTimeoutMin: 75,
  snapshotWhenReady: true,
  wait: true,
}, 90 * 60 * 1000);

if (!p.isError) {
  // The guest layer — ~35 tools that have never run against a live OS.
  await call("guest_exec_capture", { vm: VM, command: "uname -a; id; hostname; cat /var/log/vmware-mcp-ready", credentialRef: VM });
  await call("get_guest_ip", { vm: VM, wait: true });
  await call("guest_write_file", { vm: VM, guestPath: "/tmp/hello.txt", content: "written by vmware-mcp\n", credentialRef: VM });
  await call("guest_read_file", { vm: VM, guestPath: "/tmp/hello.txt", credentialRef: VM });
  await call("guest_list_dir", { vm: VM, guestPath: "/etc", credentialRef: VM });
  await call("guest_path_exists", { vm: VM, guestPath: "/usr/bin/vmtoolsd", credentialRef: VM });
  await call("guest_list_processes", { vm: VM, filter: "vmtoolsd", credentialRef: VM });
  await call("guest_run", { vm: VM, program: "/bin/echo", args: ["guest_run ok"], credentialRef: VM });
  await call("snapshot_list", { vm: VM });
  await call("fleet_status", { selector: "*" });
  await call("fleet_run", { selector: "tag:lab", command: "echo fleet-ok" });
}

await client.close();
process.exit(0);
