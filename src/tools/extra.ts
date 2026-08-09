import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveCredential, type GuestCredential } from "../config.js";
import { assertHostPathAllowed, resolveVmxByNameOrPath } from "../paths.js";
import * as vmrun from "../vmrun.js";
import { listRecords } from "../registry.js";
import { guestIsWindows } from "./guest.js";
import { credArgs, defineTool, json, text, vmArg } from "./common.js";

function credFor(vmx: string, a: { credentialRef?: string; guestUser?: string; guestPassword?: string }): GuestCredential {
  if (a.guestUser || a.credentialRef) return resolveCredential(a);
  const rec = listRecords().find((r) => r.vmxPath.toLowerCase() === vmx.toLowerCase());
  if (rec?.credentialRef) return resolveCredential({ credentialRef: rec.credentialRef });
  throw new Error("No guest credentials. Pass credentialRef or guestUser+guestPassword.");
}

/** Join a guest path with the right separator for that guest. */
function guestJoin(base: string, rel: string, isWindows: boolean): string {
  const sep = isWindows ? "\\" : "/";
  const normalised = rel.split(/[\\/]/).filter(Boolean).join(sep);
  return base.replace(/[\\/]+$/, "") + sep + normalised;
}

interface WalkedFile {
  abs: string;
  rel: string;
}

function walkHostDir(root: string, maxFiles: number): WalkedFile[] {
  const out: WalkedFile[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxFiles) return;
      const abs = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, rel);
      else if (e.isFile()) out.push({ abs, rel });
    }
  };
  walk(root, "");
  return out;
}

