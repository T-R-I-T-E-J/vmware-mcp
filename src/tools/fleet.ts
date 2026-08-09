import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, resolveCredential } from "../config.js";
import { selectRecords, type VmRecord } from "../registry.js";
import * as vmrun from "../vmrun.js";
import { runFleet } from "../fleet.js";
import { guestIsWindows } from "./guest.js";
import { confirmArg, credArgs, defineTool, json, requireConfirm } from "./common.js";

const selectorArg = {
  selector: z
    .string()
    .describe(
      'Which VMs to act on: an exact name, a glob like "win*", "tag:lab" to match a tag, or "*" for every registered VM',
    ),
};

function resolveSelection(selector: string): VmRecord[] {
  const recs = selectRecords(selector);
  if (recs.length === 0) {
    throw new Error(
      `Selector "${selector}" matched no registered VMs. Only VMs in the registry take part in fleet operations — add one with register_vm.`,
    );
  }
  return recs;
}

export function registerFleetTools(server: McpServer): void {
  defineTool(
    server,
    "fleet_status",
    {
      title: "Status of many VMs",
      description:
        "Report power state, VMware Tools state, and lifecycle for every VM matching a selector. The starting point for any fleet operation.",
      inputSchema: { ...selectorArg },
      readOnly: true,
    },
    async (a) => {
      const recs = resolveSelection(a.selector);
      const running = new Set((await vmrun.listRunning()).map((p) => p.toLowerCase()));
      const rows = await Promise.all(
        recs.map(async (r) => {
          const isUp = running.has(r.vmxPath.toLowerCase());
          return {
            name: r.name,
            lifecycle: r.lifecycle,
            tags: r.tags,
            running: isUp,
            toolsState: isUp ? await vmrun.checkToolsState(r.vmxPath) : "poweredOff",
          };
        }),
      );
      return json({
        selector: a.selector,
        matched: rows.length,
        running: rows.filter((r) => r.running).length,
        vms: rows,
      });
    },
  );

  defineTool(
    server,
    "fleet_start",
    {
      title: "Start many VMs",
      description:
        "Power on every VM matching the selector, a few at a time. Respects the host's max-running-VMs limit; VMs already running are skipped rather than treated as failures.",
      inputSchema: {
        ...selectorArg,
        mode: z.enum(["gui", "nogui"]).default("nogui"),
        maxConcurrency: z.number().int().min(1).max(16).optional(),
        waitForTools: z.boolean().default(false),
        toolsTimeoutSec: z.number().int().min(30).max(3600).default(600),
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const recs = resolveSelection(a.selector);
      const already = new Set((await vmrun.listRunning()).map((p) => p.toLowerCase()));

      // A golden image should never be powered on by a broad selector — booting
      // it dirties the disk every linked clone depends on.
      const templates = recs.filter((r) => r.tags.includes("template"));
      const toStart = recs
        .filter((r) => !r.tags.includes("template"))
        .filter((r) => !already.has(r.vmxPath.toLowerCase()));
      if (already.size + toStart.length > cfg.maxRunningVms) {
        throw new Error(
          `Starting ${toStart.length} VMs would exceed the ${cfg.maxRunningVms}-VM limit (${already.size} already running). Narrow the selector or raise VMWARE_MCP_MAX_RUNNING_VMS.`,
        );
      }

      const summary = await runFleet(
        toStart,
        (r) => r.name,
        async (r) => {
          await vmrun.start(r.vmxPath, a.mode);
          if (!a.waitForTools) return { started: true };
          const deadline = Date.now() + a.toolsTimeoutSec * 1000;
          let state = await vmrun.checkToolsState(r.vmxPath);
          while (state !== "running" && Date.now() < deadline) {
            await new Promise((x) => setTimeout(x, 5000));
            state = await vmrun.checkToolsState(r.vmxPath);
          }
          return { started: true, toolsState: state };
        },
        a.maxConcurrency ?? cfg.defaultConcurrency,
      );

      return json({
        skippedTemplates: templates.map((t) => t.name),
        skippedAlreadyRunning: recs.filter((r) => already.has(r.vmxPath.toLowerCase())).length,
        ...summary,
      });
    },
  );

  defineTool(
    server,
    "fleet_stop",
    {
      title: "Stop many VMs",
      description:
        'Power off every running VM matching the selector. "soft" shuts each guest down cleanly via VMware Tools; "hard" is an immediate power cut.',
      inputSchema: {
        ...selectorArg,
        mode: z.enum(["soft", "hard"]).default("soft"),
        maxConcurrency: z.number().int().min(1).max(16).optional(),
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const recs = resolveSelection(a.selector);
      const running = new Set((await vmrun.listRunning()).map((p) => p.toLowerCase()));
      const toStop = recs.filter((r) => running.has(r.vmxPath.toLowerCase()));

      const summary = await runFleet(
        toStop,
        (r) => r.name,
        async (r) => {
          await vmrun.stop(r.vmxPath, a.mode);
          return { stopped: true };
        },
        a.maxConcurrency ?? cfg.defaultConcurrency,
      );
      return json({ skippedNotRunning: recs.length - toStop.length, ...summary });
    },
  );

  defineTool(
    server,
    "fleet_run",
    {
      title: "Run a command across many guests",
      description:
        "Run the same shell command inside every matching guest and collect the output from each. Each VM uses its own stored credentialRef unless credentials are given explicitly. VMs without VMware Tools running are reported as failures rather than silently skipped.",
      inputSchema: {
        ...selectorArg,
        command: z.string(),
        shell: z.enum(["auto", "bash", "cmd", "powershell"]).default("auto"),
        timeoutSec: z.number().int().min(5).max(3600).default(300),
        maxConcurrency: z.number().int().min(1).max(16).optional(),
        ...credArgs,
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const recs = resolveSelection(a.selector);

      const summary = await runFleet(
        recs,
        (r) => r.name,
        async (r) => {
          const state = await vmrun.checkToolsState(r.vmxPath);
          if (state !== "running") {
            throw new Error(`VMware Tools is "${state}"; the guest is not reachable.`);
          }
          const cred = resolveCredential(
            a.guestUser || a.credentialRef ? a : { credentialRef: r.credentialRef },
          );
          const isWindows =
            a.shell === "cmd" || a.shell === "powershell"
              ? true
              : a.shell === "bash"
                ? false
                : await guestIsWindows(r.vmxPath, cred, r.osFamily);

          // PowerShell for Windows unless cmd is explicitly demanded — cmd.exe
          // launched through VIX hangs indefinitely on Windows guests.
          const interpreter = isWindows
            ? a.shell === "cmd"
              ? "C:\\Windows\\System32\\cmd.exe"
              : "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
            : "/bin/bash";

          const res = await vmrun.runScriptInGuest(cred, r.vmxPath, interpreter, a.command, {
            timeoutMs: a.timeoutSec * 1000,
          });
          return { exitCode: res.code, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
        },
        a.maxConcurrency ?? cfg.defaultConcurrency,
      );

      return json({
        note: "vmrun does not return the guest program's own stdout. For output, use guest_exec_capture per VM.",
        ...summary,
      });
    },
  );

  defineTool(
    server,
    "fleet_snapshot",
    {
      title: "Snapshot many VMs",
      description: "Take a snapshot with the same name on every matching VM.",
      inputSchema: {
        ...selectorArg,
        name: z.string().min(1),
        maxConcurrency: z.number().int().min(1).max(16).optional(),
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const recs = resolveSelection(a.selector);
      const summary = await runFleet(
        recs,
        (r) => r.name,
        async (r) => {
          await vmrun.snapshot(r.vmxPath, a.name);
          return { snapshot: a.name };
        },
        a.maxConcurrency ?? cfg.defaultConcurrency,
      );
      return json(summary);
    },
  );

  defineTool(
    server,
    "fleet_revert",
    {
      title: "Revert many VMs to a snapshot",
      description:
        "Roll every matching VM back to a named snapshot, discarding all state since. The fast way to reset a lab between runs. Requires confirm: true.",
      inputSchema: {
        ...selectorArg,
        name: z.string().min(1),
        maxConcurrency: z.number().int().min(1).max(16).optional(),
        ...confirmArg,
      },
      destructive: true,
    },
    async (a) => {
      const cfg = loadConfig();
      const recs = resolveSelection(a.selector);
      requireConfirm(
        a.confirm,
        `reverting ${recs.length} VM(s) to snapshot "${a.name}", discarding all newer state`,
      );
      const summary = await runFleet(
        recs,
        (r) => r.name,
        async (r) => {
          await vmrun.revertToSnapshot(r.vmxPath, a.name);
          return { reverted: a.name };
        },
        a.maxConcurrency ?? cfg.defaultConcurrency,
      );
      return json(summary);
    },
  );
}
