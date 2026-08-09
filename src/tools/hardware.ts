import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { assertHostPathAllowed, assertVmPathAllowed, resolveVmxByNameOrPath } from "../paths.js";
import { run } from "../exec.js";
import * as vmrun from "../vmrun.js";
import { ethernetEntries, parseVmx, patchVmx, findVmxInDir, type NetworkType } from "../vmx.js";
import { listRecords, upsertRecord } from "../registry.js";
import { osFamilyForGuestId } from "./lifecycle.js";
import { allocateVncPort } from "./screen.js";
import { defineTool, json, text, vmArg } from "./common.js";

/** ovftool ships beside Workstation; it is what makes OVF import/export possible. */
function ovftoolPath(): string {
  const cfg = loadConfig();
  const candidates = [
    path.join(cfg.vmwareDir, "OVFTool", "ovftool.exe"),
    path.join(cfg.vmwareDir, "ovftool.exe"),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `ovftool not found (looked in ${candidates.join(", ")}). It normally ships with VMware Workstation.`,
    );
  }
  return found;
}

async function assertPoweredOff(vmx: string, what: string): Promise<void> {
  if (await vmrun.isRunning(vmx)) {
    throw new Error(
      `VM is running. Power it off before ${what} — .vmx edits made while a VM runs are discarded when VMware rewrites the file at power-off.`,
    );
  }
}

