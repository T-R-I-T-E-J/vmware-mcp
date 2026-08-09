import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";

export type VmLifecycle =
  | "created"
  | "provisioning"
  | "ready"
  | "failed"
  | "imported";

export interface VmRecord {
  name: string;
  vmxPath: string;
  guestOsId: string;
  /** Family drives which unattended-install strategy applies. */
  osFamily: "windows" | "debian" | "ubuntu" | "other";
  lifecycle: VmLifecycle;
  credentialRef?: string;
  tags: string[];
  installIso?: string;
  seedIso?: string;
  createdAt: string;
  updatedAt: string;
  /** Free-form progress notes from provision.ts, newest last. */
  notes: string[];
  lastError?: string;
}

interface RegistryFile {
  version: 1;
  vms: Record<string, VmRecord>;
}

function registryPath(): string {
  return path.join(loadConfig().vmRoot, ".vmware-mcp", "registry.json");
}

function emptyRegistry(): RegistryFile {
  return { version: 1, vms: {} };
}

export function readRegistry(): RegistryFile {
  const p = registryPath();
  if (!fs.existsSync(p)) return emptyRegistry();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as RegistryFile;
    if (!parsed || typeof parsed !== "object" || !parsed.vms) return emptyRegistry();
    return parsed;
  } catch {
    // A corrupt registry must not brick the server — VMs are discoverable from disk.
    return emptyRegistry();
  }
}

/**
 * Run a read-modify-write against the registry under a cross-process lock.
 *
 * Within one process no lock is needed: every registry operation is synchronous
 * (`readFileSync` … `renameSync`) with no `await` in between, so Node's single
 * thread cannot interleave two of them. The hazard is *multiple processes* —
 * each helper script spawns its own server, and they share both the file and,
 * previously, a single `registry.json.tmp` staging name, so two concurrent
 * writers could clobber each other's staging file.
 *
 * The lock is a directory, because `mkdirSync` is atomic on every platform and
 * needs no flags. A stale lock older than 30s is broken rather than deadlocking
 * a server whose predecessor was killed mid-write — which happens routinely here.
 */
function withRegistryLock<T>(fn: () => T): T {
  const lockDir = path.join(path.dirname(registryPath()), ".registry.lock");
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch {
      const age = (() => {
        try { return Date.now() - fs.statSync(lockDir).mtimeMs; } catch { return 0; }
      })();
      if (age > 30_000) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* another process won the race */ }
        continue;
      }
      if (Date.now() > deadline) break; // proceed unlocked rather than fail the caller
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // brief sync sleep
    }
  }

  try {
    return fn();
  } finally {
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

function writeRegistry(reg: RegistryFile): void {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Unique staging name: a shared "registry.json.tmp" is itself a collision
  // point when two server processes write at the same moment.
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing staged */ }
    throw e;
  }
}

export function getRecord(name: string): VmRecord | undefined {
  return readRegistry().vms[name];
}

export function findRecordByVmx(vmxPath: string): VmRecord | undefined {
  const target = vmxPath.toLowerCase();
  return Object.values(readRegistry().vms).find((r) => r.vmxPath.toLowerCase() === target);
}

export function upsertRecord(rec: Omit<VmRecord, "createdAt" | "updatedAt" | "notes" | "tags"> & {
  tags?: string[];
  notes?: string[];
}): VmRecord {
  return withRegistryLock(() => {
  const reg = readRegistry();
  const now = new Date().toISOString();
  const existing = reg.vms[rec.name];
  const merged: VmRecord = {
    ...existing,
    ...rec,
    tags: rec.tags ?? existing?.tags ?? [],
    notes: rec.notes ?? existing?.notes ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  reg.vms[rec.name] = merged;
  writeRegistry(reg);
  return merged;
  });
}

export function updateRecord(name: string, patch: Partial<VmRecord>): VmRecord | undefined {
  return withRegistryLock(() => {
    const reg = readRegistry();
    const existing = reg.vms[name];
    if (!existing) return undefined;
    reg.vms[name] = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    writeRegistry(reg);
    return reg.vms[name];
  });
}

export function appendNote(name: string, note: string): void {
  withRegistryLock(() => {
    const reg = readRegistry();
    const rec = reg.vms[name];
    if (!rec) return;
    rec.notes = [...(rec.notes ?? []), `[${new Date().toISOString()}] ${note}`].slice(-100);
    rec.updatedAt = new Date().toISOString();
    writeRegistry(reg);
  });
}

export function removeRecord(name: string): void {
  withRegistryLock(() => {
    const reg = readRegistry();
    delete reg.vms[name];
    writeRegistry(reg);
  });
}

export function listRecords(): VmRecord[] {
  return Object.values(readRegistry().vms).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Select VMs by name, glob, or tag. Used by the fleet_* tools.
 * "*" matches everything; "tag:lab" matches by tag; "win*" globs on name.
 */
export function selectRecords(selector: string): VmRecord[] {
  const all = listRecords();
  if (selector === "*") return all;
  if (selector.startsWith("tag:")) {
    const tag = selector.slice(4);
    return all.filter((r) => r.tags.includes(tag));
  }
  if (selector.includes("*") || selector.includes("?")) {
    const rx = new RegExp(
      `^${selector.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
      "i",
    );
    return all.filter((r) => rx.test(r.name));
  }
  return all.filter((r) => r.name === selector);
}
