import path from "node:path";
import fsSync from "node:fs";
import { run } from "./exec.js";

/**
 * Identify the bus a path's volume sits on.
 *
 * VMs and ISOs on a USB drive appear to work — light use is fine — and then an
 * install dies partway through with guest-side `I/O error, dev sr0` once VMware
 * is doing sustained mixed reads and writes on a loaded host. That cost a
 * 40-minute Ubuntu install before the cause was found (#14), so it is worth a
 * one-off PowerShell call at startup to warn about.
 */
export type BusType = "USB" | "NVMe" | "SATA" | "SAS" | "SCSI" | "RAID" | "Virtual" | "Unknown";

const cache = new Map<string, BusType>();

export async function busTypeFor(targetPath: string): Promise<BusType> {
  const drive = path.parse(path.resolve(targetPath)).root.replace(/\\$/, ""); // "C:"
  if (!/^[A-Za-z]:$/.test(drive)) return "Unknown";
  const key = drive.toUpperCase();
  const hit = cache.get(key);
  if (hit) return hit;

  // Partition -> Disk gives the bus; Get-Volume alone does not expose it.
  const script =
    `$p = Get-Partition -DriveLetter '${key[0]}' -ErrorAction SilentlyContinue; ` +
    `if ($p) { (Get-Disk -Number $p.DiskNumber).BusType } else { 'Unknown' }`;

  try {
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeoutMs: 20_000, allowFailure: true },
    );
    const raw = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
    const bus = (["USB", "NVMe", "SATA", "SAS", "SCSI", "RAID", "Virtual"] as const).find(
      (b) => b.toLowerCase() === raw.toLowerCase(),
    ) ?? "Unknown";
    cache.set(key, bus);
    return bus;
  } catch {
    return "Unknown";
  }
}

/**
 * Delete stale scratch files from the work directory.
 *
 * Screenshots accumulated forever — 31 after a single session of provisioning
 * four VMs — and provisioning screenshots capture whatever was on the guest's
 * screen at the time, which is not something to keep indefinitely by default.
 * Seed ISOs are deliberately not matched here: those are deleted the moment
 * provisioning finishes, because they contain the guest password in clear text.
 */
export function pruneWorkDir(workDir: string, maxAgeDays: number): { deleted: number; freedBytes: number } {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let deleted = 0;
  let freedBytes = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = fsSync.readdirSync(workDir, { withFileTypes: true });
  } catch {
    return { deleted, freedBytes };
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/^(screen-|read-|write-|vmmcp-)/.test(e.name)) continue;
    const full = path.join(workDir, e.name);
    try {
      const st = fsSync.statSync(full);
      if (st.mtimeMs > cutoff) continue;
      fsSync.rmSync(full, { force: true });
      deleted++;
      freedBytes += st.size;
    } catch {
      /* raced with something else; skip */
    }
  }
  return { deleted, freedBytes };
}

export async function removableStorageWarnings(paths: Array<{ label: string; dir: string }>): Promise<string[]> {
  const warnings: string[] = [];
  for (const { label, dir } of paths) {
    const bus = await busTypeFor(dir);
    if (bus === "USB") {
      warnings.push(
        `${label} (${dir}) is on a USB drive. Installs typically run for tens of minutes and then fail with "I/O error, dev sr0" in the guest, because VMware's sustained mixed I/O stalls external drives. Move it to internal storage.`,
      );
    }
  }
  return warnings;
}
