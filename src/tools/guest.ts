import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, resolveCredential, saveCredential, type GuestCredential } from "../config.js";
import { assertVmPathAllowed, resolveVmxByNameOrPath } from "../paths.js";
import * as vmrun from "../vmrun.js";
import { getRecord, listRecords } from "../registry.js";
import { credArgs, defineTool, json, text, vmArg } from "./common.js";

/**
 * Credentials may be given inline, by ref, or omitted entirely — in which case
 * we fall back to the credentialRef stored on the VM's registry record. That
 * fallback is what makes `guest_run` usable without repeating credentials on
 * every single call.
 */
function credFor(vmx: string, a: { credentialRef?: string; guestUser?: string; guestPassword?: string }): GuestCredential {
  if (a.guestUser || a.credentialRef) return resolveCredential(a);
  const rec = listRecords().find((r) => r.vmxPath.toLowerCase() === vmx.toLowerCase());
  if (rec?.credentialRef) return resolveCredential({ credentialRef: rec.credentialRef });
  throw new Error(
    "No guest credentials. Pass credentialRef or guestUser+guestPassword, or set a credentialRef on the VM with register_vm.",
  );
}

async function assertToolsRunning(vmx: string): Promise<void> {
  const state = await vmrun.checkToolsState(vmx);
  if (state !== "running") {
    throw new Error(
      `VMware Tools is "${state}" in this guest, so guest operations are unavailable. Power the VM on and wait_for_tools; if the OS is installed but Tools is not, install open-vm-tools (Linux) or run the Tools installer (Windows).`,
    );
  }
}