export function registerHardwareTools(server: McpServer): void {
  // ---------------------------------------------------------------- NICs

  defineTool(
    server,
    "add_network_adapter",
    {
      title: "Add a network adapter",
      description:
        "Add another NIC to a VM. create_vm wires only ethernet0, so this is how you build a router, firewall or dual-homed lab machine — for example one NAT adapter for internet access plus a host-only adapter for an isolated victim network. The VM must be powered off.",
      inputSchema: {
        ...vmArg,
        network: z.enum(["nat", "bridged", "hostonly", "custom"]),
        customVnet: z.string().optional().describe('Required for "custom", e.g. "VMnet2"'),
        index: z
          .number()
          .int()
          .min(0)
          .max(9)
          .optional()
          .describe("Adapter slot. Defaults to the next free one."),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertPoweredOff(vmx, "changing network adapters");

      const cfg = parseVmx(vmx);
      let index = a.index;
      if (index === undefined) {
        index = 0;
        while (cfg.get(`ethernet${index}.present`)?.toUpperCase() === "TRUE" && index < 10) index++;
        if (index >= 10) throw new Error("All ten adapter slots are already in use.");
      }
      patchVmx(vmx, ethernetEntries(index, a.network as NetworkType, a.customVnet));
      return json({
        vmxPath: vmx,
        adapter: `ethernet${index}`,
        network: a.network,
        vnet: a.customVnet ?? null,
      });
    },
  );

  defineTool(
    server,
    "remove_network_adapter",
    {
      title: "Remove a network adapter",
      description: "Detach a NIC from a powered-off VM.",
      inputSchema: { ...vmArg, index: z.number().int().min(0).max(9) },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertPoweredOff(vmx, "changing network adapters");
      const cfg = parseVmx(vmx);
      const prefix = `ethernet${a.index}.`;
      const changes: Record<string, string | null> = {};
      for (const key of cfg.keys()) if (key.startsWith(prefix)) changes[key] = null;
      if (Object.keys(changes).length === 0) throw new Error(`ethernet${a.index} is not configured on this VM.`);
      patchVmx(vmx, changes);
      return text(`Removed ethernet${a.index} from ${vmx}.`);
    },
  );

  defineTool(
    server,
    "list_network_adapters",
    {
      title: "List a VM's network adapters",
      description: "Show every configured NIC with its connection type and vnet.",
      inputSchema: { ...vmArg },
      readOnly: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const cfg = parseVmx(vmx);
      const adapters: Array<Record<string, string | undefined>> = [];
      for (let i = 0; i < 10; i++) {
        if (cfg.get(`ethernet${i}.present`)?.toUpperCase() !== "TRUE") continue;
        adapters.push({
          adapter: `ethernet${i}`,
          connectionType: cfg.get(`ethernet${i}.connectiontype`),
          vnet: cfg.get(`ethernet${i}.vnet`),
          virtualDev: cfg.get(`ethernet${i}.virtualdev`),
          address: cfg.get(`ethernet${i}.generatedaddress`) ?? cfg.get(`ethernet${i}.address`),
        });
      }
      return json({ vmxPath: vmx, count: adapters.length, adapters });
    },
  );

  // ---------------------------------------------------------------- hot-add

  defineTool(
    server,
    "set_hotadd",
    {
      title: "Enable CPU/memory hot-add",
      description:
        "Allow CPU or memory to be added while the VM is running. The flags only take effect from the next power-on, and guest support varies — Windows Server handles both, most desktop editions only memory. Enabling hot-add also disables some other features, notably nested virtualisation for CPU hot-add.",
      inputSchema: {
        ...vmArg,
        cpu: z.boolean().default(false),
        memory: z.boolean().default(true),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertPoweredOff(vmx, "changing hot-add settings");
      patchVmx(vmx, {
        "vcpu.hotadd": a.cpu ? "TRUE" : "FALSE",
        "mem.hotadd": a.memory ? "TRUE" : "FALSE",
      });
      return json({
        vmxPath: vmx,
        cpuHotAdd: a.cpu,
        memoryHotAdd: a.memory,
        note: "Takes effect at the next power-on.",
      });
    },
  );

  // ---------------------------------------------------------------- USB

  defineTool(
    server,
    "set_usb",
    {
      title: "Configure the USB controller",
      description:
        "Enable or disable the VM's USB controller and choose its generation. Note the limitation: VMware Workstation has no command-line way to bind a *specific* host USB device to a VM — that is a UI action. This sets up the controller and optional auto-connect so a device attached while the VM has focus is passed through.",
      inputSchema: {
        ...vmArg,
        enabled: z.boolean().default(true),
        generation: z.enum(["2.0", "3.1"]).default("3.1"),
        autoConnect: z
          .boolean()
          .default(false)
          .describe("Automatically pass through devices plugged in while this VM is running"),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertPoweredOff(vmx, "changing USB settings");
      patchVmx(vmx, {
        "usb.present": a.enabled ? "TRUE" : "FALSE",
        "ehci.present": a.enabled && a.generation === "2.0" ? "TRUE" : "FALSE",
        "usb_xhci.present": a.enabled && a.generation === "3.1" ? "TRUE" : "FALSE",
        "usb.generic.autoconnect": a.autoConnect ? "TRUE" : "FALSE",
      });
      return json({
        vmxPath: vmx,
        usb: a.enabled ? a.generation : "disabled",
        autoConnect: a.autoConnect,
        limitation:
          "Binding a named host device from the command line is not supported by Workstation; attach it from the VM window instead.",
      });
    },
  );

  // ---------------------------------------------------------------- OVF

  defineTool(
    server,
    "export_ovf",
    {
      title: "Export a VM to OVF/OVA",
      description:
        "Export a VM to a portable OVF directory or a single OVA file, so it can be moved to another host or another hypervisor. Uses ovftool, which ships with Workstation. The VM must be powered off, and export takes as long as the disk is large.",
      inputSchema: {
        ...vmArg,
        destination: z.string().describe("Host path for the output; must be inside an allowed host directory"),
        format: z.enum(["ova", "ovf"]).default("ova"),
        compress: z.number().int().min(0).max(9).default(0).describe("0 disables compression; 1-9 trade CPU for size"),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertPoweredOff(vmx, "exporting");
      const dest = assertHostPathAllowed(a.destination, "write");
      fs.mkdirSync(path.dirname(dest), { recursive: true });

      const argv = ["--acceptAllEulas", "--noSSLVerify"];
      if (a.compress > 0) argv.push(`--compress=${a.compress}`);
      if (a.format === "ova" && !dest.toLowerCase().endsWith(".ova")) {
        throw new Error("For format 'ova' the destination should end in .ova");
      }
      argv.push(vmx, dest);

      const r = await run(ovftoolPath(), argv, { timeoutMs: 4 * 60 * 60_000, allowFailure: true });
      const ok = fs.existsSync(dest);
      if (!ok) {
        throw new Error(`ovftool did not produce ${dest}. Output: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
      }
      const size = fs.statSync(dest).isDirectory() ? 0 : fs.statSync(dest).size;
      return json({
        source: vmx,
        destination: dest,
        format: a.format,
        sizeMb: Math.round(size / 1048576),
      });
    },
  );

  defineTool(
    server,
    "import_ovf",
    {
      title: "Import an OVF/OVA as a new VM",
      description:
        "Create a VM from an OVF or OVA produced by VMware, VirtualBox or another tool. The result lands under VM_ROOT and is added to the registry so the guest_* and fleet_* tools can drive it.",
      inputSchema: {
        source: z.string().describe("Host path to the .ova or .ovf"),
        name: z.string().min(1).describe("Name for the imported VM"),
        tags: z.array(z.string()).default([]),
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const src = assertHostPathAllowed(a.source, "read");
      if (!fs.existsSync(src)) throw new Error(`No such file: ${src}`);

      const destDir = path.join(cfg.vmRoot, a.name);
      assertVmPathAllowed(destDir);
      if (fs.existsSync(destDir)) throw new Error(`A VM directory already exists at ${destDir}.`);

      // Name the .vmx target explicitly. Handed a bare directory, ovftool nests
      // the result as <dir>/<name>/<name>.vmx, which is not where anything else
      // expects to find it.
      const r = await run(
        ovftoolPath(),
        ["--acceptAllEulas", "--noSSLVerify", `--name=${a.name}`, src, path.join(destDir, `${a.name}.vmx`)],
        { timeoutMs: 4 * 60 * 60_000, allowFailure: true },
      );

      // ovftool nests its output as <dir>/<name>/<name>.vmx even when handed an
      // explicit .vmx target. Flatten it, so an imported VM sits at
      // VM_ROOT/<name>/<name>.vmx like every other VM and resolves by name.
      const nested = path.join(destDir, a.name);
      if (!findVmxInDir(destDir) && fs.existsSync(nested) && findVmxInDir(nested)) {
        for (const entry of fs.readdirSync(nested)) {
          fs.renameSync(path.join(nested, entry), path.join(destDir, entry));
        }
        fs.rmSync(nested, { recursive: true, force: true });
      }

      const vmxPath = findVmxInDir(destDir);
      if (!vmxPath) {
        throw new Error(`ovftool did not produce a .vmx in ${destDir}. Output: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
      }

      // Imported VMs have no console enabled, so send_keys would not work on them.
      patchVmx(vmxPath, {
        "RemoteDisplay.vnc.enabled": "TRUE",
        "RemoteDisplay.vnc.port": String(allocateVncPort()),
      });

      const guestOsId = parseVmx(vmxPath).get("guestos") ?? "other";
      upsertRecord({
        name: a.name,
        vmxPath,
        guestOsId,
        osFamily: osFamilyForGuestId(guestOsId),
        lifecycle: "imported",
        tags: a.tags,
      });
      return json({ name: a.name, vmxPath, guestOsId, source: src });
    },
  );

  // ---------------------------------------------------------------- encryption

  defineTool(
    server,
    "set_vm_password",
    {
      title: "Supply the password for an encrypted VM",
      description:
        "Register the encryption password for a VM whose files are encrypted, so vmrun operations against it can authenticate. Held in memory for this server session only — it is never written to disk. Re-supply it after a restart.",
      inputSchema: {
        ...vmArg,
        vmPassword: z.string().describe("The VM's encryption password"),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      vmrun.setVmPassword(vmx, a.vmPassword);
      const encrypted = parseVmx(vmx).get("encryption.keysafe") !== undefined;
      return json({
        vmxPath: vmx,
        stored: true,
        looksEncrypted: encrypted,
        note: encrypted
          ? "Password registered for this session; vmrun calls will now pass -vp."
          : "Password registered, but this .vmx shows no encryption keys — check you meant this VM.",
      });
    },
  );
}
