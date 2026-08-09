import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { resolveVmxByNameOrPath } from "../paths.js";
import { clearStaleLocks } from "../vmx.js";
import path from "node:path";
import * as vmrun from "../vmrun.js";
import { defineTool, json, text, vmArg } from "./common.js";

/** Poll until a predicate holds or the deadline passes. Used for tools/boot waits. */
export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (v: T) => boolean,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<{ ok: boolean; last: T; elapsedMs: number }> {
  const started = Date.now();
  let last = await probe();
  while (!done(last)) {
    if (Date.now() - started > opts.timeoutMs) return { ok: false, last, elapsedMs: Date.now() - started };
    await new Promise((r) => setTimeout(r, opts.intervalMs));
    last = await probe();
  }
  return { ok: true, last, elapsedMs: Date.now() - started };
}

export function registerPowerTools(server: McpServer): void {
  defineTool(
    server,
    "start_vm",
    {
      title: "Power on a VM",
      description:
        'Power on a VM. mode "nogui" runs it headless in the background; "gui" opens the Workstation window, which you need if you plan to watch the console or send MKS keystrokes during an OS install.',
      inputSchema: {
        ...vmArg,
        mode: z.enum(["gui", "nogui"]).default("nogui"),
        waitForTools: z.boolean().default(false).describe("Block until VMware Tools reports running"),
        toolsTimeoutSec: z.number().int().min(10).max(3600).default(300),
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const vmx = resolveVmxByNameOrPath(a.vm);

      const running = await vmrun.listRunning();
      if (running.some((p) => p.toLowerCase() === vmx.toLowerCase())) {
        return text(`${vmx} is already running.`);
      }
      if (running.length >= cfg.maxRunningVms) {
        throw new Error(
          `${running.length} VMs are already running (max ${cfg.maxRunningVms}). Stop one or raise VMWARE_MCP_MAX_RUNNING_VMS.`,
        );
      }

      // Clear any lock left by a previous run that was killed; safe because the
      // VM is confirmed absent from vmrun's running list above.
      const cleared = clearStaleLocks(path.dirname(vmx));
      await vmrun.start(vmx, a.mode);

      if (!a.waitForTools) return text(`Started ${vmx} (${a.mode}).`);

      const r = await waitFor(
        () => vmrun.checkToolsState(vmx),
        (s) => s === "running",
        { timeoutMs: a.toolsTimeoutSec * 1000, intervalMs: 5000 },
      );
      return json({
        started: true,
        vmxPath: vmx,
        mode: a.mode,
        toolsRunning: r.ok,
        toolsState: r.last,
        waitedMs: r.elapsedMs,
      });
    },
  );

  defineTool(
    server,
    "stop_vm",
    {
      title: "Power off a VM",
      description:
        'Power off a VM. "soft" asks the guest to shut down cleanly via VMware Tools and needs Tools running; "hard" is the equivalent of pulling the plug.',
      inputSchema: { ...vmArg, mode: z.enum(["soft", "hard"]).default("soft") },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      if (!(await vmrun.isRunning(vmx))) return text(`${vmx} is already powered off.`);
      await vmrun.stop(vmx, a.mode);
      return text(`Stopped ${vmx} (${a.mode}).`);
    },
  );

  defineTool(
    server,
    "reset_vm",
    {
      title: "Reset a VM",
      description: "Restart a running VM. Soft reset asks the guest to reboot; hard reset is a virtual reset button.",
      inputSchema: { ...vmArg, mode: z.enum(["soft", "hard"]).default("soft") },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await vmrun.reset(vmx, a.mode);
      return text(`Reset ${vmx} (${a.mode}).`);
    },
  );

  defineTool(
    server,
    "suspend_vm",
    {
      title: "Suspend a VM",
      description: "Suspend a running VM to disk, preserving its exact state. start_vm resumes it.",
      inputSchema: { ...vmArg, mode: z.enum(["soft", "hard"]).default("soft") },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await vmrun.suspend(vmx, a.mode);
      return text(`Suspended ${vmx}.`);
    },
  );

  defineTool(
    server,
    "wait_for_tools",
    {
      title: "Wait for VMware Tools",
      description:
        "Block until VMware Tools reports running inside the guest. Tools running is the precondition for every guest_* tool, so this is the standard gate after a boot or a snapshot revert.",
      inputSchema: {
        ...vmArg,
        timeoutSec: z.number().int().min(10).max(7200).default(600),
      },
      readOnly: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const r = await waitFor(
        () => vmrun.checkToolsState(vmx),
        (s) => s === "running",
        { timeoutMs: a.timeoutSec * 1000, intervalMs: 5000 },
      );
      if (!r.ok) {
        throw new Error(
          `VMware Tools did not come up within ${a.timeoutSec}s (last state: ${r.last}). If the OS is still installing this is expected; if the guest is at a desktop, Tools may not be installed.`,
        );
      }
      return json({ toolsState: r.last, waitedMs: r.elapsedMs });
    },
  );

  defineTool(
    server,
    "install_tools",
    {
      title: "Install VMware Tools",
      description:
        "Mount the VMware Tools installer in the running guest. On Windows this attaches the Tools ISO and the installer must then be run inside the guest; on Linux prefer installing open-vm-tools from the distro's package manager via guest_run.",
      inputSchema: { ...vmArg },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await vmrun.installTools(vmx);
      return text(`Requested VMware Tools install for ${vmx}. The Tools ISO is now mounted in the guest.`);
    },
  );
}
