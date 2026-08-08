import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, resolveCredential } from "../config.js";
import { resolveVmxByNameOrPath } from "../paths.js";
import * as vmcli from "../vmcli.js";
import * as vmrun from "../vmrun.js";
import { parseBootCommand } from "../keymap.js";
import { playBootCommand } from "../vnc.js";
import { listRecords } from "../registry.js";
import { parseVmx, patchVmx } from "../vmx.js";
import { credArgs, defineTool, json, text, vmArg, type ToolResult } from "./common.js";

/**
 * Console keyboard input goes over the VM's built-in VNC server. Read the port
 * this VM is configured for, or explain how to turn it on.
 */
export function vncPortFor(vmx: string): { port: number; password?: string } {
  const cfg = parseVmx(vmx);
  if (cfg.get("remotedisplay.vnc.enabled")?.toUpperCase() !== "TRUE") {
    throw new Error(
      "Console input needs the VM's VNC console enabled. Power the VM off and call enable_console_input, then start it again.",
    );
  }
  const port = Number(cfg.get("remotedisplay.vnc.port") ?? "5900");
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`VM has an invalid RemoteDisplay.vnc.port: ${cfg.get("remotedisplay.vnc.port")}`);
  }
  return { port, password: cfg.get("remotedisplay.vnc.key") ? undefined : cfg.get("remotedisplay.vnc.password") };
}

/** Pick a VNC port not already claimed by another VM we manage. */
export function allocateVncPort(): number {
  const used = new Set<number>();
  for (const rec of listRecords()) {
    try {
      const c = parseVmx(rec.vmxPath);
      const p = Number(c.get("remotedisplay.vnc.port"));
      if (Number.isFinite(p)) used.add(p);
    } catch {
      /* a VM whose .vmx has gone missing simply contributes no port */
    }
  }
  for (let p = 5910; p < 6000; p++) if (!used.has(p)) return p;
  throw new Error("No free VNC port in the range 5910-5999.");
}

/**
 * Grab the guest framebuffer. `vmcli MKS captureScreenshot` is used rather than
 * `vmrun captureScreen` because vmrun refuses without a guest login — verified on
 * this host, where it errors with "Anonymous guest operations are not allowed".
 * That makes vmrun useless during an OS install, which is exactly when a
 * screenshot matters most. vmrun is kept only as a fallback.
 */
