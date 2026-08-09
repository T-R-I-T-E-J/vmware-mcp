import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { assertIsoAllowed, assertVmPathAllowed, resolveVmxByNameOrPath } from "../paths.js";
import * as vmrun from "../vmrun.js";
import * as vmcli from "../vmcli.js";
import { cdromEntries, diskEntries, ethernetEntries, findVmxInDir, parseVmx, patchVmx, type NetworkType } from "../vmx.js";
import { listRecords, removeRecord, upsertRecord, getRecord, updateRecord } from "../registry.js";
import { confirmArg, defineTool, json, requireConfirm, text, vmArg } from "./common.js";
import { allocateVncPort } from "./screen.js";

/** vmcli guest OS ids for the install media present on this host, plus common extras. */
export const GUEST_OS_IDS = [
  "windows9-64",      // Windows 10
  "windows11-64",     // Windows 11
  "windows9srv-64",   // Windows Server 2016/2019
  "windows2019srv-64",
  "windows7-64",
  "ubuntu-64",
  "debian12-64",
  "debian11-64",
  "otherlinux-64",
  "other6xlinux-64",
] as const;

/**
 * The only guest OS ids `vmcli VM Create` will accept. Anything else is
 * rejected outright with "Invalid argument".
 *
 * Notably there is **no Windows Server id at all** — `windows9srv-64` and
 * friends are valid values for the `guestOS` key in a .vmx, but vmcli refuses
 * them on the command line. So a Server VM is created with an accepted id and
 * the .vmx is patched afterwards to the id we actually want.
 */
const VMCLI_GUEST_IDS = new Set([
  "debian12-64", "debian13-64", "centos8-64", "centos9-64", "other6xlinux-64",
  "windows11-64", "windows9-64", "fedora-64", "rhel9-64", "rhel10-64",
  "opensuse-64", "ubuntu-64", "vmware-photon-64",
]);

/** An id vmcli accepts that is closest to what the caller asked for. */
function vmcliCreateId(guestOsId: string): string {
  if (VMCLI_GUEST_IDS.has(guestOsId)) return guestOsId;
  const g = guestOsId.toLowerCase();
  if (g.startsWith("win")) return g.includes("11") ? "windows11-64" : "windows9-64";
  if (g.startsWith("ubuntu")) return "ubuntu-64";
  if (g.startsWith("debian")) return "debian12-64";
  if (g.startsWith("rhel") || g.startsWith("centos")) return "centos9-64";
  return "other6xlinux-64";
}

export function osFamilyForGuestId(guestOsId: string): "windows" | "debian" | "ubuntu" | "other" {
  const g = guestOsId.toLowerCase();
  if (g.startsWith("win")) return "windows";
  if (g.startsWith("ubuntu")) return "ubuntu";
  if (g.startsWith("debian")) return "debian";
  return "other";
}

