import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, resolveCredential } from "../config.js";
import { assertIsoAllowed, resolveVmxByNameOrPath } from "../paths.js";
import { getRecord, listRecords } from "../registry.js";
import { provisionVm, finalizeProvision } from "../provision.js";
import { defaultBootCommand, installerKindFor } from "../bootCommand.js";
import { buildAutounattend } from "../seed/autounattend.js";
import { buildPreseed, kaliDefaults } from "../seed/preseed.js";
import { buildUserData } from "../seed/cloudinit.js";
import { sha512Crypt } from "../seed/sha512crypt.js";
import * as vmrun from "../vmrun.js";
import { defineTool, json, text, vmArg } from "./common.js";

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
