// Install the requested VMs one at a time. Sequential by necessity: the host has
// ~2 GB of available RAM, so each VM is powered off before the next is built.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["C:\\Users\\trite\\projects\\vmware-mcp\\dist\\index.js"],
  env: { ...process.env, VM_ROOT: "G:\\VMs", ISO_LIBRARY: "G:\\iso" },
  stderr: "inherit",
});
const client = new Client({ name: "installall", version: "1.0.0" });
await client.connect(transport);

const HOUR = 60 * 60 * 1000;
async function call(name, args, timeout = 180000) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout, maxTotalTimeout: timeout });
  const out = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name}(${args.name ?? args.vm ?? ""}) ${r.isError ? "[ERROR]" : "[ok]"}\n${out.slice(0, 2500)}`);
  return { out, isError: r.isError };
}

const VMS = [
  {
    name: "win10-lab",
    installIso: "windoes1o.iso",
    guestOsId: "windows9-64",
    username: "labadmin",
    password: process.env.LAB_PASSWORD ?? "ChangeMe123!",
    memoryMb: 4096, cpus: 2, diskGb: 60,
    windowsImageName: "Windows 10 Pro",
    tags: ["lab", "windows"],
    installTimeoutMin: 60,
  },
  {
    name: "kali-lab",
    installIso: "kali-linux-2024.4-installer-amd64.iso",
    guestOsId: "debian12-64",
    username: "labuser",
    password: process.env.LAB_PASSWORD ?? "ChangeMe123!",
    memoryMb: 3072, cpus: 2, diskGb: 40,
    autologin: true,
    tags: ["lab", "linux"],
    installTimeoutMin: 75,
  },
  {
    name: "ubuntu-lab",
    installIso: "ubuntu-24.04.3-desktop-amd64.iso",
    guestOsId: "ubuntu-64",
    username: "labuser",
    password: process.env.LAB_PASSWORD ?? "ChangeMe123!",
    memoryMb: 4096, cpus: 2, diskGb: 40,
    autologin: true,
    tags: ["lab", "linux"],
    installTimeoutMin: 75,
  },
  {
    name: "winsrv2019-lab",
    installIso: "17763.3650.221105-1748.rs5_release_svc_refresh_SERVER_EVAL_x64FRE_en-us (1).iso",
    guestOsId: "windows9srv-64",
    username: "labadmin",
    password: process.env.LAB_PASSWORD ?? "ChangeMe123!",
    memoryMb: 4096, cpus: 2, diskGb: 60,
    // Server eval ISOs carry four images; 2 is Standard with Desktop Experience.
    windowsImageIndex: 2,
    tags: ["lab", "windows"],
    installTimeoutMin: 60,
  },
];

const summary = [];
for (const vm of VMS) {
  console.log(`\n################ ${vm.name} ################`);
  const r = await call("provision_vm", {
    ...vm,
    credentialRef: vm.name,
    snapshotWhenReady: true,
    wait: true,
  }, HOUR);

  if (r.isError) {
    summary.push({ vm: vm.name, ok: false, detail: r.out.slice(0, 300) });
    // Capture what the screen looked like so a failure is diagnosable later.
    await call("capture_screen", { vm: vm.name, savePath: `G:\\VMs\\fail-${vm.name}.png`, returnImage: false }).catch(() => {});
  } else {
    const probe = await call("guest_exec_capture", {
      vm: vm.name,
      command: vm.guestOsId.startsWith("win") ? "ver & whoami & hostname" : "uname -a; id; hostname",
      credentialRef: vm.name,
    }, 300000);
    summary.push({ vm: vm.name, ok: !probe.isError, detail: probe.out.slice(0, 300) });
  }

  // Free the RAM before building the next one.
  await call("stop_vm", { vm: vm.name, mode: "soft" }, 300000).catch(() => {});
  await new Promise((x) => setTimeout(x, 20000));
  await call("stop_vm", { vm: vm.name, mode: "hard" }, 120000).catch(() => {});
}

console.log("\n################ SUMMARY ################");
console.log(JSON.stringify(summary, null, 2));
await call("fleet_status", { selector: "*" });

await client.close();
process.exit(0);
