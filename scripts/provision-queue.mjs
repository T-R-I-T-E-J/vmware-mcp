// Provision a queue of VMs strictly one at a time.
//
// Sequential by necessity, not preference: this host has 16 GB and two
// concurrent VMs starve it. Memory pressure is a *correctness* problem here —
// VMware's virtual keyboard drops characters when the host stalls, which is how
// an earlier Debian install died mid boot-command (#4).
//
// Usage: node scripts/provision-queue.mjs win10-lab winsrv2019-lab
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";

const VMRUN = "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = process.env.LAB_PASSWORD ?? "ChangeMe123!";

const SPECS = {
  "win10-lab": {
    installIso: "windoes1o.iso",
    guestOsId: "windows9-64",
    username: "labadmin",
    memoryMb: 3072, cpus: 2, diskGb: 60, firmware: "bios",
    // Multi-edition install.esd with no ei.cfg; the answer file injects the
    // generic edition-selection key for this name (#5).
    windowsImageName: "Windows 10 Pro",
    tags: ["lab", "windows"],
    probe: { command: "ver & whoami & hostname", shell: "cmd" },
    guestTmp: "C:\\Windows\\Temp\\hello.txt",
  },
  "winsrv2019-lab": {
    installIso: "winsrv2019-eval.iso",
    guestOsId: "windows9srv-64",
    username: "labadmin",
    memoryMb: 3072, cpus: 2, diskGb: 60, firmware: "bios",
    // Eval media carries four images; 2 is Standard with Desktop Experience.
    // Evaluation ISOs reject KMS client keys, so no product key is injected.
    windowsImageIndex: 2,
    tags: ["lab", "windows"],
    probe: { command: "ver & whoami & hostname", shell: "cmd" },
    guestTmp: "C:\\Windows\\Temp\\hello.txt",
  },
  "ubuntu-lab": {
    installIso: "ubuntu-24.04.3-desktop-amd64.iso",
    guestOsId: "ubuntu-64",
    username: "labuser",
    memoryMb: 4096, cpus: 2, diskGb: 35,
    autologin: true, tags: ["lab", "linux"],
    probe: { command: "uname -a; id; hostname; lsb_release -ds" },
    guestTmp: "/tmp/hello.txt",
  },
};

function runningVms() {
  try {
    return execFileSync(VMRUN, ["-T", "ws", "list"], { encoding: "utf8" })
      .split(/\r?\n/).filter((l) => l.trim().toLowerCase().endsWith(".vmx"));
  } catch { return []; }
}

async function waitForFreeHost(label) {
  const deadline = Date.now() + 150 * 60_000;
  for (;;) {
    const running = runningVms();
    if (running.length === 0) return true;
    if (Date.now() > deadline) {
      console.log(`[${label}] gave up waiting; still running: ${running.join(", ")}`);
      return false;
    }
    console.log(`[${label}] waiting for: ${running.map((p) => p.split("\\").pop()).join(", ")}`);
    await sleep(60_000);
  }
}

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
const client = new Client({ name: "queue", version: "1.0.0" });
await client.connect(transport);

async function call(name, args, timeout = 300000) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout, maxTotalTimeout: timeout });
  const out = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name}(${args.vm ?? args.name ?? ""}) ${r.isError ? "[ERROR]" : "[ok]"}\n${out.slice(0, 2500)}`);
  return { out, isError: r.isError };
}

const summary = [];
for (const name of process.argv.slice(2)) {
  const spec = SPECS[name];
  if (!spec) { console.log(`unknown VM "${name}"`); continue; }

  console.log(`\n################ ${name} ################`);
  await waitForFreeHost(name);

  const { probe, guestTmp, ...vmArgs } = spec;
  const p = await call("provision_vm", {
    name, ...vmArgs,
    password: PW,
    credentialRef: name,
    installTimeoutMin: 75,
    snapshotWhenReady: true,
    wait: true,
  }, 95 * 60 * 1000);

  if (p.isError) {
    summary.push({ vm: name, ok: false, detail: p.out.slice(0, 200) });
    await call("capture_screen", { vm: name, savePath: `C:\\Users\\trite\\VMs\\fail-${name}.png`, returnImage: false }).catch(() => {});
  } else {
    const r = await call("guest_exec_capture", { vm: name, ...probe, credentialRef: name });
    await call("get_guest_ip", { vm: name, wait: true }).catch(() => {});
    await call("guest_write_file", { vm: name, guestPath: guestTmp, content: "written by vmware-mcp\n", credentialRef: name }).catch(() => {});
    await call("guest_read_file", { vm: name, guestPath: guestTmp, credentialRef: name }).catch(() => {});
    await call("snapshot_list", { vm: name }).catch(() => {});
    summary.push({ vm: name, ok: !r.isError, detail: r.out.slice(0, 200) });
  }

  // Free the RAM for the next one.
  await call("stop_vm", { vm: name, mode: "soft" }).catch(() => {});
  await sleep(30_000);
  await call("stop_vm", { vm: name, mode: "hard" }).catch(() => {});
}

console.log("\n################ SUMMARY ################");
console.log(JSON.stringify(summary, null, 2));
await call("fleet_status", { selector: "*" }).catch(() => {});
await client.close();
process.exit(0);