function freeBytesOn(dir: string): number | null {
  try {
    const s = fs.statfsSync(path.parse(path.resolve(dir)).root);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export interface CreateVmArgs {
  name: string;
  guestOsId: string;
  memoryMb: number;
  cpus: number;
  coresPerSocket?: number;
  diskGb: number;
  diskAdapter: "nvme" | "lsilogic" | "sata" | "ide";
  firmware: "bios" | "efi";
  network: "nat" | "bridged" | "hostonly" | "custom" | "none";
  customVnet?: string;
  installIso?: string;
  tags?: string[];
}

export interface CreateVmResult {
  created: boolean;
  name: string;
  vmxPath: string;
  disk: string;
  diskDevice: string;
  installIso: string | null;
}

/**
 * Build a VM on disk. Shared by the create_vm tool and the provisioner so both
 * produce byte-identical hardware.
 */
export async function createVmCore(a: CreateVmArgs): Promise<CreateVmResult> {
  const cfg = loadConfig();
  const vmDir = path.join(cfg.vmRoot, a.name);
  assertVmPathAllowed(vmDir);
  if (fs.existsSync(vmDir)) throw new Error(`A VM directory already exists at ${vmDir}.`);

  const diskMb = a.diskGb * 1024;
  const free = freeBytesOn(cfg.vmRoot);
  // Growable disks start small, but refuse if the volume can't plausibly hold it.
  if (free !== null && free < diskMb * 1024 * 1024 * 0.25) {
    throw new Error(
      `Only ${Math.round(free / 1073741824)} GB free on ${cfg.vmRoot}; a ${a.diskGb} GB VM is unsafe here.`,
    );
  }

  fs.mkdirSync(vmDir, { recursive: true });
  const createId = vmcliCreateId(a.guestOsId);
  await vmcli.createVm(a.name, vmDir, createId);

  const vmxPath = findVmxInDir(vmDir);
  if (!vmxPath) throw new Error(`vmcli VM Create did not produce a .vmx in ${vmDir}.`);

  // vmcli VM Create already emits a default 20 GB monolithicSparse <name>.vmdk.
  // Remove it and build one at the requested size so diskGb is honored in both
  // directions — vdiskmanager can only grow, never shrink.
  const vmdkName = `${a.name}.vmdk`;
  for (const f of fs.readdirSync(vmDir)) {
    if (f.toLowerCase().endsWith(".vmdk")) fs.rmSync(path.join(vmDir, f), { force: true });
  }
  const cliAdapter = a.diskAdapter === "sata" || a.diskAdapter === "nvme" ? "lsilogic" : a.diskAdapter;
  await vmcli.createDisk(path.join(vmDir, vmdkName), diskMb, cliAdapter as "ide" | "lsilogic");

  const diskDevice =
    a.diskAdapter === "nvme" ? "nvme0:0"
    : a.diskAdapter === "sata" ? "sata0:0"
    : a.diskAdapter === "ide" ? "ide0:0"
    : "scsi0:0";

  const changes: Record<string, string | null> = {
    displayName: a.name,
    // Restore the guest OS id the caller asked for. vmcli may have been given a
    // stand-in because it accepts only a short list of ids, but the .vmx accepts
    // the full set — and the value matters, since VMware picks default devices
    // and Tools behaviour from it.
    guestOS: a.guestOsId,
    memsize: String(a.memoryMb),
    // vmcli writes a memory.maxsize cap alongside its 512 MB default; leaving it
    // would silently clamp the RAM the caller asked for.
    "memory.maxsize": null,
    numvcpus: String(a.cpus),
    firmware: a.firmware,
    "mks.enable3d": "TRUE",
    "vmci0.present": "TRUE",
    "usb.present": "TRUE",
    "ehci.present": "TRUE",
    "sound.present": "FALSE",
    "floppy0.present": "FALSE",
    // Try the hard disk before the CD. A blank disk is not bootable, so a fresh
    // VM still falls through to the install media; once the OS is installed the
    // VM boots it instead of re-entering the installer on every reboot.
    "bios.bootOrder": "hdd,cdrom",
    "tools.syncTime": "TRUE",
    "tools.upgrade.policy": "manual",
    // The VNC console is how send_keys types at the bootloader and installer,
    // before VMware Tools exists. Enabled on every VM we create so unattended
    // provisioning never has to power-cycle just to turn it on.
    "RemoteDisplay.vnc.enabled": "TRUE",
    "RemoteDisplay.vnc.port": String(allocateVncPort()),
    ...diskEntries({ device: diskDevice, vmdkFileName: vmdkName }),
    ...ethernetEntries(0, a.network as NetworkType, a.customVnet),
  };
  if (a.coresPerSocket) changes["cpuid.coresPerSocket"] = String(a.coresPerSocket);
  if (a.firmware === "efi") changes["uefi.secureBoot.enabled"] = "FALSE";

  let isoResolved: string | undefined;
  if (a.installIso) {
    isoResolved = assertIsoAllowed(
      path.isAbsolute(a.installIso) ? a.installIso : path.join(cfg.isoLibrary, a.installIso),
    );
    Object.assign(changes, cdromEntries({ device: "sata0:1", isoPath: isoResolved }));
    changes["sata0.present"] = "TRUE";
  }

  patchVmx(vmxPath, changes);

  upsertRecord({
    name: a.name,
    vmxPath,
    guestOsId: a.guestOsId,
    osFamily: osFamilyForGuestId(a.guestOsId),
    lifecycle: "created",
    tags: a.tags ?? [],
    installIso: isoResolved,
  });

  return {
    created: true,
    name: a.name,
    vmxPath,
    disk: path.join(vmDir, vmdkName),
    diskDevice,
    installIso: isoResolved ?? null,
  };
}

export function registerLifecycleTools(server: McpServer): void {
  defineTool(
    server,
    "list_isos",
    {
      title: "List install ISOs",
      description:
        "List the install media available in the read-only ISO library (ISO_LIBRARY). These are the ISOs create_vm and provision_vm can attach.",
      inputSchema: {},
      readOnly: true,
    },
    async () => {
      const cfg = loadConfig();
      if (!fs.existsSync(cfg.isoLibrary)) {
        return text(`ISO library ${cfg.isoLibrary} does not exist. Set ISO_LIBRARY.`);
      }
      // Walk subdirectories too: people organise media as iso/windows, iso/linux.
      // `name` stays relative to the library so it can be passed straight back
      // to create_vm / provision_vm.
      const isos: Array<{ name: string; path: string; sizeMb: number }> = [];
      const walk = (dir: string, prefix: string, depth: number) => {
        if (depth > 4) return;
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, d.name);
          const rel = prefix ? `${prefix}/${d.name}` : d.name;
          if (d.isDirectory()) walk(full, rel, depth + 1);
          else if (d.isFile() && d.name.toLowerCase().endsWith(".iso")) {
            isos.push({ name: rel, path: full, sizeMb: Math.round(fs.statSync(full).size / 1048576) });
          }
        }
      };
      walk(cfg.isoLibrary, "", 0);
      isos.sort((a, b) => a.name.localeCompare(b.name));
      return json({ isoLibrary: cfg.isoLibrary, count: isos.length, isos });
    },
  );

  defineTool(
    server,
    "list_vms",
    {
      title: "List VMs",
      description:
        "List every VM this server manages: those recorded in the registry, any VM directory found under VM_ROOT, and each path allowlisted via EXTRA_VM_PATHS. Includes current power state.",
      inputSchema: {},
      readOnly: true,
    },
    async () => {
      const cfg = loadConfig();
      const running = new Set((await vmrun.listRunning()).map((p) => p.toLowerCase()));
      const seen = new Map<string, Record<string, unknown>>();

      for (const rec of listRecords()) {
        seen.set(rec.vmxPath.toLowerCase(), {
          name: rec.name,
          vmxPath: rec.vmxPath,
          guestOsId: rec.guestOsId,
          osFamily: rec.osFamily,
          lifecycle: rec.lifecycle,
          tags: rec.tags,
          credentialRef: rec.credentialRef,
          source: "registry",
          running: running.has(rec.vmxPath.toLowerCase()),
        });
      }

      const scanDirs: string[] = [];
      if (fs.existsSync(cfg.vmRoot)) {
        for (const d of fs.readdirSync(cfg.vmRoot, { withFileTypes: true })) {
          if (d.isDirectory() && !d.name.startsWith(".")) scanDirs.push(path.join(cfg.vmRoot, d.name));
        }
      }
      scanDirs.push(...cfg.extraVmPaths);

      for (const dir of scanDirs) {
        const vmx = dir.toLowerCase().endsWith(".vmx")
          ? (fs.existsSync(dir) ? dir : null)
          : findVmxInDir(dir);
        if (!vmx || seen.has(vmx.toLowerCase())) continue;
        seen.set(vmx.toLowerCase(), {
          name: path.basename(path.dirname(vmx)).replace(/\.vmwarevm$/i, ""),
          vmxPath: vmx,
          lifecycle: "imported",
          source: cfg.extraVmPaths.some((p) => vmx.toLowerCase().startsWith(p.toLowerCase()))
            ? "extraVmPaths"
            : "vmRoot-scan",
          running: running.has(vmx.toLowerCase()),
        });
      }

      const vms = [...seen.values()];
      return json({ vmRoot: cfg.vmRoot, count: vms.length, runningCount: running.size, vms });
    },
  );

  defineTool(
    server,
    "get_vm_info",
    {
      title: "Get VM details",
      description:
        "Full detail for one VM: resolved .vmx path, power state, VMware Tools state, key hardware settings read from the .vmx, snapshots, and registry metadata including provisioning notes.",
      inputSchema: { ...vmArg },
      readOnly: true,
    },
    async ({ vm }) => {
      const vmx = resolveVmxByNameOrPath(vm);
      const cfg = parseVmx(vmx);
      const running = await vmrun.isRunning(vmx);
      const tools = running ? await vmrun.checkToolsState(vmx) : "unknown";
      let snapshots: string[] = [];
      try {
        snapshots = await vmrun.listSnapshots(vmx);
      } catch {
        /* a VM with no snapshot file reports an error; not worth surfacing */
      }
      const rec = listRecords().find((r) => r.vmxPath.toLowerCase() === vmx.toLowerCase());

      const hardware: Record<string, string | undefined> = {
        displayName: cfg.get("displayname"),
        guestOS: cfg.get("guestos"),
        firmware: cfg.get("firmware") ?? "bios",
        memoryMb: cfg.get("memsize"),
        cpus: cfg.get("numvcpus"),
        cores: cfg.get("cpuid.corespersocket"),
      };
      for (const [k, v] of cfg) {
        if (/^(ide|sata|scsi|nvme)\d+:\d+\.(filename|devicetype)$/.test(k)) hardware[k] = v;
        if (/^ethernet\d+\.(connectiontype|vnet|present)$/.test(k)) hardware[k] = v;
      }

      return json({
        vmxPath: vmx,
        running,
        toolsState: tools,
        hardware,
        snapshots,
        registry: rec ?? null,
      });
    },
  );

  defineTool(
    server,
    "create_vm",
    {
      title: "Create a VM from scratch",
      description:
        "Create a new VM under VM_ROOT: builds the .vmx via vmcli, creates a growable virtual disk, sets CPU/RAM/firmware/network, and optionally attaches an install ISO. The VM is left powered off. Use provision_vm instead if you want an unattended OS install end to end.",
      inputSchema: {
        name: z.string().min(1).describe("VM name; becomes the folder name under VM_ROOT"),
        guestOsId: z
          .string()
          .describe(`vmcli guest OS id, e.g. ${GUEST_OS_IDS.slice(0, 4).join(", ")}`),
        memoryMb: z.number().int().min(512).default(4096),
        cpus: z.number().int().min(1).max(32).default(2),
        coresPerSocket: z.number().int().min(1).max(32).optional(),
        diskGb: z.number().int().min(8).default(60),
        diskAdapter: z.enum(["nvme", "lsilogic", "sata", "ide"]).default("nvme"),
        firmware: z.enum(["bios", "efi"]).default("bios"),
        network: z.enum(["nat", "bridged", "hostonly", "custom", "none"]).default("nat"),
        customVnet: z.string().optional().describe('Required when network is "custom", e.g. "VMnet2"'),
        installIso: z
          .string()
          .optional()
          .describe("ISO filename within ISO_LIBRARY, or an absolute path inside it"),
        tags: z.array(z.string()).default([]),
      },
    },
    async (a) => {
      const result = await createVmCore(a as CreateVmArgs);
      return json({
        ...result,
        nextStep: result.installIso
          ? "start_vm to install manually, or provision_vm for an unattended install."
          : "Attach media with configure_vm, then start_vm.",
      });
    },
  );

  defineTool(
    server,
    "configure_vm",
    {
      title: "Reconfigure a VM",
      description:
        "Change hardware on a powered-off VM: CPU, RAM, network type, attach or detach a CD-ROM ISO, or grow the virtual disk. Growing a disk only enlarges the container; the guest filesystem still has to be extended from inside.",
      inputSchema: {
        ...vmArg,
        memoryMb: z.number().int().min(512).optional(),
        cpus: z.number().int().min(1).max(32).optional(),
        network: z.enum(["nat", "bridged", "hostonly", "custom", "none"]).optional(),
        customVnet: z.string().optional(),
        attachIso: z
          .string()
          .optional()
          .describe("ISO filename within ISO_LIBRARY, or absolute path inside it"),
        isoDevice: z.string().default("sata0:1").describe("CD-ROM device slot"),
        detachIso: z.boolean().default(false).describe("Detach the ISO at isoDevice"),
        growDiskGb: z.number().int().min(1).optional().describe("New total disk size in GB"),
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const vmx = resolveVmxByNameOrPath(a.vm);
      if (await vmrun.isRunning(vmx)) {
        throw new Error("VM is running. Stop it before reconfiguring hardware.");
      }

      const changes: Record<string, string | null> = {};
      if (a.memoryMb) changes.memsize = String(a.memoryMb);
      if (a.cpus) changes.numvcpus = String(a.cpus);
      if (a.network) Object.assign(changes, ethernetEntries(0, a.network as NetworkType, a.customVnet));

      if (a.detachIso) {
        const d = a.isoDevice.toLowerCase();
        changes[`${d}.present`] = "FALSE";
        changes[`${d}.filename`] = null;
        changes[`${d}.devicetype`] = null;
        changes[`${d}.startconnected`] = null;
      }
      if (a.attachIso) {
        const iso = assertIsoAllowed(
          path.isAbsolute(a.attachIso) ? a.attachIso : path.join(cfg.isoLibrary, a.attachIso),
        );
        Object.assign(changes, cdromEntries({ device: a.isoDevice, isoPath: iso }));
        changes[`${a.isoDevice.split(":")[0].toLowerCase()}.present`] = "TRUE";
      }

      const grown: string[] = [];
      if (a.growDiskGb) {
        const parsed = parseVmx(vmx);
        const vmDir = path.dirname(vmx);
        for (const [k, v] of parsed) {
          if (/^(nvme|scsi|sata|ide)\d+:\d+\.filename$/.test(k) && v.toLowerCase().endsWith(".vmdk")) {
            const disk = path.isAbsolute(v) ? v : path.join(vmDir, v);
            const { run } = await import("../exec.js");
            await run(cfg.vdiskmanager, ["-x", `${a.growDiskGb}GB`, disk], { timeoutMs: 60 * 60_000 });
            grown.push(disk);
            break; // only the first/boot disk
          }
        }
        if (grown.length === 0) throw new Error("No .vmdk found in the .vmx to grow.");
      }

      if (Object.keys(changes).length > 0) patchVmx(vmx, changes);
      return json({ vmxPath: vmx, applied: Object.keys(changes), grownDisks: grown });
    },
  );

  defineTool(
    server,
    "delete_vm",
    {
      title: "Delete a VM",
      description:
        "Permanently delete a VM and every file in its directory. Irreversible. Requires confirm: true and refuses any VM outside VM_ROOT.",
      inputSchema: { ...vmArg, ...confirmArg },
      destructive: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      requireConfirm(a.confirm, `deleting ${vmx}`);

      const cfg = loadConfig();
      const vmDir = path.dirname(vmx);
      // deleteVM must never reach an EXTRA_VM_PATHS entry or the ISO library.
      const rel = path.relative(cfg.vmRoot, vmDir);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(
          `Refusing to delete ${vmDir}: delete_vm only operates on VMs inside VM_ROOT (${cfg.vmRoot}), never on EXTRA_VM_PATHS entries.`,
        );
      }

      if (await vmrun.isRunning(vmx)) await vmrun.stop(vmx, "hard").catch(() => undefined);
      await vmrun.deleteVM(vmx).catch(() => undefined);
      if (fs.existsSync(vmDir)) fs.rmSync(vmDir, { recursive: true, force: true });

      const rec = listRecords().find((r) => r.vmxPath.toLowerCase() === vmx.toLowerCase());
      if (rec) removeRecord(rec.name);

      return text(`Deleted ${vmDir}`);
    },
  );

  defineTool(
    server,
    "register_vm",
    {
      title: "Register an existing VM",
      description:
        "Add an already-existing VM to the registry so it can carry tags, a credential reference, and take part in fleet_* operations. Does not modify the VM.",
      inputSchema: {
        ...vmArg,
        name: z.string().optional().describe("Registry name; defaults to the VM folder name"),
        guestOsId: z.string().optional(),
        credentialRef: z.string().optional(),
        tags: z.array(z.string()).default([]),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const parsed = parseVmx(vmx);
      // Read the family from the .vmx rather than defaulting to "other": an
      // "other" family is treated as Linux downstream, so a Windows VM adopted
      // this way was handed /bin/bash by guest_exec_capture and fleet_run (#24).
      const guestOsId = a.guestOsId ?? parsed.get("guestos") ?? "other";
      const name =
        a.name ?? parsed.get("displayname") ?? path.basename(path.dirname(vmx)).replace(/\.vmwarevm$/i, "");

      const existing = getRecord(name);
      const rec = existing
        ? updateRecord(name, { vmxPath: vmx, credentialRef: a.credentialRef ?? existing.credentialRef, tags: a.tags.length ? a.tags : existing.tags })
        : upsertRecord({
            name,
            vmxPath: vmx,
            guestOsId,
            osFamily: osFamilyForGuestId(guestOsId),
            lifecycle: "imported",
            credentialRef: a.credentialRef,
            tags: a.tags,
          });

      return json({ registered: rec });
    },
  );
}