export async function grabScreenshot(vmx: string): Promise<string> {
  const cfg = loadConfig();
  const out = path.join(cfg.workDir, `screen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);

  const r = await vmcli.captureScreenshot(vmx, out);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;

  try {
    const rec = listRecords().find((x) => x.vmxPath.toLowerCase() === vmx.toLowerCase());
    if (rec?.credentialRef) {
      const cred = resolveCredential({ credentialRef: rec.credentialRef });
      await vmrun.vmrunGuest(cred, ["captureScreen", vmx, out]);
      if (fs.existsSync(out)) return out;
    }
  } catch {
    /* fall through to the vmcli error, which is the more informative one */
  }

  throw new Error(
    `Could not capture the screen. vmcli said: ${(r.stderr || r.stdout).trim() || "(no output)"}. The VM must be powered on.`,
  );
}

export function registerScreenTools(server: McpServer): void {
  defineTool(
    server,
    "capture_screen",
    {
      title: "Screenshot the guest console",
      description:
        "Capture the VM's current screen and return it as an image. Works with no guest agent and no credentials, so it is the way to see what a VM is doing during an OS install, at a boot menu, or at a login prompt.",
      inputSchema: {
        ...vmArg,
        savePath: z.string().optional().describe("Optional host path to keep a copy of the PNG"),
        returnImage: z
          .boolean()
          .default(true)
          .describe("Return the image inline. Set false to only get the file path."),
      },
      readOnly: true,
    },
    async (a): Promise<ToolResult> => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const shot = await grabScreenshot(vmx);
      let finalPath = shot;
      if (a.savePath) {
        finalPath = path.resolve(a.savePath);
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        fs.copyFileSync(shot, finalPath);
      }
      const sizeBytes = fs.statSync(finalPath).size;
      if (!a.returnImage) return json({ path: finalPath, sizeBytes });
      return {
        content: [
          { type: "text", text: `Screenshot of ${path.basename(vmx)} (${sizeBytes} bytes): ${finalPath}` },
          { type: "image", data: fs.readFileSync(finalPath).toString("base64"), mimeType: "image/png" },
        ],
      };
    },
  );

  defineTool(
    server,
    "send_keys",
    {
      title: "Type into the guest console",
      description:
        "Send keystrokes straight to the VM's virtual keyboard. This does not need VMware Tools or credentials, so it works at a BIOS screen, a bootloader menu, or a login prompt. Supports Packer-style tokens: plain text is typed literally, <enter> <tab> <esc> <up> <down> <f2>…<f12> are named keys, <ctrl-alt-del> style combos work, and <wait> / <wait5> pause for that many seconds.",
      inputSchema: {
        ...vmArg,
        keys: z.string().describe('e.g. "root<enter><wait2>toor<enter>"'),
        keyDelayMs: z
          .number()
          .int()
          .min(0)
          .max(2000)
          .default(60)
          .describe("Delay between keystrokes. Raise it if the guest drops characters."),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      if (!(await vmrun.isRunning(vmx))) throw new Error("VM is not running; there is no console to type into.");

      const steps = parseBootCommand(a.keys);
      const { port, password } = vncPortFor(vmx);
      const r = await playBootCommand({ port, password }, steps, a.keyDelayMs);
      return json({ keystrokesSent: r.keysSent, totalWaitMs: r.waitedMs, steps: steps.length, vncPort: port });
    },
  );

  defineTool(
    server,
    "enable_console_input",
    {
      title: "Enable console keyboard input",
      description:
        "Turn on the VM's built-in VNC console, which is how send_keys reaches the guest keyboard. Needed to type at a BIOS screen, bootloader, or installer — anywhere VMware Tools is not yet running. The VM must be powered off; the setting persists.",
      inputSchema: {
        ...vmArg,
        port: z.number().int().min(1024).max(65535).optional().describe("Defaults to the next free port from 5910"),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      if (await vmrun.isRunning(vmx)) {
        throw new Error("VM is running. Power it off before enabling the console, then start it again.");
      }
      const existing = parseVmx(vmx).get("remotedisplay.vnc.port");
      const port = a.port ?? (existing ? Number(existing) : allocateVncPort());
      patchVmx(vmx, {
        "RemoteDisplay.vnc.enabled": "TRUE",
        "RemoteDisplay.vnc.port": String(port),
      });
      return json({
        vmxPath: vmx,
        vncPort: port,
        note: "Start the VM, then use send_keys to type at its console.",
      });
    },
  );

  defineTool(
    server,
    "send_key_sequence",
    {
      title: "Send a raw vmcli key sequence",
      description:
        "Pass a key sequence straight through to `vmcli MKS sendKeySequence` in its native syntax. An escape hatch for when send_keys cannot express something.",
      inputSchema: { ...vmArg, sequence: z.string() },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const r = await vmcli.sendKeySequence(vmx, a.sequence);
      return json({ stdout: r.stdout.trim(), stderr: r.stderr.trim() });
    },
  );

  defineTool(
    server,
    "type_in_guest",
    {
      title: "Type text via VMware Tools",
      description:
        "Type a literal string into the guest's active window using VMware Tools. Needs Tools running and guest credentials — unlike send_keys, which talks to the virtual keyboard directly. Prefer send_keys unless you specifically need Tools-mediated input.",
      inputSchema: { ...vmArg, keystrokes: z.string(), ...credArgs },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const rec = listRecords().find((x) => x.vmxPath.toLowerCase() === vmx.toLowerCase());
      const cred = resolveCredential(
        a.guestUser || a.credentialRef ? a : { credentialRef: rec?.credentialRef },
      );
      await vmrun.typeKeystrokesInGuest(cred, vmx, a.keystrokes);
      return text(`Typed ${a.keystrokes.length} characters into the guest.`);
    },
  );

  defineTool(
    server,
    "set_guest_resolution",
    {
      title: "Set the guest screen resolution",
      description: "Change the guest's display resolution. Requires VMware Tools running in the guest.",
      inputSchema: {
        ...vmArg,
        width: z.number().int().min(640).max(7680),
        height: z.number().int().min(480).max(4320),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await vmcli.setGuestResolution(vmx, a.width, a.height);
      return text(`Set resolution to ${a.width}x${a.height}.`);
    },
  );
}
