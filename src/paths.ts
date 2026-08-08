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
