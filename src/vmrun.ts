import { loadConfig, type GuestCredential } from "./config.js";
import { run, type ExecResult, type RunOptions } from "./exec.js";

/** Global flags must precede the command; guest creds are global flags. */
function baseArgs(cred?: GuestCredential): string[] {
  const args = ["-T", "ws"];
  if (cred) args.push("-gu", cred.username, "-gp", cred.password);
  return args;
}

export function vmrun(argv: string[], opts?: RunOptions): Promise<ExecResult> {
  return run(loadConfig().vmrun, [...baseArgs(), ...argv], opts);
}

export function vmrunGuest(
  cred: GuestCredential,
  argv: string[],
  opts?: RunOptions,
): Promise<ExecResult> {
  return run(loadConfig().vmrun, [...baseArgs(cred), ...argv], opts);
}

// ---------------------------------------------------------------- power

export type PowerMode = "gui" | "nogui";
export type StopMode = "hard" | "soft";

export const start = (vmx: string, mode: PowerMode = "nogui") =>
  vmrun(["start", vmx, mode]);
export const stop = (vmx: string, mode: StopMode = "soft") => vmrun(["stop", vmx, mode]);
export const reset = (vmx: string, mode: StopMode = "soft") => vmrun(["reset", vmx, mode]);
export const suspend = (vmx: string, mode: StopMode = "soft") => vmrun(["suspend", vmx, mode]);
export const pause = (vmx: string) => vmrun(["pause", vmx]);
export const unpause = (vmx: string) => vmrun(["unpause", vmx]);
export const deleteVM = (vmx: string) => vmrun(["deleteVM", vmx]);

export const clone = (
  vmx: string,
  destVmx: string,
  mode: "full" | "linked",
  opts: { snapshot?: string; cloneName?: string } = {},
) => {
  const argv = ["clone", vmx, destVmx, mode];
  if (opts.snapshot) argv.push(`-snapshot=${opts.snapshot}`);
  if (opts.cloneName) argv.push(`-cloneName=${opts.cloneName}`);
  // Full clones of a large disk can far exceed the default timeout.
  return vmrun(argv, { timeoutMs: 60 * 60_000 });
};

/** Paths of every currently-running VM. */
export async function listRunning(): Promise<string[]> {
  const { stdout } = await vmrun(["list"]);
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.toLowerCase().endsWith(".vmx"));
}

export async function isRunning(vmx: string): Promise<boolean> {
  const target = vmx.toLowerCase();
  return (await listRunning()).some((p) => p.toLowerCase() === target);
}

// ---------------------------------------------------------------- tools

export type ToolsState = "running" | "installed" | "notInstalled" | "notRunning" | "unknown";

export async function checkToolsState(vmx: string): Promise<ToolsState> {
  const { stdout } = await vmrun(["checkToolsState", vmx], { allowFailure: true });
  const s = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (/^running$/i.test(s)) return "running";
  if (/^installed$/i.test(s)) return "installed";
  if (/^notinstalled$/i.test(s)) return "notInstalled";
  if (/^notrunning$/i.test(s)) return "notRunning";
  return "unknown";
}

export const installTools = (vmx: string) => vmrun(["installTools", vmx]);

// ---------------------------------------------------------------- snapshots

export const snapshot = (vmx: string, name: string) => vmrun(["snapshot", vmx, name], {
  timeoutMs: 15 * 60_000,
});
export const revertToSnapshot = (vmx: string, name: string) =>
  vmrun(["revertToSnapshot", vmx, name], { timeoutMs: 15 * 60_000 });
export const deleteSnapshot = (vmx: string, name: string, andChildren = false) =>
  vmrun(andChildren ? ["deleteSnapshot", vmx, name, "andDeleteChildren"] : ["deleteSnapshot", vmx, name], {
    timeoutMs: 30 * 60_000,
  });

export async function listSnapshots(vmx: string, showTree = false): Promise<string[]> {
  const { stdout } = await vmrun(showTree ? ["listSnapshots", vmx, "showTree"] : ["listSnapshots", vmx]);
  const lines = stdout.split(/\r?\n/);
  // First line is "Total snapshots: N"; the rest are names (indented in tree mode).
  return lines.slice(1).map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
}

// ---------------------------------------------------------------- guest ops

export interface GuestRunOptions {
  noWait?: boolean;
  activeWindow?: boolean;
  interactive?: boolean;
  timeoutMs?: number;
}

function guestFlags(o: GuestRunOptions): string[] {
  const f: string[] = [];
  if (o.noWait) f.push("-noWait");
  if (o.activeWindow) f.push("-activeWindow");
  if (o.interactive) f.push("-interactive");
  return f;
}

export const runProgramInGuest = (
  cred: GuestCredential,
  vmx: string,
  program: string,
  args: string[] = [],
  o: GuestRunOptions = {},
) =>
  vmrunGuest(cred, ["runProgramInGuest", vmx, ...guestFlags(o), program, ...args], {
    timeoutMs: o.timeoutMs,
    allowFailure: true, // guest exit codes are data, not transport failures
  });

export const runScriptInGuest = (
  cred: GuestCredential,
  vmx: string,
  interpreter: string,
  script: string,
  o: GuestRunOptions = {},
) =>
  vmrunGuest(cred, ["runScriptInGuest", vmx, ...guestFlags(o), interpreter, script], {
    timeoutMs: o.timeoutMs,
    allowFailure: true,
  });