export function registerExtraTools(server: McpServer): void {
  // ---------------------------------------------------------------- #10

  defineTool(
    server,
    "pause_vm",
    {
      title: "Pause a VM",
      description:
        "Freeze a running VM's execution without saving state to disk. Much faster than suspend, but the VM must be unpaused before the host reboots or the state is lost.",
      inputSchema: { ...vmArg },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await vmrun.pause(vmx);
      return text(`Paused ${vmx}.`);
    },
  );

  defineTool(
    server,
    "unpause_vm",
    {
      title: "Unpause a VM",
      description: "Resume a VM previously frozen with pause_vm.",
      inputSchema: { ...vmArg },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await vmrun.unpause(vmx);
      return text(`Unpaused ${vmx}.`);
    },
  );

  defineTool(
    server,
    "guest_rename",
    {
      title: "Rename or move a file in the guest",
      description: "Rename a file inside the guest, or move it by giving a different directory in the new path.",
      inputSchema: {
        ...vmArg,
        from: z.string().describe("Existing absolute path inside the guest"),
        to: z.string().describe("New absolute path inside the guest"),
        ...credArgs,
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await vmrun.renameFileInGuest(credFor(vmx, a), vmx, a.from, a.to);
      return text(`Renamed ${a.from} → ${a.to} in guest.`);
    },
  );

  defineTool(
    server,
    "set_shared_folder_state",
    {
      title: "Make a shared folder read-only or writable",
      description:
        "Change an existing shared folder between writable and read-only without removing and re-adding it. Read-only is the safer default when the guest is untrusted.",
      inputSchema: {
        ...vmArg,
        shareName: z.string().min(1),
        hostPath: z.string().describe("The host directory this share points at"),
        writable: z.boolean(),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const host = assertHostPathAllowed(a.hostPath, a.writable ? "write" : "read");
      await vmrun.setSharedFolderState(vmx, a.shareName, host, a.writable ? "writable" : "readonly");
      return text(`Shared folder "${a.shareName}" is now ${a.writable ? "writable" : "read-only"}.`);
    },
  );

  defineTool(
    server,
    "disable_shared_folders",
    {
      title: "Turn shared folders off",
      description:
        "Disable host-guest folder sharing for this VM without deleting the share definitions. The counterpart to add_shared_folder, which enables sharing implicitly.",
      inputSchema: { ...vmArg },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await vmrun.disableSharedFolders(vmx);
      return text(`Shared folders disabled for ${vmx}.`);
    },
  );

  // ---------------------------------------------------------------- #12

  defineTool(
    server,
    "guest_copy_dir_to",
    {
      title: "Copy a directory into the guest",
      description:
        "Copy a whole directory tree from the host into the guest. VMware Tools only moves one file at a time, so this walks the tree and copies file by file, creating directories as it goes. Host paths are restricted the same way as guest_copy_to.",
      inputSchema: {
        ...vmArg,
        hostDir: z.string().describe("Absolute host directory to copy from"),
        guestDir: z.string().describe("Absolute destination directory inside the guest"),
        maxFiles: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe("Safety cap — a mistaken path should not fire thousands of copies"),
        ...credArgs,
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const cred = credFor(vmx, a);
      const src = assertHostPathAllowed(a.hostDir, "read");
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
        throw new Error(`Not a directory on the host: ${src}`);
      }

      const files = walkHostDir(src, a.maxFiles + 1);
      if (files.length > a.maxFiles) {
        throw new Error(
          `${src} holds more than ${a.maxFiles} files. Raise maxFiles deliberately, or copy a narrower directory.`,
        );
      }

      const isWindows = await guestIsWindows(vmx, cred, undefined);
      const madeDirs = new Set<string>();
      const copied: string[] = [];
      const failed: Array<{ file: string; error: string }> = [];

      await vmrun.createDirectoryInGuest(cred, vmx, a.guestDir).catch(() => undefined);
      for (const f of files) {
        const relDir = path.posix.dirname(f.rel);
        if (relDir && relDir !== "." && !madeDirs.has(relDir)) {
          // Create each ancestor: VMware Tools has no mkdir -p.
          const parts = relDir.split("/");
          for (let i = 1; i <= parts.length; i++) {
            const sub = parts.slice(0, i).join("/");
            if (madeDirs.has(sub)) continue;
            await vmrun.createDirectoryInGuest(cred, vmx, guestJoin(a.guestDir, sub, isWindows)).catch(() => undefined);
            madeDirs.add(sub);
          }
        }
        const dest = guestJoin(a.guestDir, f.rel, isWindows);
        try {
          await vmrun.copyFileToGuest(cred, vmx, f.abs, dest);
          copied.push(f.rel);
        } catch (e) {
          failed.push({ file: f.rel, error: (e as Error).message.slice(0, 160) });
        }
      }

      return json({
        hostDir: src,
        guestDir: a.guestDir,
        directoriesCreated: madeDirs.size,
        copied: copied.length,
        failed: failed.length,
        failures: failed.slice(0, 10),
      });
    },
  );

  defineTool(
    server,
    "guest_copy_dir_from",
    {
      title: "Copy a directory out of the guest",
      description:
        "Copy a directory tree from the guest to the host. Lists the guest directory recursively, then copies file by file. Host destinations are restricted the same way as guest_copy_from.",
      inputSchema: {
        ...vmArg,
        guestDir: z.string().describe("Absolute directory inside the guest"),
        hostDir: z.string().describe("Absolute destination directory on the host"),
        maxFiles: z.number().int().min(1).max(5000).default(500),
        ...credArgs,
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const cred = credFor(vmx, a);
      const dest = assertHostPathAllowed(a.hostDir, "write");
      const isWindows = await guestIsWindows(vmx, cred, undefined);

      // listDirectoryInGuest is not recursive, so walk it breadth-first.
      const files: string[] = [];
      const queue: string[] = [""];
      while (queue.length && files.length <= a.maxFiles) {
        const rel = queue.shift()!;
        const abs = rel ? guestJoin(a.guestDir, rel, isWindows) : a.guestDir;
        const entries = await vmrun.listDirectoryInGuest(cred, vmx, abs).catch(() => [] as string[]);
        for (const name of entries) {
          const childRel = rel ? `${rel}/${name}` : name;
          const childAbs = guestJoin(a.guestDir, childRel, isWindows);
          if (await vmrun.directoryExistsInGuest(cred, vmx, childAbs)) queue.push(childRel);
          else files.push(childRel);
        }
      }
      if (files.length > a.maxFiles) {
        throw new Error(`${a.guestDir} holds more than ${a.maxFiles} files. Raise maxFiles or narrow the path.`);
      }

      const copied: string[] = [];
      const failed: Array<{ file: string; error: string }> = [];
      for (const rel of files) {
        const target = path.join(dest, ...rel.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
          await vmrun.copyFileFromGuest(cred, vmx, guestJoin(a.guestDir, rel, isWindows), target);
          copied.push(rel);
        } catch (e) {
          failed.push({ file: rel, error: (e as Error).message.slice(0, 160) });
        }
      }

      return json({
        guestDir: a.guestDir,
        hostDir: dest,
        copied: copied.length,
        failed: failed.length,
        failures: failed.slice(0, 10),
      });
    },
  );
}
