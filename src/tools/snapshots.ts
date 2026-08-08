import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveVmxByNameOrPath } from "../paths.js";
import * as vmrun from "../vmrun.js";
import { confirmArg, defineTool, json, requireConfirm, text, vmArg } from "./common.js";

export function registerSnapshotTools(server: McpServer): void {
  defineTool(
    server,
    "snapshot_list",
    {
      title: "List snapshots",
      description: "List a VM's snapshots. Pass showTree to see the parent/child hierarchy.",
      inputSchema: { ...vmArg, showTree: z.boolean().default(false) },
      readOnly: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const snaps = await vmrun.listSnapshots(vmx, a.showTree);
      return json({ vmxPath: vmx, count: snaps.length, snapshots: snaps });
    },
  );

  defineTool(
    server,
    "snapshot_create",
    {
      title: "Create a snapshot",
      description:
        "Take a snapshot. Works on a running or powered-off VM; snapshotting a running VM also captures its memory, which is slower but resumes instantly.",
      inputSchema: { ...vmArg, name: z.string().min(1).describe("Snapshot name") },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await vmrun.snapshot(vmx, a.name);
      return text(`Created snapshot "${a.name}" on ${vmx}.`);
    },
  );

  defineTool(
    server,
    "snapshot_revert",
    {
      title: "Revert to a snapshot",
      description:
        "Roll the VM back to a snapshot. Every change made since that snapshot is discarded. Requires confirm: true.",
      inputSchema: { ...vmArg, name: z.string().min(1), ...confirmArg },
      destructive: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      requireConfirm(a.confirm, `reverting ${vmx} to snapshot "${a.name}" (discards all newer state)`);
      await vmrun.revertToSnapshot(vmx, a.name);
      return text(`Reverted ${vmx} to "${a.name}". The VM is now powered off or at the snapshot's power state.`);
    },
  );

  defineTool(
    server,
    "snapshot_delete",
    {
      title: "Delete a snapshot",
      description:
        "Delete a snapshot, merging its data into the parent. The VM's current state is unaffected. Requires confirm: true.",
      inputSchema: {
        ...vmArg,
        name: z.string().min(1),
        andDeleteChildren: z.boolean().default(false),
        ...confirmArg,
      },
      destructive: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      requireConfirm(a.confirm, `deleting snapshot "${a.name}" from ${vmx}`);
      await vmrun.deleteSnapshot(vmx, a.name, a.andDeleteChildren);
      return text(`Deleted snapshot "${a.name}" from ${vmx}.`);
    },
  );
}
