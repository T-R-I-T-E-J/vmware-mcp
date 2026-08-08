import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveCredential, type GuestCredential } from "./config.js";
import { assertIsoAllowed } from "./paths.js";
import * as vmrun from "./vmrun.js";
import { cdromEntries, patchVmx, parseVmx } from "./vmx.js";
import { appendNote, updateRecord, type VmRecord } from "./registry.js";
import { createVmCore, type CreateVmArgs } from "./tools/lifecycle.js";
import { buildSeedIso, seedIsoPathFor } from "./seed/isoBuilder.js";
import { buildAutounattend } from "./seed/autounattend.js";
import { buildPreseed, kaliDefaults } from "./seed/preseed.js";
import { buildUserData, buildMetaData } from "./seed/cloudinit.js";
import { sha512Crypt, verifySelfTest } from "./seed/sha512crypt.js";
import { startSeedServer, type SeedServer } from "./seed/httpSeed.js";
import { defaultBootCommand, installerKindFor, type InstallerKind } from "./bootCommand.js";
import { parseBootCommand } from "./keymap.js";
import { playBootCommand } from "./vnc.js";
import { grabScreenshot } from "./tools/screen.js";

export interface ProvisionRequest {
  name: string;
  installIso: string;
  guestOsId: string;
  username: string;
  password: string;
  credentialRef?: string;
  memoryMb: number;
  cpus: number;
  diskGb: number;
  firmware: "bios" | "efi";
  network: "nat" | "bridged" | "hostonly" | "custom" | "none";
  customVnet?: string;
  tags?: string[];
  /** Windows only. */
  windowsImageName?: string;
  windowsImageIndex?: number;
  productKey?: string;
  bypassHardwareChecks?: boolean;
  /** Linux only: log the desktop user in automatically. */
  autologin?: boolean;
  extraPackages?: string[];
  timezone?: string;
  locale?: string;
  /** Override the typed boot command and its timing. */
  bootCommand?: string;
  bootWaitSec?: number;
  keyDelayMs?: number;
  /** How long to wait for the install to finish and Tools to appear. */
  installTimeoutMin: number;
  /** Snapshot the finished VM so it can be reset to a clean state. */
  snapshotWhenReady: boolean;
}