export function registerGuestTools(server: McpServer): void {
  defineTool(
    server,
    "set_credential",
    {
      title: "Store guest credentials",
      description:
        "Save a named guest username/password to the credentials file so later guest_* calls can reference it by name instead of repeating the password. The password is never echoed back.",
      inputSchema: {
        ref: z.string().min(1).describe("Name to store these credentials under"),
        username: z.string().min(1),
        password: z.string(),
      },
    },
    async (a) => {
      saveCredential(a.ref, { username: a.username, password: a.password });
      return text(`Stored credential "${a.ref}" for user "${a.username}" in ${loadConfig().credentialsFile}.`);
    },
  );

  defineTool(
    server,
    "guest_run",
    {
      title: "Run a program in the guest",
      description:
        "Execute a program inside the guest OS via VMware Tools. Give the full path to the executable (e.g. C:\\Windows\\System32\\cmd.exe or /bin/ls) plus its arguments as a list. This runs the binary directly with no shell, so pipes and redirection do not work — use guest_run_script for those. Requires VMware Tools running.",
      inputSchema: {
        ...vmArg,
        program: z.string().describe("Full path to the executable inside the guest"),
        args: z.array(z.string()).default([]),
        noWait: z.boolean().default(false).describe("Return immediately instead of waiting for exit"),
        interactive: z
          .boolean()
          .default(false)
          .describe("Run in the interactive desktop session (needed for GUI apps)"),
        timeoutSec: z.number().int().min(5).max(7200).default(300),
        ...credArgs,
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      const cred = credFor(vmx, a);
      const r = await vmrun.runProgramInGuest(cred, vmx, a.program, a.args, {
        noWait: a.noWait,
        interactive: a.interactive,
        timeoutMs: a.timeoutSec * 1000,
      });
      return json({
        exitCode: r.code,
        stdout: r.stdout.trim(),
        stderr: r.stderr.trim(),
        note:
          "vmrun reports its own exit status, not the guest program's. To capture guest output, have the program redirect to a file and read it back with guest_read_file.",
      });
    },
  );

  defineTool(
    server,
    "guest_run_script",
    {
      title: "Run a script in the guest",
      description:
        "Run a script inside the guest with a chosen interpreter — /bin/bash on Linux, or C:\\Windows\\System32\\cmd.exe / powershell.exe on Windows. Unlike guest_run this supports pipes, redirection, and multi-line logic. Requires VMware Tools running.",
      inputSchema: {
        ...vmArg,
        interpreter: z
          .string()
          .default("/bin/bash")
          .describe("Full path to the interpreter inside the guest"),
        script: z.string().describe("Script body"),
        timeoutSec: z.number().int().min(5).max(7200).default(600),
        ...credArgs,
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      const cred = credFor(vmx, a);
      const r = await vmrun.runScriptInGuest(cred, vmx, a.interpreter, a.script, {
        timeoutMs: a.timeoutSec * 1000,
      });
      return json({ exitCode: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() });
    },
  );

  defineTool(
    server,
    "guest_exec_capture",
    {
      title: "Run a command in the guest and capture its output",
      description:
        "The practical way to get output back from a guest. Runs a shell command, redirects stdout and stderr to a temp file inside the guest, copies that file to the host, and returns its contents. Works on both Windows and Linux guests.",
      inputSchema: {
        ...vmArg,
        command: z.string().describe("Shell command line to run inside the guest"),
        shell: z
          .enum(["auto", "bash", "cmd", "powershell"])
          .default("auto")
          .describe('"auto" picks cmd/powershell for Windows guests and bash otherwise'),
        timeoutSec: z.number().int().min(5).max(7200).default(600),
        maxBytes: z.number().int().min(1024).max(4_000_000).default(200_000),
        ...credArgs,
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      const cred = credFor(vmx, a);

      const rec = listRecords().find((r) => r.vmxPath.toLowerCase() === vmx.toLowerCase());
      const isWindows =
        a.shell === "cmd" || a.shell === "powershell"
          ? true
          : a.shell === "bash"
            ? false
            : rec?.osFamily === "windows";

      const stamp = `vmmcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const guestOut = isWindows ? `C:\\Windows\\Temp\\${stamp}.txt` : `/tmp/${stamp}.txt`;

      let interpreter: string;
      let script: string;
      if (isWindows && a.shell === "powershell") {
        interpreter = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        script = `& { ${a.command} } *> "${guestOut}"`;
      } else if (isWindows) {
        interpreter = "C:\\Windows\\System32\\cmd.exe";
        script = `${a.command} > "${guestOut}" 2>&1`;
      } else {
        interpreter = "/bin/bash";
        script = `{ ${a.command} ; } > '${guestOut}' 2>&1`;
      }

      const r = await vmrun.runScriptInGuest(cred, vmx, interpreter, script, {
        timeoutMs: a.timeoutSec * 1000,
      });

      const hostTmp = path.join(cfg.workDir, `${stamp}.txt`);
      let output = "";
      let truncated = false;
      try {
        await vmrun.copyFileFromGuest(cred, vmx, guestOut, hostTmp);
        const buf = fs.readFileSync(hostTmp);
        truncated = buf.length > a.maxBytes;
        output = buf.subarray(0, a.maxBytes).toString("utf8");
      } catch (e) {
        output = `(could not retrieve output file: ${(e as Error).message})`;
      } finally {
        fs.rmSync(hostTmp, { force: true });
        await vmrun.deleteFileInGuest(cred, vmx, guestOut).catch(() => undefined);
      }

      return json({ exitCode: r.code, shell: interpreter, output, truncated });
    },
  );

  defineTool(
    server,
    "guest_copy_to",
    {
      title: "Copy a file into the guest",
      description: "Copy a single file from the host into the guest. The destination directory must already exist.",
      inputSchema: {
        ...vmArg,
        hostPath: z.string().describe("Absolute path on the host"),
        guestPath: z.string().describe("Absolute destination path inside the guest"),
        ...credArgs,
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      if (!fs.existsSync(a.hostPath)) throw new Error(`No such host file: ${a.hostPath}`);
      await vmrun.copyFileToGuest(credFor(vmx, a), vmx, path.resolve(a.hostPath), a.guestPath);
      return text(`Copied ${a.hostPath} → ${a.guestPath}`);
    },
  );

  defineTool(
    server,
    "guest_copy_from",
    {
      title: "Copy a file out of the guest",
      description:
        "Copy a single file from the guest to the host. If hostPath is omitted the file lands in the server's work directory and the path is returned.",
      inputSchema: {
        ...vmArg,
        guestPath: z.string().describe("Absolute path inside the guest"),
        hostPath: z.string().optional().describe("Absolute destination on the host"),
        ...credArgs,
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      const dest = a.hostPath
        ? path.resolve(a.hostPath)
        : path.join(cfg.workDir, `${Date.now()}-${path.basename(a.guestPath.replace(/\\/g, "/"))}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await vmrun.copyFileFromGuest(credFor(vmx, a), vmx, a.guestPath, dest);
      return json({ guestPath: a.guestPath, hostPath: dest, sizeBytes: fs.statSync(dest).size });
    },
  );

  defineTool(
    server,
    "guest_copy_to_dir",
    {
      title: "Copy a directory into the guest",
      description:
        "Copy an entire host directory tree into the guest, file by file. VMware Tools only offers single-file copy, so this walks the tree.",
      inputSchema: {
        ...vmArg,
        hostDir: z.string().describe("Absolute host directory to copy"),
        guestDir: z.string().describe("Destination directory inside the guest; will be created"),
        ...credArgs,
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      const cred = credFor(vmx, a);

      if (!fs.existsSync(a.hostDir) || !fs.statSync(a.hostDir).isDirectory()) {
        throw new Error(`Not a directory on the host: ${a.hostDir}`);
      }

      await vmrun.createDirectoryInGuest(cred, vmx, a.guestDir).catch(() => undefined);

      let copied = 0;
      let failed = 0;
      const failures: string[] = [];

      function walk(dir: string, guestBase: string): string[] {
        const entries: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const hostPath = path.join(dir, entry.name);
          const rel = path.relative(a.hostDir, hostPath).replace(/\\/g, "/");
          const guestPath = `${guestBase.replace(/\\/g, "/")}/${rel}`;
          if (entry.isDirectory()) {
            entries.push(...walk(hostPath, guestBase));
          } else {
            entries.push(hostPath);
          }
        }
        return entries;
      }

      const files = walk(a.hostDir, a.guestDir);
      for (const hostPath of files) {
        const rel = path.relative(a.hostDir, hostPath).replace(/\\/g, "/");
        const guestPath = `${a.guestDir.replace(/\\/g, "/")}/${rel}`;
        try {
          const guestDir = path.posix.dirname(guestPath);
          await vmrun.createDirectoryInGuest(cred, vmx, guestDir).catch(() => undefined);
          await vmrun.copyFileToGuest(cred, vmx, hostPath, guestPath);
          copied++;
        } catch (e) {
          failed++;
          failures.push(`${guestPath}: ${(e as Error).message}`);
        }
      }

      return json({ hostDir: a.hostDir, guestDir: a.guestDir, copied, failed, failures });
    },
  );

  defineTool(
    server,
    "guest_copy_from_dir",
    {
      title: "Copy a directory out of the guest",
      description:
        "Copy an entire guest directory tree to the host, file by file. Lists the guest directory recursively, then copies each file individually.",
      inputSchema: {
        ...vmArg,
        guestDir: z.string().describe("Absolute guest directory to copy"),
        hostDir: z.string().optional().describe("Destination host directory; defaults to work directory"),
        ...credArgs,
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      const cred = credFor(vmx, a);

      const dest = a.hostDir
        ? path.resolve(a.hostDir)
        : path.join(cfg.workDir, `copy-${Date.now()}`);
      fs.mkdirSync(dest, { recursive: true });

      async function listRecursive(guestPath: string): Promise<string[]> {
        const files: string[] = [];
        let entries: string[];
        try {
          entries = await vmrun.listDirectoryInGuest(cred, vmx, guestPath);
        } catch {
          return files;
        }
        for (const entry of entries) {
          const full = guestPath.replace(/\/+$/, "") + "/" + entry;
          try {
            const isDir = await vmrun.directoryExistsInGuest(cred, vmx, full);
            if (isDir) {
              const sub = await listRecursive(full);
              files.push(...sub);
            } else {
              files.push(full);
            }
          } catch {
            files.push(full);
          }
        }
        return files;
      }

      const guestFiles = await listRecursive(a.guestDir);

      let copied = 0;
      let failed = 0;
      const failures: string[] = [];

      for (const gf of guestFiles) {
        const rel = path.posix.relative(a.guestDir.replace(/\\/g, "/"), gf);
        const hostPath = path.join(dest, rel.split("/").join(path.sep));
        try {
          fs.mkdirSync(path.dirname(hostPath), { recursive: true });
          await vmrun.copyFileFromGuest(cred, vmx, gf, hostPath);
          copied++;
        } catch (e) {
          failed++;
          failures.push(`${rel}: ${(e as Error).message}`);
        }
      }

      return json({ guestDir: a.guestDir, hostDir: dest, copied, failed, total: guestFiles.length, failures });
    },
  );

  defineTool(
    server,
    "guest_read_file",
    {
      title: "Read a text file from the guest",
      description: "Fetch a text file out of the guest and return its contents inline.",
      inputSchema: {
        ...vmArg,
        guestPath: z.string(),
        maxBytes: z.number().int().min(1024).max(4_000_000).default(200_000),
        ...credArgs,
      },
      readOnly: true,
    },
    async (a) => {
      const cfg = loadConfig();
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      const tmp = path.join(cfg.workDir, `read-${Date.now()}.bin`);
      try {
        await vmrun.copyFileFromGuest(credFor(vmx, a), vmx, a.guestPath, tmp);
        const buf = fs.readFileSync(tmp);
        const truncated = buf.length > a.maxBytes;
        return json({
          guestPath: a.guestPath,
          sizeBytes: buf.length,
          truncated,
          content: buf.subarray(0, a.maxBytes).toString("utf8"),
        });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
  );

  defineTool(
    server,
    "guest_write_file",
    {
      title: "Write a text file into the guest",
      description:
        "Create or overwrite a text file inside the guest. Content is staged on the host and copied in, so it is safe for content containing quotes, newlines, or shell metacharacters.",
      inputSchema: {
        ...vmArg,
        guestPath: z.string(),
        content: z.string(),
        ...credArgs,
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      const tmp = path.join(cfg.workDir, `write-${Date.now()}.tmp`);
      try {
        fs.writeFileSync(tmp, a.content, "utf8");
        await vmrun.copyFileToGuest(credFor(vmx, a), vmx, tmp, a.guestPath);
        return text(`Wrote ${Buffer.byteLength(a.content)} bytes to ${a.guestPath}`);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
  );

  defineTool(
    server,
    "guest_list_dir",
    {
      title: "List a directory in the guest",
      description: "List the contents of a directory inside the guest.",
      inputSchema: { ...vmArg, guestPath: z.string(), ...credArgs },
      readOnly: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      const entries = await vmrun.listDirectoryInGuest(credFor(vmx, a), vmx, a.guestPath);
      return json({ guestPath: a.guestPath, count: entries.length, entries });
    },
  );

  defineTool(
    server,
    "guest_path_exists",
    {
      title: "Check a path in the guest",
      description: "Report whether a path inside the guest exists, and whether it is a file or a directory.",
      inputSchema: { ...vmArg, guestPath: z.string(), ...credArgs },
      readOnly: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      const cred = credFor(vmx, a);
      const [isFile, isDir] = await Promise.all([
        vmrun.fileExistsInGuest(cred, vmx, a.guestPath),
        vmrun.directoryExistsInGuest(cred, vmx, a.guestPath),
      ]);
      return json({ guestPath: a.guestPath, exists: isFile || isDir, isFile, isDirectory: isDir });
    },
  );

  defineTool(
    server,
    "guest_mkdir",
    {
      title: "Create a directory in the guest",
      description: "Create a directory inside the guest.",
      inputSchema: { ...vmArg, guestPath: z.string(), ...credArgs },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      await vmrun.createDirectoryInGuest(credFor(vmx, a), vmx, a.guestPath);
      return text(`Created ${a.guestPath} in guest.`);
    },
  );

  defineTool(
    server,
    "guest_delete",
    {
      title: "Delete a file or directory in the guest",
      description: "Delete a file or a directory inside the guest.",
      inputSchema: {
        ...vmArg,
        guestPath: z.string(),
        isDirectory: z.boolean().default(false),
        ...credArgs,
      },
      destructive: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      const cred = credFor(vmx, a);
      if (a.isDirectory) await vmrun.deleteDirectoryInGuest(cred, vmx, a.guestPath);
      else await vmrun.deleteFileInGuest(cred, vmx, a.guestPath);
      return text(`Deleted ${a.guestPath} in guest.`);
    },
  );

  defineTool(
    server,
    "guest_list_processes",
    {
      title: "List guest processes",
      description: "List processes running inside the guest, with pid, owner, and command line.",
      inputSchema: {
        ...vmArg,
        filter: z.string().optional().describe("Case-insensitive substring match on the command line"),
        ...credArgs,
      },
      readOnly: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      let procs = await vmrun.listProcessesInGuest(credFor(vmx, a), vmx);
      if (a.filter) {
        const f = a.filter.toLowerCase();
        procs = procs.filter((p) => (p.cmd ?? "").toLowerCase().includes(f));
      }
      return json({ count: procs.length, processes: procs });
    },
  );

  defineTool(
    server,
    "guest_rename",
    {
      title: "Rename a file or directory in the guest",
      description: "Rename or move a file or directory inside the guest.",
      inputSchema: {
        ...vmArg,
        fromPath: z.string().describe("Current path inside the guest"),
        toPath: z.string().describe("New path inside the guest"),
        ...credArgs,
      },
      destructive: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      await vmrun.renameFileInGuest(credFor(vmx, a), vmx, a.fromPath, a.toPath);
      return text(`Renamed ${a.fromPath} → ${a.toPath} in guest.`);
    },
  );

  defineTool(
    server,
    "guest_kill_process",
    {
      title: "Kill a guest process",
      description: "Terminate a process inside the guest by pid.",
      inputSchema: { ...vmArg, pid: z.number().int().positive(), ...credArgs },
      destructive: true,
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      await assertToolsRunning(vmx);
      await vmrun.killProcessInGuest(credFor(vmx, a), vmx, a.pid);
      return text(`Killed pid ${a.pid} in guest.`);
    },
  );
}
