import fs from "node:fs";
import path from "node:path";

export type VmxConfig = Map<string, string>;

/**
 * A .vmx is a flat `key = "value"` file. We parse and rewrite it directly rather
 * than going through `vmcli ConfigParams SetEntry` for bulk edits, because a VM
 * being built from scratch needs a dozen keys set before it is ever powered on,
 * and one file write beats a dozen process spawns.
 *
 * Keys are stored lowercase because VMware treats them case-insensitively but
 * writes them in mixed case.
 */
export function parseVmx(vmxPath: string): VmxConfig {
  const cfg: VmxConfig = new Map();
  const text = fs.readFileSync(vmxPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    cfg.set(key.toLowerCase(), value);
  }
  return cfg;
}

export function writeVmx(vmxPath: string, cfg: VmxConfig): void {
  const lines = [...cfg.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} = "${v.replace(/"/g, '\\"')}"`);
  // .encoding must be first for VMware to honor it, and the file needs a trailing newline.
  const encoding = cfg.get(".encoding");
  const body = encoding
    ? [`.encoding = "${encoding}"`, ...lines.filter((l) => !l.startsWith(".encoding"))]
    : lines;
  fs.writeFileSync(vmxPath, body.join("\n") + "\n", "utf8");
}

/** Read → mutate → write, preserving everything the mutator did not touch. */
export function patchVmx(vmxPath: string, changes: Record<string, string | null>): VmxConfig {
  const cfg = parseVmx(vmxPath);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) cfg.delete(k.toLowerCase());
    else cfg.set(k.toLowerCase(), v);
  }
  writeVmx(vmxPath, cfg);
  return cfg;
}

export function getVmxValue(cfg: VmxConfig, key: string): string | undefined {
  return cfg.get(key.toLowerCase());
}

// ---------------------------------------------------------------- hardware helpers

export interface CdromSpec {
  /** e.g. "sata0:1". Must not collide with the disk's device. */
  device: string;
  isoPath: string;
  startConnected?: boolean;
}

/** Attach an ISO as a CD-ROM. Used for install media, VMware Tools, and seed ISOs. */
export function cdromEntries(spec: CdromSpec): Record<string, string> {
  const d = spec.device.toLowerCase();
  return {
    [`${d}.present`]: "TRUE",
    [`${d}.devicetype`]: "cdrom-image",
    [`${d}.filename`]: spec.isoPath,
    [`${d}.startconnected`]: spec.startConnected === false ? "FALSE" : "TRUE",
  };
}

export function removeCdrom(cfg: VmxConfig, device: string): void {
  const prefix = `${device.toLowerCase()}.`;
  for (const k of [...cfg.keys()]) if (k.startsWith(prefix)) cfg.delete(k);
}

export type NetworkType = "nat" | "bridged" | "hostonly" | "custom" | "none";

export function ethernetEntries(index: number, type: NetworkType, customVnet?: string): Record<string, string> {
  const d = `ethernet${index}`;
  if (type === "none") {
    return { [`${d}.present`]: "FALSE" };
  }
  const out: Record<string, string> = {
    [`${d}.present`]: "TRUE",
    [`${d}.connectiontype`]: type,
    [`${d}.virtualdev`]: "e1000e",
    [`${d}.addresstype`]: "generated",
    [`${d}.startconnected`]: "TRUE",
  };
  if (type === "custom") {
    if (!customVnet) throw new Error('Network type "custom" requires a vnet name such as "VMnet2".');
    out[`${d}.vnet`] = customVnet;
  }
  return out;
}

export interface DiskSpec {
  /** e.g. "nvme0:0", "scsi0:0", "sata0:0" */
  device: string;
  vmdkFileName: string;
}

export function diskEntries(spec: DiskSpec): Record<string, string> {
  const d = spec.device.toLowerCase();
  const controller = d.split(":")[0];
  const entries: Record<string, string> = {
    [`${controller}.present`]: "TRUE",
    [`${d}.present`]: "TRUE",
    [`${d}.devicetype`]: "disk",
    [`${d}.filename`]: spec.vmdkFileName,
  };
  if (controller.startsWith("scsi")) entries[`${controller}.virtualdev`] = "lsisas1068";
  return entries;
}

/**
 * Remove stale `.lck` directories left beside a VM's files.
 *
 * VMware locks a VM while it runs and clears the lock on shutdown — but a
 * process killed mid-flight leaves the lock behind, after which VMware insists
 * the VM "is already running" and refuses to clone or start it. That happened
 * repeatedly here whenever a provisioning harness was killed.
 *
 * **The caller must first confirm the VM is not running.** Deleting a live lock
 * would let a second vmware-vmx open the same disk and corrupt it, so this
 * function deliberately does not decide that for itself.
 */
export function clearStaleLocks(vmDir: string): string[] {
  const cleared: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(vmDir, { withFileTypes: true });
  } catch {
    return cleared;
  }
  for (const e of entries) {
    if (!e.name.toLowerCase().endsWith(".lck")) continue;
    const full = path.join(vmDir, e.name);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      cleared.push(e.name);
    } catch {
      /* still held by something; leave it and let VMware report the conflict */
    }
  }
  return cleared;
}

/** Locate the .vmx inside a VM directory or a .vmwarevm bundle. */
export function findVmxInDir(dir: string): string | null {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const hits = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".vmx")).sort();
  return hits.length ? path.join(dir, hits[0]) : null;
}
