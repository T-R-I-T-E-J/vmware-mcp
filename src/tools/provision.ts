import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, resolveCredential } from "../config.js";
import { assertIsoAllowed, resolveVmxByNameOrPath } from "../paths.js";
import { appendNote, listRecords, removeRecord } from "../registry.js";
import { provisionVm, finalizeProvision } from "../provision.js";
import { defaultBootCommand, installerKindFor } from "../bootCommand.js";
import { parseBootCommand } from "../keymap.js";
import { playBootCommand } from "../vnc.js";
import { parseVmx } from "../vmx.js";
import { buildAutounattend } from "../seed/autounattend.js";
import { buildPreseed, kaliDefaults } from "../seed/preseed.js";
import { buildUserData } from "../seed/cloudinit.js";
import { sha512Crypt } from "../seed/sha512crypt.js";
import * as vmrun from "../vmrun.js";
import { defineTool, json, requireConfirm, text, vmArg } from "./common.js";

/**
 * Background provisioning jobs, keyed by VM name. The registry is the durable
 * record of progress; this map only exists so a second provision_vm call for the
 * same VM can be rejected while one is already in flight.
 */
const inFlight = new Map<string, Promise<unknown>>();

function startBackgroundProvision(req: Parameters<typeof provisionVm>[0]): void {
  if (inFlight.has(req.name)) {
    throw new Error(`A provision for "${req.name}" is already running. Poll get_provision_status.`);
  }
  const job = provisionVm(req)
    .catch((e: unknown) => {
      // provisionVm already records the failure in the registry; swallowing here
      // keeps an unhandled rejection from taking down the server process.
      process.stderr.write(
        `provision "${req.name}" failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    })
    .finally(() => inFlight.delete(req.name));
  inFlight.set(req.name, job);
}

export function registerProvisionTools(server: McpServer): void {
  defineTool(
    server,
    "provision_vm",
    {
      title: "Create and install a VM unattended",
      description:
        "Build a VM and run its OS install end to end with no interaction: creates the hardware, generates the answer file (autounattend.xml for Windows, cloud-init for Ubuntu, preseed for Debian/Kali), delivers it, types any boot command the installer needs, waits for the install, and verifies the new account can actually run commands before reporting success. This is a long-running call — a Windows or Ubuntu install typically takes 20-40 minutes.",
      inputSchema: {
        name: z.string().min(1).describe("VM name; becomes the folder under VM_ROOT and the hostname"),
        installIso: z.string().describe("ISO filename from list_isos"),
        guestOsId: z
          .string()
          .describe("vmcli guest OS id, e.g. windows9-64, windows9srv-64, ubuntu-64, debian12-64"),
        username: z.string().min(1).describe("Account to create and log in as"),
        password: z.string().min(1),
        credentialRef: z
          .string()
          .optional()
          .describe("Store the credentials under this name and attach it to the VM for later guest_* calls"),
        memoryMb: z.number().int().min(1024).default(4096),
        cpus: z.number().int().min(1).max(32).default(2),
        diskGb: z.number().int().min(16).default(60),
        firmware: z.enum(["bios", "efi"]).default("bios"),
        network: z.enum(["nat", "bridged", "hostonly", "custom", "none"]).default("nat"),
        customVnet: z.string().optional(),
        tags: z.array(z.string()).default([]),
        windowsImageName: z
          .string()
          .optional()
          .describe('Windows edition in install.wim, e.g. "Windows 10 Pro". Omit if the ISO has one image.'),
        windowsImageIndex: z.number().int().optional(),
        productKey: z.string().optional(),
        bypassHardwareChecks: z
          .boolean()
          .default(false)
          .describe("Windows 11 only: bypass the TPM and Secure Boot requirements"),
        autologin: z.boolean().default(true).describe("Linux: enable desktop auto-logon"),
        extraPackages: z.array(z.string()).default([]),
        timezone: z.string().optional(),
        locale: z.string().optional(),
        bootCommand: z.string().optional().describe("Override the typed boot command (send_keys syntax)"),
        bootWaitSec: z.number().int().min(0).max(300).optional(),
        keyDelayMs: z.number().int().min(0).max(1000).optional(),
        installTimeoutMin: z.number().int().min(5).max(240).default(60),
        snapshotWhenReady: z.boolean().default(true),
        wait: z
          .boolean()
          .default(false)
          .describe(
            "Block until the install finishes. Off by default because an OS install outlasts most client timeouts; leave it off and poll get_provision_status instead.",
          ),
      },
    },
    async (a) => {
      const req = {
        ...a,
        tags: a.tags,
        installTimeoutMin: a.installTimeoutMin,
        snapshotWhenReady: a.snapshotWhenReady,
      };

      if (a.wait) return json(await provisionVm(req));

      // An OS install takes far longer than any MCP client will hold a request
      // open, so the default is to run it in the background and let the caller
      // poll get_provision_status. Progress is written to the registry as it
      // happens, so nothing is lost if the server is restarted mid-install.
      startBackgroundProvision(req);
      return json({
        started: true,
        name: a.name,
        mode: "background",
        message:
          "Provisioning started. It runs in the background — poll get_provision_status with this VM name to follow progress. A typical install takes 15-40 minutes.",
        pollWith: { tool: "get_provision_status", args: { vm: a.name } },
      });
    },
  );

  defineTool(
    server,
    "get_provision_status",
    {
      title: "Check provisioning progress",
      description:
        "Report where a VM is in provisioning: its lifecycle state, the progress notes recorded so far, VMware Tools state, and any error. Use this to follow a provision_vm run or to understand why one failed.",
      inputSchema: { ...vmArg },
      readOnly: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const rec = listRecords().find((r) => r.vmxPath.toLowerCase() === vmx.toLowerCase());
      const running = await vmrun.isRunning(vmx);
      const toolsState = running ? await vmrun.checkToolsState(vmx) : "poweredOff";
      return json({
        vmxPath: vmx,
        running,
        toolsState,
        lifecycle: rec?.lifecycle ?? "unknown",
        phase: rec?.phase ?? null,
        canRetry: rec?.provisionSpec ? true : false,
        provisionInFlight: rec ? inFlight.has(rec.name) : false,
        lastError: rec?.lastError ?? null,
        notes: rec?.notes ?? [],
      });
    },
  );

  defineTool(
    server,
    "finalize_provision",
    {
      title: "Finish provisioning a VM whose install completed on its own",
      description:
        "Run the post-install steps for a VM that finished installing outside provision_vm — waits for VMware Tools, proves the account can run commands, ejects the install media so the VM stops rebooting into its installer, snapshots it, and marks it ready. Use this when the server was restarted mid-install, or when you installed a VM by hand and want it under management.",
      inputSchema: {
        ...vmArg,
        credentialRef: z.string().optional(),
        guestUser: z.string().optional(),
        guestPassword: z.string().optional(),
        waitMinutes: z.number().int().min(1).max(240).default(30),
        snapshotName: z.string().default("clean").describe('Empty string skips the snapshot'),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const rec = listRecords().find((r) => r.vmxPath.toLowerCase() === vmx.toLowerCase());
      if (!rec) throw new Error(`${vmx} is not in the registry. Add it with register_vm first.`);
      const cred = resolveCredential(
        a.guestUser || a.credentialRef ? a : { credentialRef: rec.credentialRef },
      );
      const result = await finalizeProvision({
        vmxPath: vmx,
        name: rec.name,
        cred,
        isWindows: rec.osFamily === "windows",
        waitMinutes: a.waitMinutes,
        snapshotName: a.snapshotName || undefined,
      });
      return json(result);
    },
  );

  defineTool(
    server,
    "retry_provision",
    {
      title: "Retry a failed provision",
      description:
        "Recover a VM whose install failed, choosing the cheapest action that can actually work. If the OS installed and only the post-install steps failed, it finalizes rather than rebuilding (minutes, not an hour). If the installer stalled before it ever started, it replays the boot command. If the disk was left half-written there is no honest resume, so it says so and rebuilds only when you pass confirm: true — a rebuild wipes the VM. Reuses the original request, so nothing has to be re-specified.",
      inputSchema: {
        ...vmArg,
        strategy: z
          .enum(["auto", "finalize", "replay-boot", "rebuild"])
          .default("auto")
          .describe("auto picks based on how far provisioning got"),
        confirm: z
          .boolean()
          .default(false)
          .describe("Required for a rebuild, which deletes the VM and installs again"),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const rec = listRecords().find((r) => r.vmxPath.toLowerCase() === vmx.toLowerCase());
      if (!rec) throw new Error(`${vmx} is not in the registry, so there is no provision to retry.`);

      const phase = rec.phase ?? "created";
      const running = await vmrun.isRunning(vmx);
      const toolsState = running ? await vmrun.checkToolsState(vmx) : "poweredOff";
      const toolsPresent = toolsState === "running" || toolsState === "installed";

      // Pick the cheapest action that stands a chance.
      let strategy = a.strategy;
      if (strategy === "auto") {
        if (toolsPresent) strategy = "finalize";
        else if (phase === "created" || phase === "seeded" || phase === "booted") strategy = "replay-boot";
        else strategy = "rebuild";
      }

      const context = { vm: rec.name, phase, running, toolsState, chosen: strategy };

      if (strategy === "finalize") {
        if (!rec.credentialRef) {
          throw new Error("No credentialRef on this VM, so the account cannot be verified. Store one with set_credential.");
        }
        const cred = resolveCredential({ credentialRef: rec.credentialRef });
        const result = await finalizeProvision({
          vmxPath: vmx,
          name: rec.name,
          cred,
          isWindows: rec.osFamily === "windows",
          waitMinutes: 20,
          snapshotName: rec.provisionSpec?.snapshotWhenReady === false ? undefined : "clean",
        });
        return json({ ...context, outcome: "finalized", result });
      }

      if (strategy === "replay-boot") {
        // The installer never started, so the disk should still be untouched and
        // retyping the boot command is safe.
        const spec = rec.provisionSpec;
        if (!spec) throw new Error("No stored provision spec for this VM; rebuild it with provision_vm instead.");
        if (!running) await vmrun.start(vmx, "nogui");

        const kind = installerKindFor(rec.osFamily, path.basename(spec.installIso));
        const seedUrl = undefined; // an HTTP seed server is not running outside provision_vm
        if (kind === "debian" || kind === "kali") {
          throw new Error(
            "This guest takes its answer file over HTTP, which only runs during provision_vm — replaying the boot command alone would leave the installer waiting. Retry with strategy 'rebuild'.",
          );
        }
        const boot = defaultBootCommand(kind, { seedUrl });
        const command = spec.bootCommand ?? boot.command;
        const steps = parseBootCommand(command);
        await new Promise((r) => setTimeout(r, (spec.bootWaitSec ?? boot.bootWaitSec) * 1000));
        const port = Number(parseVmx(vmx).get("remotedisplay.vnc.port"));
        const played = await playBootCommand({ port }, steps, spec.keyDelayMs ?? boot.keyDelayMs);
        appendNote(rec.name, `retry_provision replayed the boot command (${played.keysSent} keystrokes).`);
        return json({
          ...context,
          outcome: "boot-command-replayed",
          command,
          keystrokesSent: played.keysSent,
          next: "Poll get_provision_status; once VMware Tools appears, run retry_provision again to finalize.",
        });
      }

      // rebuild
      const spec = rec.provisionSpec;
      if (!spec) {
        throw new Error(
          "No stored provision spec for this VM — it predates phase tracking. Delete it and call provision_vm directly.",
        );
      }
      if (!rec.credentialRef) {
        throw new Error("Rebuilding needs the account password, which is reached through credentialRef. None is stored.");
      }
      requireConfirm(
        a.confirm,
        `rebuilding ${rec.name}: the existing VM is deleted and reinstalled from ${path.basename(spec.installIso)} (phase reached: ${phase})`,
      );

      const cred = resolveCredential({ credentialRef: rec.credentialRef });
      const cfg = loadConfig();
      if (running) await vmrun.stop(vmx, "hard").catch(() => undefined);
      await vmrun.deleteVM(vmx).catch(() => undefined);
      const dir = path.dirname(vmx);
      const rel = path.relative(cfg.vmRoot, dir);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Refusing to delete ${dir}: outside VM_ROOT.`);
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removeRecord(rec.name);

      startBackgroundProvision({
        name: rec.name,
        installIso: spec.installIso,
        guestOsId: spec.guestOsId,
        username: spec.username,
        password: cred.password,
        credentialRef: rec.credentialRef,
        memoryMb: spec.memoryMb,
        cpus: spec.cpus,
        diskGb: spec.diskGb,
        firmware: spec.firmware,
        network: spec.network as "nat" | "bridged" | "hostonly" | "custom" | "none",
        customVnet: spec.customVnet,
        tags: spec.tags,
        windowsImageName: spec.windowsImageName,
        windowsImageIndex: spec.windowsImageIndex,
        productKey: spec.productKey,
        bypassHardwareChecks: spec.bypassHardwareChecks,
        autologin: spec.autologin,
        extraPackages: spec.extraPackages,
        timezone: spec.timezone,
        locale: spec.locale,
        bootCommand: spec.bootCommand,
        bootWaitSec: spec.bootWaitSec,
        keyDelayMs: spec.keyDelayMs,
        installTimeoutMin: spec.installTimeoutMin,
        snapshotWhenReady: spec.snapshotWhenReady,
      });

      return json({
        ...context,
        outcome: "rebuilding",
        message: "Deleted and reinstalling in the background with the original settings. Poll get_provision_status.",
      });
    },
  );

  defineTool(
    server,
    "preview_answer_file",
    {
      title: "Preview the generated answer file",
      description:
        "Render the unattended answer file that provision_vm would generate, without creating anything. Use this to check partitioning, the account, or package selection before committing to a long install.",
      inputSchema: {
        installIso: z.string().describe("ISO filename from list_isos"),
        guestOsId: z.string(),
        name: z.string().default("preview"),
        username: z.string().default("labuser"),
        password: z.string().default("ChangeMe123!"),
        firmware: z.enum(["bios", "efi"]).default("bios"),
        autologin: z.boolean().default(true),
        bypassHardwareChecks: z.boolean().default(false),
      },
      readOnly: true,
    },
    async (a) => {
      const cfg = loadConfig();
      const iso = assertIsoAllowed(
        path.isAbsolute(a.installIso) ? a.installIso : path.join(cfg.isoLibrary, a.installIso),
      );
      const family = a.guestOsId.toLowerCase().startsWith("win")
        ? "windows"
        : a.guestOsId.toLowerCase().startsWith("ubuntu")
          ? "ubuntu"
          : "debian";
      const kind = installerKindFor(family, path.basename(iso));
      const spec = defaultBootCommand(kind, { seedUrl: "http://<host-ip>:<port>" });

      let content: string;
      let filename: string;
      if (kind === "windows") {
        filename = "autounattend.xml";
        content = buildAutounattend({
          username: a.username,
          password: a.password,
          computerName: a.name.slice(0, 15),
          firmware: a.firmware,
          bypassHardwareChecks: a.bypassHardwareChecks,
          installVmwareTools: true,
        });
      } else if (kind === "ubuntu-autoinstall") {
        filename = "user-data";
        content = buildUserData(
          { hostname: a.name, username: a.username, password: a.password, autologin: a.autologin },
          sha512Crypt(a.password),
        );
      } else {
        filename = "preseed.cfg";
        content = buildPreseed({
          hostname: a.name,
          username: a.username,
          password: a.password,
          autologin: a.autologin,
          ...(kind === "kali" ? kaliDefaults() : {}),
        });
      }

      return text(
        [
          `Installer kind: ${kind}`,
          `Delivery: ${kind === "debian" || kind === "kali" ? "HTTP (auto url=)" : "seed CD-ROM"}`,
          `Boot command: ${spec.command}`,
          `Boot wait: ${spec.bootWaitSec}s   Key delay: ${spec.keyDelayMs}ms`,
          `Note: ${spec.notes}`,
          ``,
          `--- ${filename} ---`,
          content,
        ].join("\n"),
      );
    },
  );

  defineTool(
    server,
    "get_boot_command",
    {
      title: "Show the default boot command for an installer",
      description:
        "Show the keystrokes provision_vm types at the bootloader for a given installer, with its timing. Useful when tuning a boot command that is not landing.",
      inputSchema: {
        installerKind: z.enum(["windows", "debian", "kali", "ubuntu-autoinstall"]),
        seedUrl: z.string().optional(),
      },
      readOnly: true,
    },
    async (a) => json(defaultBootCommand(a.installerKind, { seedUrl: a.seedUrl })),
  );
}