export const copyFileToGuest = (cred: GuestCredential, vmx: string, hostPath: string, guestPath: string) =>
  vmrunGuest(cred, ["CopyFileFromHostToGuest", vmx, hostPath, guestPath], { timeoutMs: 30 * 60_000 });

export const copyFileFromGuest = (cred: GuestCredential, vmx: string, guestPath: string, hostPath: string) =>
  vmrunGuest(cred, ["CopyFileFromGuestToHost", vmx, guestPath, hostPath], { timeoutMs: 30 * 60_000 });

export const deleteFileInGuest = (cred: GuestCredential, vmx: string, guestPath: string) =>
  vmrunGuest(cred, ["deleteFileInGuest", vmx, guestPath]);

export const createDirectoryInGuest = (cred: GuestCredential, vmx: string, guestPath: string) =>
  vmrunGuest(cred, ["createDirectoryInGuest", vmx, guestPath]);

export const deleteDirectoryInGuest = (cred: GuestCredential, vmx: string, guestPath: string) =>
  vmrunGuest(cred, ["deleteDirectoryInGuest", vmx, guestPath]);

export const renameFileInGuest = (cred: GuestCredential, vmx: string, from: string, to: string) =>
  vmrunGuest(cred, ["renameFileInGuest", vmx, from, to]);

export async function listDirectoryInGuest(
  cred: GuestCredential,
  vmx: string,
  guestPath: string,
): Promise<string[]> {
  const { stdout } = await vmrunGuest(cred, ["listDirectoryInGuest", vmx, guestPath]);
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    // vmrun prefixes the listing with "Directory list: <count>". The old filter
    // only matched a bare "Directory list", so the header leaked through as a
    // filename — guest_list_dir reported it as an entry, and the recursive copy
    // then tried to fetch a file by that name.
    .filter((l) => l && !/^Directory list:?\s*\d*$/i.test(l));
}

export async function fileExistsInGuest(cred: GuestCredential, vmx: string, guestPath: string) {
  const { stdout } = await vmrunGuest(cred, ["fileExistsInGuest", vmx, guestPath], {
    allowFailure: true,
  });
  return /file exists/i.test(stdout);
}

export async function directoryExistsInGuest(cred: GuestCredential, vmx: string, guestPath: string) {
  const { stdout } = await vmrunGuest(cred, ["directoryExistsInGuest", vmx, guestPath], {
    allowFailure: true,
  });
  return /directory exists/i.test(stdout);
}

export interface GuestProcess {
  pid: number;
  owner?: string;
  cmd?: string;
}

export async function listProcessesInGuest(
  cred: GuestCredential,
  vmx: string,
): Promise<GuestProcess[]> {
  const { stdout } = await vmrunGuest(cred, ["listProcessesInGuest", vmx]);
  const out: GuestProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    // Format: pid=123, owner=NT AUTHORITY\SYSTEM, cmd=C:\...\foo.exe
    const m = /^pid=(\d+)(?:,\s*owner=(.*?))?(?:,\s*cmd=(.*))?$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), owner: m[2], cmd: m[3] });
  }
  return out;
}

export const killProcessInGuest = (cred: GuestCredential, vmx: string, pid: number) =>
  vmrunGuest(cred, ["killProcessInGuest", vmx, String(pid)]);

export const typeKeystrokesInGuest = (cred: GuestCredential, vmx: string, keys: string) =>
  vmrunGuest(cred, ["typeKeystrokesInGuest", vmx, keys]);

export const captureScreen = (vmx: string, hostPath: string) =>
  vmrun(["captureScreen", vmx, hostPath]);

export async function getGuestIPAddress(vmx: string, wait = false): Promise<string | null> {
  const { stdout, code } = await vmrun(wait ? ["getGuestIPAddress", vmx, "-wait"] : ["getGuestIPAddress", vmx], {
    allowFailure: true,
    timeoutMs: wait ? 10 * 60_000 : undefined,
  });
  const ip = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
  return code === 0 && /^[0-9a-f.:]+$/i.test(ip) ? ip : null;
}

// ---------------------------------------------------------------- shared folders

export const enableSharedFolders = (vmx: string) => vmrun(["enableSharedFolders", vmx]);
export const disableSharedFolders = (vmx: string) => vmrun(["disableSharedFolders", vmx]);
export const addSharedFolder = (vmx: string, shareName: string, hostPath: string) =>
  vmrun(["addSharedFolder", vmx, shareName, hostPath]);
export const removeSharedFolder = (vmx: string, shareName: string) =>
  vmrun(["removeSharedFolder", vmx, shareName]);
export const setSharedFolderState = (
  vmx: string,
  shareName: string,
  hostPath: string,
  mode: "writable" | "readonly",
) => vmrun(["setSharedFolderState", vmx, shareName, hostPath, mode]);

// ---------------------------------------------------------------- devices

export const connectNamedDevice = (vmx: string, device: string) =>
  vmrun(["connectNamedDevice", vmx, device]);
export const disconnectNamedDevice = (vmx: string, device: string) =>
  vmrun(["disconnectNamedDevice", vmx, device]);
