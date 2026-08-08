import path from "node:path";
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