export interface ProvisionResult {
  name: string;
  vmxPath: string;
  installerKind: InstallerKind;
  lifecycle: string;
  seedIso?: string;
  seedUrl?: string;
  bootCommand: string;
  toolsState: string;
  loginVerified: boolean;
  elapsedMin: number;
  screenshot?: string;
  snapshot?: string;
  notes: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive a VM from nothing to a logged-in, controllable guest.
 *
 * The phases are: create hardware → generate the answer file → deliver it (seed
 * CD for Windows/Ubuntu, HTTP for Debian/Kali) → power on → type the boot
 * command → wait for VMware Tools → prove the account works.
 *
 * "Ready" is never assumed. It requires Tools reporting running *and* a real
 * command executing in the guest under the created credentials, because Tools
 * can come up before the account exists.
 */
export async function provisionVm(req: ProvisionRequest): Promise<ProvisionResult> {
  verifySelfTest(); // a wrong password hash costs a 20-minute install to discover

  const cfg = loadConfig();
  const started = Date.now();
  const notes: string[] = [];
  const note = (s: string) => {
    notes.push(s);
    appendNote(req.name, s);
  };

  const isoPath = assertIsoAllowed(
    path.isAbsolute(req.installIso) ? req.installIso : path.join(cfg.isoLibrary, req.installIso),
  );
  const isoName = path.basename(isoPath);
  const kind = installerKindFor(guessFamily(req.guestOsId), isoName);

  let seedServer: SeedServer | null = null;
  let vmxPath = "";

  try {
    // ---------------------------------------------------------------- create
    const created = await createVmCore({
      name: req.name,
      guestOsId: req.guestOsId,
      memoryMb: req.memoryMb,
      cpus: req.cpus,
      diskGb: req.diskGb,
      diskAdapter: "nvme",
      firmware: req.firmware,
      network: req.network,
      customVnet: req.customVnet,
      installIso: isoPath,
      tags: req.tags,
    } satisfies CreateVmArgs);
    vmxPath = created.vmxPath;
    updateRecord(req.name, { lifecycle: "provisioning", credentialRef: req.credentialRef });
    note(`Created VM at ${vmxPath} from ${isoName} (installer: ${kind}).`);

    // Store the credentials up front so every later guest_* call can use them.
    const cred: GuestCredential = { username: req.username, password: req.password };
    if (req.credentialRef) saveCredential(req.credentialRef, cred);

    // ---------------------------------------------------------------- seed
    let seedIso: string | undefined;
    let seedUrl: string | undefined;

    if (kind === "windows") {
      const xml = buildAutounattend({
        username: req.username,
        password: req.password,
        computerName: req.name.slice(0, 15), // NetBIOS name limit
        imageName: req.windowsImageName,
        imageIndex: req.windowsImageIndex,
        isServer: /srv|server/i.test(req.guestOsId),
        productKey: req.productKey,
        locale: req.locale,
        timeZone: req.timezone,
        firmware: req.firmware,
        bypassHardwareChecks: req.bypassHardwareChecks,
        installVmwareTools: true,
      });
      const built = await buildSeedIso(
        [{ name: "autounattend.xml", content: xml }],
        seedIsoPathFor(req.name),
        "UNATTEND",
      );
      seedIso = built.path;
      note(`Built autounattend seed ISO (${built.sizeBytes} bytes).`);

      // Seed CD plus the VMware Tools ISO, which FirstLogonCommands installs from.
      const extra: Record<string, string> = {
        ...cdromEntries({ device: "sata0:2", isoPath: seedIso }),
      };
      if (cfg.toolsWindowsIso) {
        Object.assign(extra, cdromEntries({ device: "sata0:3", isoPath: cfg.toolsWindowsIso }));
        note("Attached the VMware Tools ISO for first-logon install.");
      } else {
        note("VMware Tools ISO not found next to vmrun.exe; Tools will not auto-install.");
      }
      patchVmx(vmxPath, extra);
    } else if (kind === "ubuntu-autoinstall") {
      const hash = sha512Crypt(req.password);
      const userData = buildUserData(
        {
          hostname: req.name,
          username: req.username,
          password: req.password,
          locale: req.locale,
          timezone: req.timezone,
          autologin: req.autologin,
          extraPackages: req.extraPackages,
        },
        hash,
      );
      const built = await buildSeedIso(
        [
          { name: "user-data", content: userData },
          { name: "meta-data", content: buildMetaData(req.name, req.name) },
        ],
        seedIsoPathFor(req.name),
        // cloud-init's NoCloud datasource scans specifically for this label.
        "CIDATA",
      );
      seedIso = built.path;
      note(`Built cloud-init CIDATA seed ISO (${built.sizeBytes} bytes).`);
      patchVmx(vmxPath, cdromEntries({ device: "sata0:2", isoPath: seedIso }));
    } else {
      // Debian and Kali: preseed over HTTP.
      const preseed = buildPreseed({
        hostname: req.name,
        username: req.username,
        password: req.password,
        locale: req.locale,
        timezone: req.timezone,
        autologin: req.autologin,
        extraPackages: req.extraPackages,
        ...(kind === "kali" ? kaliDefaults() : {}),
      });
      // "p" is an alias for "preseed.cfg": 10 fewer characters to type at a
      // boot prompt that drops keystrokes.
      seedServer = await startSeedServer({ "preseed.cfg": preseed, p: preseed });
      seedUrl = seedServer.url;
      note(`Serving preseed at ${seedUrl}/preseed.cfg (bound to the host's virtual-network address only).`);
    }

    // ---------------------------------------------------------------- boot
    const spec = defaultBootCommand(kind, { seedUrl, hostname: req.name, locale: req.locale });
    const command = req.bootCommand ?? spec.command;
    const bootWaitSec = req.bootWaitSec ?? spec.bootWaitSec;
    const keyDelayMs = req.keyDelayMs ?? spec.keyDelayMs;

    // Parse before powering on: a malformed boot command should fail instantly,
    // not after the installer has already timed out at its menu.
    const steps = parseBootCommand(command);

    await vmrun.start(vmxPath, "nogui");
    note(`Powered on; waiting ${bootWaitSec}s for the bootloader.`);
    await sleep(bootWaitSec * 1000);

    const vncPort = Number(parseVmx(vmxPath).get("remotedisplay.vnc.port"));
    const played = await playBootCommand({ port: vncPort }, steps, keyDelayMs);
    note(`Typed boot command (${played.keysSent} keystrokes) on VNC port ${vncPort}.`);

    if (seedServer) {
      // Typing at a bootloader prompt is inherently lossy: the prompt polls the
      // keyboard slowly, and a busy host drops characters mid-URL. When that
      // happens the installer fails silently — it just sits at its menu — so
      // retype rather than fail on the first miss. Enter first, to clear
      // whatever partial text is already on the prompt line.
      let fetched = await seedServer.waitForFetch(75_000);
      for (let attempt = 2; !fetched && attempt <= 3; attempt++) {
        const shot = await grabScreenshot(vmxPath).catch(() => undefined);
        note(
          `Preseed not fetched; the boot command likely dropped keystrokes. Retyping (attempt ${attempt}/3)${shot ? `. Screen: ${shot}` : ""}.`,
        );
        await playBootCommand({ port: vncPort }, parseBootCommand("<enter><wait3>"), 150);
        await playBootCommand({ port: vncPort }, steps, Math.round(keyDelayMs * 1.5));
        fetched = await seedServer.waitForFetch(75_000);
      }
      if (!fetched) {
        const shot = await grabScreenshot(vmxPath).catch(() => undefined);
        throw new Error(
          `The installer never fetched the preseed from ${seedUrl} after 3 attempts. Check the screenshot${shot ? ` at ${shot}` : ""} — if the prompt shows a truncated URL, raise keyDelayMs; if it shows a menu, raise bootWaitSec.`,
        );
      }
      note("Installer fetched the preseed; unattended install is under way.");
    }

    // ---------------------------------------------------------------- wait
    const deadline = Date.now() + req.installTimeoutMin * 60_000;
    let toolsState = await vmrun.checkToolsState(vmxPath);
    while (toolsState !== "running" && Date.now() < deadline) {
      await sleep(20_000);
      toolsState = await vmrun.checkToolsState(vmxPath);
    }

    if (toolsState !== "running") {
      const shot = await grabScreenshot(vmxPath).catch(() => undefined);
      updateRecord(req.name, { lifecycle: "failed", lastError: "Tools never came up" });
      throw new Error(
        `Install did not complete within ${req.installTimeoutMin} minutes (VMware Tools state: ${toolsState}). ` +
          `The VM is left running so you can inspect it${shot ? `; screenshot: ${shot}` : ""}.`,
      );
    }
    note(`VMware Tools is running after ${Math.round((Date.now() - started) / 60000)} min.`);

    // ---------------------------------------------------------------- verify login
    // Tools can report running before the account is usable, so prove it.
    let loginVerified = false;
    const loginDeadline = Date.now() + 10 * 60_000;
    while (!loginVerified && Date.now() < loginDeadline) {
      const probe = await vmrun
        .runProgramInGuest(
          cred,
          vmxPath,
          kind === "windows" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/true",
          kind === "windows" ? ["/c", "exit", "0"] : [],
          { timeoutMs: 60_000 },
        )
        .catch(() => null);
      if (probe && probe.code === 0) loginVerified = true;
      else await sleep(15_000);
    }

    const screenshot = await grabScreenshot(vmxPath).catch(() => undefined);

    if (!loginVerified) {
      updateRecord(req.name, { lifecycle: "failed", lastError: "guest credentials did not work" });
      throw new Error(
        `VMware Tools is running but the account "${req.username}" could not execute a command. ` +
          `The OS installed, but the credentials or auto-logon did not take${screenshot ? `. Screenshot: ${screenshot}` : ""}.`,
      );
    }
    note(`Verified login as "${req.username}" by running a command in the guest.`);

    // ---------------------------------------------------------------- finish
    let snapshot: string | undefined;
    if (req.snapshotWhenReady) {
      snapshot = "clean";
      await vmrun.snapshot(vmxPath, snapshot);
      note(`Took snapshot "${snapshot}".`);
    }

    // Eject the install media so the VM never re-enters its own installer.
    // The runtime disconnect takes effect immediately; the .vmx edit is what
    // makes it stick, and VMware rewrites the .vmx at power-off, so do both.
    for (const device of ["sata0:1", "sata0:2", "sata0:3"]) {
      await vmrun.disconnectNamedDevice(vmxPath, device).catch(() => undefined);
    }
    patchVmx(vmxPath, {
      "sata0:1.startConnected": "FALSE",
      "sata0:2.startConnected": "FALSE",
      "sata0:3.startConnected": "FALSE",
    });
    note("Ejected the install media; the VM now boots from its own disk.");

    updateRecord(req.name, { lifecycle: "ready", credentialRef: req.credentialRef, seedIso });

    return {
      name: req.name,
      vmxPath,
      installerKind: kind,
      lifecycle: "ready",
      seedIso,
      seedUrl,
      bootCommand: command,
      toolsState,
      loginVerified,
      elapsedMin: Math.round((Date.now() - started) / 60000),
      screenshot,
      snapshot,
      notes,
    };
  } catch (e) {
    if (vmxPath) updateRecord(req.name, { lifecycle: "failed", lastError: (e as Error).message });
    throw e;
  } finally {
    seedServer?.close();
  }
}

export interface FinalizeOptions {
  vmxPath: string;
  name: string;
  cred: GuestCredential;
  isWindows: boolean;
  waitMinutes: number;
  snapshotName?: string;
}

/**
 * Complete the post-install steps for a VM whose OS install finished outside the
 * orchestrator — because the server restarted, or because the install was
 * started by hand.
 *
 * This is worth having because the guest install is genuinely independent of
 * this process: the preseed or answer file runs inside the VM, so killing the
 * server mid-provision leaves a VM that finishes installing on its own but never
 * gets verified, ejected, or snapshotted.
 */
export async function finalizeProvision(o: FinalizeOptions): Promise<ProvisionResult> {
  const started = Date.now();
  const notes: string[] = [];
  const note = (s: string) => {
    notes.push(s);
    appendNote(o.name, s);
  };

  const deadline = Date.now() + o.waitMinutes * 60_000;
  let toolsState = await vmrun.checkToolsState(o.vmxPath);
  while (toolsState !== "running" && Date.now() < deadline) {
    await sleep(20_000);
    toolsState = await vmrun.checkToolsState(o.vmxPath);
  }
  if (toolsState !== "running") {
    throw new Error(
      `VMware Tools is still "${toolsState}" after ${o.waitMinutes} minutes. The install may not be finished, or open-vm-tools may not be installed in the guest.`,
    );
  }
  note("VMware Tools is running.");

  let loginVerified = false;
  const loginDeadline = Date.now() + 10 * 60_000;
  while (!loginVerified && Date.now() < loginDeadline) {
    const probe = await vmrun
      .runProgramInGuest(
        o.cred,
        o.vmxPath,
        o.isWindows ? "C:\\Windows\\System32\\cmd.exe" : "/bin/true",
        o.isWindows ? ["/c", "exit", "0"] : [],
        { timeoutMs: 60_000 },
      )
      .catch(() => null);
    if (probe && probe.code === 0) loginVerified = true;
    else await sleep(15_000);
  }
  if (!loginVerified) {
    updateRecord(o.name, { lifecycle: "failed", lastError: "guest credentials did not work" });
    throw new Error(
      `VMware Tools is running but "${o.cred.username}" could not execute a command in the guest.`,
    );
  }
  note(`Verified login as "${o.cred.username}".`);

  for (const device of ["sata0:1", "sata0:2", "sata0:3"]) {
    await vmrun.disconnectNamedDevice(o.vmxPath, device).catch(() => undefined);
  }
  patchVmx(o.vmxPath, {
    "sata0:1.startConnected": "FALSE",
    "sata0:2.startConnected": "FALSE",
    "sata0:3.startConnected": "FALSE",
  });
  note("Ejected the install media.");

  let snapshot: string | undefined;
  if (o.snapshotName) {
    snapshot = o.snapshotName;
    await vmrun.snapshot(o.vmxPath, snapshot);
    note(`Took snapshot "${snapshot}".`);
  }

  updateRecord(o.name, { lifecycle: "ready" });
  const screenshot = await grabScreenshot(o.vmxPath).catch(() => undefined);

  return {
    name: o.name,
    vmxPath: o.vmxPath,
    installerKind: o.isWindows ? "windows" : "debian",
    lifecycle: "ready",
    bootCommand: "(not replayed)",
    toolsState,
    loginVerified,
    elapsedMin: Math.round((Date.now() - started) / 60000),
    screenshot,
    snapshot,
    notes,
  };
}

function guessFamily(guestOsId: string): string {
  const g = guestOsId.toLowerCase();
  if (g.startsWith("win")) return "windows";
  if (g.startsWith("ubuntu")) return "ubuntu";
  if (g.startsWith("debian")) return "debian";
  return "other";
}

/** Remove a generated seed ISO once a VM no longer needs it. */
export function cleanupSeed(vmName: string): void {
  fs.rmSync(seedIsoPathFor(vmName), { force: true });
}
