import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "./config.js";

export class PathNotAllowedError extends Error {
  constructor(target: string, reason: string) {
    super(`Refusing to operate on ${target}: ${reason}`);
    this.name = "PathNotAllowedError";
  }
}

/**
 * True if `child` is inside `parent`. Uses path.relative rather than string
 * prefixing so "G:\VMs-other" is not treated as inside "G:\VMs".
 */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve symlinks on the deepest existing ancestor, then re-append the missing
 * tail. Checking the literal path would let a symlink inside VM_ROOT point at
 * C:\Windows and pass; checking realpath of a not-yet-created path would throw.
 */
function realpathTolerant(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    if (fs.existsSync(current)) {
      return path.join(fs.realpathSync.native(current), ...tail.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(p);
    tail.push(path.basename(current));
    current = parent;
  }
}

/**
 * The allowlist gate. Every VM path entering the server passes through here
 * before it reaches vmrun or vmcli.
 */
export function assertVmPathAllowed(target: string): string {
  const cfg = loadConfig();
  if (!target || !target.trim()) throw new PathNotAllowedError(String(target), "empty path");

  const resolved = realpathTolerant(target);
  const root = realpathTolerant(cfg.vmRoot);

  if (isInside(root, resolved)) return resolved;

  for (const extra of cfg.extraVmPaths) {
    const e = realpathTolerant(extra);
    if (resolved === e || isInside(e, resolved)) return resolved;
  }

  throw new PathNotAllowedError(
    resolved,
    `it is outside VM_ROOT (${cfg.vmRoot}). Add it to EXTRA_VM_PATHS to allow it.`,
  );
}

/** As above, and the .vmx must already exist. */
export function assertVmxExists(target: string): string {
  const resolved = assertVmPathAllowed(target);
  if (!resolved.toLowerCase().endsWith(".vmx")) {
    throw new PathNotAllowedError(resolved, "expected a path to a .vmx file");
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`No such VM: ${resolved}`);
  }
  return resolved;
}

/** ISOs are read-only inputs; they must come from the ISO library. */
export function assertIsoAllowed(target: string): string {
  const cfg = loadConfig();
  const resolved = realpathTolerant(target);
  const lib = realpathTolerant(cfg.isoLibrary);
  if (!isInside(lib, resolved)) {
    throw new PathNotAllowedError(resolved, `ISOs must live under ISO_LIBRARY (${cfg.isoLibrary})`);
  }
  if (!fs.existsSync(resolved)) throw new Error(`No such ISO: ${resolved}`);
  return resolved;
}

/**
 * Verify VM_ROOT is somewhere VMware can actually build a VM, and warn about
 * storage that will fail slowly rather than fast.
 *
 * Both checks come from failures that each cost a wasted install:
 *
 * - A directory at a drive root (C:\VMs) inherits restrictive ACLs on Windows 11.
 *   `vmcli VM Create` gets far enough to leave a .vmx.lck behind, then reports
 *   only "Create VM failed" (#15).
 * - VMs or ISOs on a USB drive survive light use, then die mid-install with
 *   guest-side `I/O error, dev sr0` once VMware is doing sustained mixed I/O
 *   on a loaded host (#14).
 */
export function preflightStorage(): { errors: string[]; warnings: string[] } {
  const cfg = loadConfig();
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [label, dir] of [["VM_ROOT", cfg.vmRoot], ["ISO_LIBRARY", cfg.isoLibrary]] as const) {
    if (!fs.existsSync(dir)) {
      if (label === "VM_ROOT") {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
          errors.push(`${label} ${dir} does not exist and cannot be created: ${(e as Error).message}`);
          continue;
        }
      } else {
        warnings.push(`${label} ${dir} does not exist; list_isos will return nothing.`);
        continue;
      }
    }

    // A first-level directory at a drive root, e.g. C:\VMs.
    const parsed = path.parse(path.resolve(dir));
    if (path.dirname(path.resolve(dir)).toLowerCase() === parsed.root.toLowerCase()) {
      warnings.push(
        `${label} (${dir}) sits directly at a drive root. On Windows these inherit restrictive ACLs and "vmcli VM Create" can fail with only "Create VM failed". A path under your user profile, e.g. ${path.join(process.env.USERPROFILE ?? "C:\\Users\\you", path.basename(dir))}, is safer.`,
      );
    }
  }

  // Probe that VM_ROOT is genuinely writable, rather than trusting the ACL.
  if (fs.existsSync(cfg.vmRoot)) {
    const probe = path.join(cfg.vmRoot, `.vmware-mcp-write-probe-${process.pid}`);
    try {
      fs.mkdirSync(probe);
      fs.writeFileSync(path.join(probe, "t"), "t");
      fs.rmSync(probe, { recursive: true, force: true });
    } catch (e) {
      errors.push(
        `VM_ROOT ${cfg.vmRoot} is not writable (${(e as Error).message}). VM creation will fail with an unhelpful "Create VM failed" from vmcli.`,
      );
    }
  }

  return { errors, warnings };
}

/**
 * Locate a VM by bare name (folder under VM_ROOT) or by explicit .vmx path.
 * Also understands macOS-style .vmwarevm bundles, which is how the existing
 * Kali VM on this host is packaged.
 */
export function resolveVmxByNameOrPath(nameOrPath: string): string {
  const cfg = loadConfig();

  if (nameOrPath.toLowerCase().endsWith(".vmx")) return assertVmxExists(nameOrPath);

  const candidateDirs = [
    path.join(cfg.vmRoot, nameOrPath),
    ...cfg.extraVmPaths.filter((p) => path.basename(p).replace(/\.vmwarevm$/i, "") === nameOrPath),
    ...cfg.extraVmPaths,
  ];

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    const stat = fs.statSync(dir);
    if (stat.isFile() && dir.toLowerCase().endsWith(".vmx")) return assertVmxExists(dir);
    if (!stat.isDirectory()) continue;
    const vmx = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".vmx"))
      .sort();
    if (vmx.length > 0) return assertVmxExists(path.join(dir, vmx[0]));
  }

  throw new Error(
    `Could not find a VM named "${nameOrPath}" under ${cfg.vmRoot} or in EXTRA_VM_PATHS. Pass a full .vmx path instead.`,
  );
}
