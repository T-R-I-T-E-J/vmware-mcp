import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

/** Guest credentials for VMware Tools guest operations. */
export interface GuestCredential {
  username: string;
  password: string;
}

export interface Config {
  /** VMware Workstation install directory containing vmrun.exe / vmcli.exe. */
  vmwareDir: string;
  vmrun: string;
  vmcli: string;
  vdiskmanager: string;
  /** VMware Tools ISO for Windows guests, shipped with Workstation. */
  toolsWindowsIso: string | null;

  /** Allowlist boundary. Every VM path must resolve under here. */
  vmRoot: string;
  /** Read-only install-media library. */
  isoLibrary: string;
  /** Extra individually-allowlisted VM paths outside vmRoot. */
  extraVmPaths: string[];

  /** Scratch space for screenshots, generated seed files, built ISOs. */
  workDir: string;
  /** Where named guest credentials are stored. */
  credentialsFile: string;

  /** Default timeout for a single vmrun/vmcli invocation, ms. */
  execTimeoutMs: number;
  /** Cap on VMs a fleet_* call will act on at once. */
  defaultConcurrency: number;
  /** Refuse to power on more than this many VMs at once. */
  maxRunningVms: number;
}

function envPath(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? path.resolve(v.trim()) : fallback;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function firstExisting(...candidates: string[]): string | null {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function resolveVmwareDir(): string {
  const fromEnv = process.env.VMWARE_DIR;
  if (fromEnv && fs.existsSync(path.join(fromEnv, "vmrun.exe"))) return path.resolve(fromEnv);

  const found = firstExisting(
    "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe",
    "C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe",
  );
  if (found) return path.dirname(found);

  throw new Error(
    "Could not locate VMware Workstation. Set VMWARE_DIR to the directory containing vmrun.exe.",
  );
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const vmwareDir = resolveVmwareDir();
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");

  cached = {
    vmwareDir,
    vmrun: path.join(vmwareDir, "vmrun.exe"),
    vmcli: path.join(vmwareDir, "vmcli.exe"),
    vdiskmanager: path.join(vmwareDir, "vmware-vdiskmanager.exe"),
    toolsWindowsIso: firstExisting(path.join(vmwareDir, "windows.iso")),

    // Default under the user profile, not a drive root and not removable media.
    // A directory at a drive root inherits restrictive ACLs and makes
    // `vmcli VM Create` fail with only "Create VM failed"; a USB drive survives
    // light use then kills installs with guest-side I/O errors. Both cost a
    // wasted install before being diagnosed — see issues #14 and #15.
    vmRoot: envPath("VM_ROOT", path.join(os.homedir(), "VMs")),
    isoLibrary: envPath("ISO_LIBRARY", path.join(os.homedir(), "iso")),
    extraVmPaths: (process.env.EXTRA_VM_PATHS ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => path.resolve(s)),

    workDir: envPath("VMWARE_MCP_WORK_DIR", path.join(appData, "vmware-mcp", "work")),
    credentialsFile: envPath(
      "VMWARE_MCP_CREDENTIALS",
      path.join(appData, "vmware-mcp", "credentials.json"),
    ),

    execTimeoutMs: envInt("VMWARE_MCP_EXEC_TIMEOUT_MS", 120_000),
    defaultConcurrency: envInt("VMWARE_MCP_CONCURRENCY", 4),
    maxRunningVms: envInt("VMWARE_MCP_MAX_RUNNING_VMS", 8),
  };

  fs.mkdirSync(cached.workDir, { recursive: true });
  return cached;
}

/**
 * Named credentials live outside the repo so passwords never appear in tool args
 * or transcripts. Shape: { "win10-lab": { "username": "...", "password": "..." } }
 */
export function loadCredential(ref: string): GuestCredential {
  const { credentialsFile } = loadConfig();
  if (!fs.existsSync(credentialsFile)) {
    throw new Error(
      `No credentials file at ${credentialsFile}. Create it as {"${ref}":{"username":"...","password":"..."}} or pass guestUser/guestPassword directly.`,
    );
  }
  let parsed: Record<string, GuestCredential>;
  try {
    parsed = JSON.parse(fs.readFileSync(credentialsFile, "utf8"));
  } catch (e) {
    throw new Error(`Credentials file ${credentialsFile} is not valid JSON: ${(e as Error).message}`);
  }
  const cred = parsed[ref];
  if (!cred?.username || typeof cred.password !== "string") {
    throw new Error(`Credential "${ref}" not found in ${credentialsFile} (or missing username/password).`);
  }
  return cred;
}

/**
 * Restrict a file to the current user.
 *
 * `writeFileSync`'s `mode: 0o600` is close to meaningless on Windows — POSIX
 * mode bits do not map onto NTFS ACLs, and the credentials file came out
 * world-readable in practice. `icacls` is the only thing that actually applies.
 */
function restrictToCurrentUser(file: string): void {
  if (process.platform !== "win32") {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return;
  }
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 15_000,
    });
  } catch {
    // Not fatal — the file is still written. Surfaced by checkCredentialsFilePermissions().
  }
}

/**
 * True when the credentials file is readable by anyone beyond its owner.
 * Reported at startup so a false sense of security is not left standing.
 */
export function credentialsFileIsExposed(): boolean {
  const { credentialsFile } = loadConfig();
  if (!fs.existsSync(credentialsFile) || process.platform !== "win32") return false;
  try {
    const acl = execFileSync("icacls", [credentialsFile], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    return /\b(Everyone|BUILTIN\\Users|Authenticated Users)\b/i.test(acl);
  } catch {
    return false;
  }
}

export function saveCredential(ref: string, cred: GuestCredential): void {
  const { credentialsFile } = loadConfig();
  fs.mkdirSync(path.dirname(credentialsFile), { recursive: true });
  let existing: Record<string, GuestCredential> = {};
  if (fs.existsSync(credentialsFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(credentialsFile, "utf8"));
    } catch {
      /* overwrite a corrupt file rather than lose the new credential */
    }
  }
  existing[ref] = cred;
  fs.writeFileSync(credentialsFile, JSON.stringify(existing, null, 2), { mode: 0o600 });
  // mode: 0o600 alone does nothing useful on Windows; apply a real ACL.
  restrictToCurrentUser(credentialsFile);
}

/**
 * Resolve guest credentials from either a stored ref or inline args.
 * Inline wins so a caller can override a stale stored password.
 */
export function resolveCredential(args: {
  credentialRef?: string;
  guestUser?: string;
  guestPassword?: string;
}): GuestCredential {
  if (args.guestUser && args.guestPassword !== undefined) {
    return { username: args.guestUser, password: args.guestPassword };
  }
  if (args.credentialRef) return loadCredential(args.credentialRef);
  throw new Error("Guest credentials required: pass credentialRef, or guestUser + guestPassword.");
}
