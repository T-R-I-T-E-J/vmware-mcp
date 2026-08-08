import path from "node:path";
import fs from "node:fs";
import os from "node:os";

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

    vmRoot: envPath("VM_ROOT", "G:\\VMs"),
    isoLibrary: envPath("ISO_LIBRARY", "G:\\iso"),
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

  // Preflight: verify VM_ROOT is writable. A directory at a drive root (e.g.
  // C:\VMs) inherits restrictive ACLs on Windows, and vmcli VM Create fails
  // with an opaque "Create VM failed" message. Catch it early.
  runVmRootPreflight(cached);

  // Preflight: warn if VM_ROOT or ISO_LIBRARY is on a removable/USB drive.
  // Guest I/O on USB dies under sustained mixed random I/O — the failure
  // surfaces 40+ minutes into an install as squashfs read errors.
  runDriveTypePreflight(cached);

  return cached;
}

function runVmRootPreflight(cfg: Config): void {
  const vmRoot = cfg.vmRoot;
  try {
    fs.mkdirSync(vmRoot, { recursive: true });
  } catch (e) {
    throw new Error(
      `VM_ROOT (${vmRoot}) cannot be created. Check that the drive exists and the path is valid. ` +
        `Underlying error: ${(e as Error).message}`,
    );
  }
  const probe = path.join(vmRoot, ".vmware-mcp-writetest");
  try {
    fs.writeFileSync(probe, "ok", "utf8");
    fs.rmSync(probe, { force: true });
  } catch (e) {
    throw new Error(
      `VM_ROOT (${vmRoot}) is not writable. vmcli VM Create requires write access to this directory. ` +
        `Try a path under your user profile (e.g. C:\\Users\\<you>\\VMs) or check ACLs. ` +
        `Underlying error: ${(e as Error).message}`,
    );
  }

  // Warn if VM_ROOT is a first-level directory at a drive root.
  const parsed = path.parse(path.resolve(vmRoot));
  const parentDir = path.dirname(path.resolve(vmRoot));
  const parentParsed = path.parse(parentDir);
  if (parentParsed.root === parentDir) {
    process.stderr.write(
      `vmware-mcp: VM_ROOT is at a drive root (${parentDir}). On Windows this inherits restrictive ACLs ` +
        `that can cause vmcli VM Create to fail with "Create VM failed". Consider moving it under ` +
        `your user profile.\n`,
    );
  }
}

function runDriveTypePreflight(cfg: Config): void {
  // Quick heuristic: check if the resolved path starts with a known-removable
  // drive letter. A full Win32 API call (GetDriveType) would need native bindings,
  // so this warns based on common USB drive letters as a best-effort guard.
  const vmRootLetter = path.resolve(cfg.vmRoot).charAt(0).toUpperCase();
  const isoLetter = path.resolve(cfg.isoLibrary).charAt(0).toUpperCase();

  // D: and E: are commonly USB/CD-ROM; G: and higher are almost always USB on consumer Windows.
  const suspiciousLetters = ["D", "E", "F", "G", "H", "I", "J", "K"];
  for (const letter of suspiciousLetters) {
    if (vmRootLetter === letter || isoLetter === letter) {
      process.stderr.write(
        `vmware-mcp: VM_ROOT or ISO_LIBRARY is on drive ${letter}:. USB/external drives cause guest ` +
          `I/O errors during installs under sustained mixed random I/O. Use internal storage ` +
          `(C:) if possible. See issue #14 for details.\n`,
      );
      break;
    }
  }
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

export function saveCredential(ref: string, cred: GuestCredential): void {
  const { credentialsFile } = loadConfig();
  fs.mkdirSync(path.dirname(credentialsFile), { recursive: true });
  let existing: Record<string, GuestCredential> = {};
  if (fs.existsSync(credentialsFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(credentialsFile, "utf8"));
    } catch {
      process.stderr.write(
        `vmware-mcp: credentials file ${credentialsFile} is corrupt; overwriting with new contents.\n`,
      );
    }
  }
  existing[ref] = cred;
  // Atomic write: tmp + rename prevents a partially-written file on crash.
  const tmp = `${credentialsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, credentialsFile);
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
