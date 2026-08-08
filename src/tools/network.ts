import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { resolveVmxByNameOrPath } from "../paths.js";
import * as vmrun from "../vmrun.js";
import { parseVmx, patchVmx, ethernetEntries, type NetworkType } from "../vmx.js";
import { defineTool, json, text, vmArg } from "./common.js";

export function registerNetworkTools(server: McpServer): void {
  defineTool(
    server,
    "get_guest_ip",
    {
      title: "Get the guest IP address",
      description:
        "Read the guest's IP address via VMware Tools. Set wait to block until the guest has actually obtained an address, which is useful right after a boot.",
      inputSchema: {
        ...vmArg,
        wait: z.boolean().default(false),
      },
      readOnly: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const ip = await vmrun.getGuestIPAddress(vmx, a.wait);
      if (!ip) {
        throw new Error(
          "No IP available. The guest must be running with VMware Tools installed and a connected network adapter.",
        );
      }
      return json({ vmxPath: vmx, ip });
    },
  );

  defineTool(
    server,
    "set_network",
    {
      title: "Set the VM's network mode",
      description:
        'Change a VM\'s network adapter mode. "nat" shares the host\'s connection (the default, best for internet access from an isolated guest); "bridged" puts the VM directly on the physical LAN; "hostonly" isolates it to a private network with the host only — the right choice for a malware or exploit lab; "none" disconnects it entirely. The VM must be powered off.',
      inputSchema: {
        ...vmArg,
        mode: z.enum(["nat", "bridged", "hostonly", "custom", "none"]),
        customVnet: z.string().optional().describe('Required for "custom", e.g. "VMnet2"'),
        adapterIndex: z.number().int().min(0).max(9).default(0),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      if (await vmrun.isRunning(vmx)) {
        throw new Error("VM is running. Power it off before changing the network mode.");
      }
      patchVmx(vmx, ethernetEntries(a.adapterIndex, a.mode as NetworkType, a.customVnet));
      return text(`ethernet${a.adapterIndex} set to ${a.mode}${a.customVnet ? ` (${a.customVnet})` : ""}.`);
    },
  );

  defineTool(
    server,
    "list_host_networks",
    {
      title: "List host virtual networks",
      description:
        "List the host's VMware virtual networks (VMnet0, VMnet1, VMnet8, …) with their types and subnets. Use this to find the host-side gateway address, which is what a guest must reach to talk to a service running on the host.",
      inputSchema: {},
      readOnly: true,
    },
    async () => {
      const r = await vmrun.vmrun(["listHostNetworks"], { allowFailure: true });
      return text(r.stdout.trim() || r.stderr.trim() || "(no output)");
    },
  );

  defineTool(
    server,
    "add_shared_folder",
    {
      title: "Share a host folder with the guest",
      description:
        "Expose a host directory inside the guest. On Windows guests it appears under \\\\vmware-host\\Shared Folders; on Linux guests it mounts under /mnt/hgfs once open-vm-tools is installed. Shared folders are enabled on the VM as part of this call.",
      inputSchema: {
        ...vmArg,
        shareName: z.string().min(1),
        hostPath: z.string().describe("Absolute host directory to share"),
        writable: z.boolean().default(true),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const host = path.resolve(a.hostPath);
      if (!fs.existsSync(host) || !fs.statSync(host).isDirectory()) {
        throw new Error(`Not a directory on the host: ${host}`);
      }
      await vmrun.enableSharedFolders(vmx).catch(() => undefined);
      await vmrun.addSharedFolder(vmx, a.shareName, host);
      if (!a.writable) {
        await vmrun.setSharedFolderState(vmx, a.shareName, host, "readonly").catch(() => undefined);
      }
      return text(`Shared ${host} as "${a.shareName}" (${a.writable ? "writable" : "read-only"}).`);
    },
  );

  defineTool(
    server,
    "remove_shared_folder",
    {
      title: "Remove a shared folder",
      description: "Stop sharing a host folder with the guest.",
      inputSchema: { ...vmArg, shareName: z.string().min(1) },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await vmrun.removeSharedFolder(vmx, a.shareName);
      return text(`Removed shared folder "${a.shareName}".`);
    },
  );

  defineTool(
    server,
    "disable_shared_folders",
    {
      title: "Disable shared folders",
      description:
        "Disable all shared folders for a VM. Folders remain configured but are no longer accessible from the guest.",
      inputSchema: { ...vmArg },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await vmrun.disableSharedFolders(vmx);
      return text(`Disabled shared folders for ${vmx}.`);
    },
  );

  defineTool(
    server,
    "set_shared_folder_state",
    {
      title: "Change a shared folder's access mode",
      description:
        "Set a shared folder to writable or read-only mode.",
      inputSchema: {
        ...vmArg,
        shareName: z.string().min(1),
        hostPath: z.string().describe("Absolute host directory path for the share"),
        mode: z.enum(["writable", "readonly"]),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await vmrun.setSharedFolderState(vmx, a.shareName, path.resolve(a.hostPath), a.mode);
      return text(`Set shared folder "${a.shareName}" to ${a.mode}.`);
    },
  );

  defineTool(
    server,
    "list_shared_folders",
    {
      title: "List shared folders",
      description: "List the host folders shared with this VM, as recorded in its .vmx.",
      inputSchema: { ...vmArg },
      readOnly: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const cfg = parseVmx(vmx);
      const count = Number(cfg.get("sharedfolder.maxnum") ?? "0");
      const shares: Array<Record<string, string | undefined>> = [];
      for (let i = 0; i < count; i++) {
        if (cfg.get(`sharedfolder${i}.present`)?.toUpperCase() !== "TRUE") continue;
        shares.push({
          name: cfg.get(`sharedfolder${i}.guestname`),
          hostPath: cfg.get(`sharedfolder${i}.hostpath`),
          writable: cfg.get(`sharedfolder${i}.writeaccess`),
          enabled: cfg.get(`sharedfolder${i}.enabled`),
        });
      }
      return json({ enabled: cfg.get("isolation.tools.hgfs.disable") !== "TRUE", count: shares.length, shares });
    },
  );

  defineTool(
    server,
    "set_port_forward",
    {
      title: "Forward a host port to a guest",
      description:
        "Add a NAT port forward so a service inside the guest is reachable from the host. Applies to the host network (usually VMnet8 for NAT) rather than to a specific VM, so the guest IP must be given explicitly.",
      inputSchema: {
        hostNetwork: z.string().default("vmnet8"),
        protocol: z.enum(["tcp", "udp"]).default("tcp"),
        hostPort: z.number().int().min(1).max(65535),
        guestIp: z.string(),
        guestPort: z.number().int().min(1).max(65535),
        description: z.string().optional(),
      },
    },
    async (a) => {
      const argv = [
        "setPortForwarding",
        a.hostNetwork,
        a.protocol,
        String(a.hostPort),
        a.guestIp,
        String(a.guestPort),
      ];
      if (a.description) argv.push(a.description);
      await vmrun.vmrun(argv);
      return text(
        `Forwarding ${a.hostNetwork} ${a.protocol} host:${a.hostPort} → ${a.guestIp}:${a.guestPort}.`,
      );
    },
  );

  defineTool(
    server,
    "list_port_forwards",
    {
      title: "List NAT port forwards",
      description: "List the port forwards configured on a host virtual network.",
      inputSchema: { hostNetwork: z.string().default("vmnet8") },
      readOnly: true,
    },
    async (a) => {
      const r = await vmrun.vmrun(["listPortForwardings", a.hostNetwork], { allowFailure: true });
      return text(r.stdout.trim() || r.stderr.trim() || "(none)");
    },
  );

  defineTool(
    server,
    "get_host_gateway_ip",
    {
      title: "Get the host's IP on a virtual network",
      description:
        "Return the host-side gateway address for a VMware virtual network — the address a guest uses to reach a service running on the host. Provisioning uses this to serve preseed files to Linux installers.",
      inputSchema: { hostNetwork: z.string().default("vmnet8") },
      readOnly: true,
    },
    async (a) => {
      const ip = await hostGatewayIp(a.hostNetwork);
      if (!ip) throw new Error(`Could not determine the host address on ${a.hostNetwork}.`);
      return json({ hostNetwork: a.hostNetwork, hostIp: ip });
    },
  );
}

/**
 * Find the host's address on a vmnet. Read from Workstation's own netmap/vmnetdhcp
 * config where possible, falling back to enumerating the host's VMware adapters.
 */
export async function hostGatewayIp(hostNetwork = "vmnet8"): Promise<string | null> {
  const vnet = hostNetwork.toLowerCase();

  // vmnetdhcp.conf records the subnet; the host is conventionally .1
  const dhcpConf = path.join(process.env.ProgramData ?? "C:\\ProgramData", "VMware", "vmnetdhcp.conf");
  if (fs.existsSync(dhcpConf)) {
    const txt = fs.readFileSync(dhcpConf, "utf8");
    const rx = new RegExp(`#\\s*${vnet}[\\s\\S]*?subnet\\s+(\\d+\\.\\d+\\.\\d+)\\.0`, "i");
    const m = rx.exec(txt);
    if (m) return `${m[1]}.1`;
  }

  const os = await import("node:os");
  const ifaces = os.networkInterfaces();
  const wanted = vnet.replace("vmnet", "");
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!/vmware|vmnet/i.test(name)) continue;
    if (wanted && !name.includes(wanted)) continue;
    const v4 = addrs?.find((x) => x.family === "IPv4" && !x.internal);
    if (v4) return v4.address;
  }
  return null;
}

/** Wrap loadConfig so this module keeps a single import surface for tests. */
export { loadConfig };
