import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../exec.js";
import { loadConfig } from "../config.js";

/**
 * Build a small ISO9660+Joliet image containing answer files.
 *
 * Windows ships no `oscdimg` unless the ADK is installed (it is not, on this
 * host), so we drive IMAPI2 — the COM API behind Windows' own "burn disc image"
 * — through a short PowerShell script. IMAPI2's result is exposed as an IStream,
 * which PowerShell cannot cast, so a few lines of inline C# do the copy. This is
 * the standard workaround and needs nothing installed beyond .NET Framework.
 *
 * Joliet matters: cloud-init's NoCloud datasource looks for files named
 * `user-data` and `meta-data`, and a hyphen is not a legal ISO9660 character.
 * Verified on this host that both names and the CIDATA volume label survive.
 */

const PS_SCRIPT = String.raw`
param([string]$SourceDir, [string]$OutputIso, [string]$VolumeName)
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public class VmwareMcpIsoWriter {
  public static void Write(string path, object stream, int blockSize, int totalBlocks) {
    IStream i = stream as IStream;
    if (i == null) throw new Exception("IMAPI2 result was not an IStream");
    FileStream o = File.Create(path);
    byte[] buf = new byte[blockSize];
    IntPtr got = Marshal.AllocHGlobal(4);
    try {
      while (totalBlocks-- > 0) {
        i.Read(buf, blockSize, got);
        int n = Marshal.ReadInt32(got);
        if (n <= 0) break;
        o.Write(buf, 0, n);
      }
    } finally { Marshal.FreeHGlobal(got); o.Flush(); o.Close(); }
  }
}
'@

$fsi = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$fsi.FileSystemsToCreate = 3   # ISO9660 + Joliet
$fsi.VolumeName = $VolumeName
$fsi.Root.AddTree($SourceDir, $false)
$res = $fsi.CreateResultImage()
[VmwareMcpIsoWriter]::Write($OutputIso, $res.ImageStream, $res.BlockSize, $res.TotalBlocks)
Write-Output ("BYTES=" + (Get-Item $OutputIso).Length)
`;

export interface SeedFile {
  /** Path within the ISO root, e.g. "autounattend.xml" or "nocloud/user-data". */
  name: string;
  content: string;
}

/**
 * Volume labels are capped at 11 characters for ISO9660 and are conventionally
 * uppercase. CIDATA specifically is what cloud-init scans for.
 */
export async function buildSeedIso(
  files: SeedFile[],
  outputIso: string,
  volumeName = "SEED",
): Promise<{ path: string; sizeBytes: number; files: string[] }> {
  if (files.length === 0) throw new Error("Cannot build a seed ISO with no files.");

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "vmmcp-seed-"));
  try {
    for (const f of files) {
      const dest = path.join(staging, f.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Answer files are parsed by boot-time installers that are unforgiving
      // about a UTF-8 BOM, so write plain UTF-8 with no BOM.
      fs.writeFileSync(dest, f.content, { encoding: "utf8" });
    }

    fs.mkdirSync(path.dirname(outputIso), { recursive: true });
    fs.rmSync(outputIso, { force: true });

    const scriptPath = path.join(staging, "_build.ps1");
    fs.writeFileSync(scriptPath, PS_SCRIPT, "utf8");

    const r = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-SourceDir", staging,
        "-OutputIso", outputIso,
        "-VolumeName", volumeName.toUpperCase().slice(0, 11),
      ],
      { timeoutMs: 120_000, allowFailure: true },
    );

    if (!fs.existsSync(outputIso) || fs.statSync(outputIso).size === 0) {
      throw new Error(
        `Failed to build seed ISO ${outputIso}. PowerShell said: ${(r.stderr || r.stdout).trim() || "(no output)"}`,
      );
    }

    return {
      path: outputIso,
      sizeBytes: fs.statSync(outputIso).size,
      files: files.map((f) => f.name),
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Standard location for a VM's generated seed ISO. */
export function seedIsoPathFor(vmName: string): string {
  return path.join(loadConfig().workDir, "seed", `${vmName}-seed.iso`);
}
