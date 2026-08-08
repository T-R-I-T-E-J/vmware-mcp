import { loadConfig } from "./config.js";
import { run, type ExecResult, type RunOptions } from "./exec.js";

/**
 * vmcli takes the vmx location as a global argument that may be first or last.
 * We always put it first, before the module name.
 */
export function vmcli(vmx: string | null, argv: string[], opts?: RunOptions): Promise<ExecResult> {
  const cfg = loadConfig();
  return run(cfg.vmcli, vmx ? [vmx, ...argv] : argv, opts);
}

// ---------------------------------------------------------------- creation

/**
 * `vmcli VM Create -n <name> -d <dir> -g <guestOsId>` writes a minimal .vmx.
 * Note the two distinct flags Workstation accepts: -g for a known guest OS id,
 * -c for a "compatible with" id. We use -g.
 */
export async function createVm(name: string, dir: string, guestOsId: string): Promise<ExecResult> {
  return vmcli(null, ["VM", "Create", "-n", name, "-d", dir, "-g", guestOsId], {
    timeoutMs: 5 * 60_000,
  });
}

/** `Disk Create -f <file> -a <adapter> -s <size> -t <type>`; type 0 = growable single file. */
export async function createDisk(
  vmdkPath: string,
  sizeMb: number,
  adapter: "ide" | "buslogic" | "lsilogic" | "nvme" = "lsilogic",
  diskType: 0 | 1 | 2 | 3 = 0,
): Promise<ExecResult> {
  return vmcli(null, [
    "Disk",
    "Create",
    "-f",
    vmdkPath,
    "-a",
    adapter,
    "-s",
    `${sizeMb}MB`,
    "-t",
    String(diskType),
  ], { timeoutMs: 30 * 60_000 });
}

// ---------------------------------------------------------------- config

/** The general-purpose .vmx setter on a registered VM. */
export const setConfigEntry = (vmx: string, name: string, value: string) =>
  vmcli(vmx, ["ConfigParams", "SetEntry", name, value]);

export const queryConfig = (vmx: string) => vmcli(vmx, ["ConfigParams", "query"]);
export const queryPower = (vmx: string) => vmcli(vmx, ["Power", "query"], { allowFailure: true });
export const queryEthernet = (vmx: string) => vmcli(vmx, ["Ethernet", "query"], { allowFailure: true });
export const queryTools = (vmx: string) => vmcli(vmx, ["Tools", "query"], { allowFailure: true });

// ---------------------------------------------------------------- MKS (screen + input)

export const captureScreenshot = (vmx: string, hostPath: string) =>
  vmcli(vmx, ["MKS", "captureScreenshot", hostPath], { allowFailure: true });

export const queryMks = (vmx: string) => vmcli(vmx, ["MKS", "query"], { allowFailure: true });

/** Raw passthrough of vmcli's own key-sequence syntax. */
export const sendKeySequence = (vmx: string, sequence: string) =>
  vmcli(vmx, ["MKS", "sendKeySequence", sequence]);

/** One USB HID usage code plus a modifier bitmask. See keymap.ts. */
export const sendKeyEvent = (vmx: string, hidCode: number, modifier: number) =>
  vmcli(vmx, ["MKS", "sendKeyEvent", String(hidCode), String(modifier)]);

export const setGuestResolution = (vmx: string, width: number, height: number) =>
  vmcli(vmx, ["MKS", "SetGuestResolution", String(width), String(height)]);

export const setNumDisplays = (vmx: string, n: number) =>
  vmcli(vmx, ["MKS", "SetNumDisplays", String(n)]);
