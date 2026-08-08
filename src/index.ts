#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { preflightStorage } from "./paths.js";
import { removableStorageWarnings } from "./storage.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerPowerTools } from "./tools/power.js";
import { registerSnapshotTools } from "./tools/snapshots.js";
import { registerGuestTools } from "./tools/guest.js";
import { registerScreenTools } from "./tools/screen.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerProvisionTools } from "./tools/provision.js";
import { registerFleetTools } from "./tools/fleet.js";

async function main(): Promise<void> {
  // Fail fast and loudly if VMware isn't where we think it is — a broken config
  // is far easier to diagnose here than as 30 identical tool errors later.
  const cfg = loadConfig();

  const server = new McpServer(
    { name: "vmware-mcp", version: "0.1.0" },
    {
      instructions: [
        "Controls VMware Workstation 17 Pro on this host.",
        `VMs live under ${cfg.vmRoot}; install ISOs are read from ${cfg.isoLibrary}.`,
        "Guest operations (guest_*) require VMware Tools running in the guest and valid guest credentials.",
        "Destructive tools (delete_vm, snapshot_revert, snapshot_delete) refuse to run without confirm: true.",
      ].join(" "),
    },
  );

  registerLifecycleTools(server);
  registerPowerTools(server);
  registerSnapshotTools(server);
  registerGuestTools(server);
  registerScreenTools(server);
  registerNetworkTools(server);
  registerProvisionTools(server);
  registerFleetTools(server);

  await server.connect(new StdioServerTransport());

  // stdout is the MCP transport — diagnostics must go to stderr.
  process.stderr.write(
    `vmware-mcp ready | vmware=${cfg.vmwareDir} | vmRoot=${cfg.vmRoot} | isoLibrary=${cfg.isoLibrary}\n`,
  );

  // Storage problems here fail slowly and misleadingly — a bad VM_ROOT surfaces
  // as vmcli's opaque "Create VM failed", and a USB drive as a guest I/O error
  // 40 minutes into an install. Say so up front instead.
  const { errors, warnings } = preflightStorage();
  for (const e of errors) process.stderr.write(`vmware-mcp ERROR: ${e}\n`);
  for (const w of warnings) process.stderr.write(`vmware-mcp WARNING: ${w}\n`);

  // Bus detection shells out, so it must not delay the server accepting requests.
  void removableStorageWarnings([
    { label: "VM_ROOT", dir: cfg.vmRoot },
    { label: "ISO_LIBRARY", dir: cfg.isoLibrary },
  ]).then((ws) => {
    for (const w of ws) process.stderr.write(`vmware-mcp WARNING: ${w}\n`);
  });
}

main().catch((e: unknown) => {
  process.stderr.write(`vmware-mcp failed to start: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
