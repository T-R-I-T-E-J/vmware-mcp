import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveCredential, type GuestCredential } from "./config.js";
import { assertIsoAllowed } from "./paths.js";
import * as vmrun from "./vmrun.js";
import { cdromEntries, patchVmx, parseVmx, removeCdrom, writeVmx } from "./vmx.js";
import { appendNote, updateRecord, type ProvisionPhase, type ProvisionSpec, type VmRecord } from "./registry.js";
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
 * Prove a guest account works, without executing a program.
 *
 * `fileExistsInGuest` authenticates exactly like any other guest operation but
 * runs nothing, which matters on Windows: **`cmd.exe` launched through VIX
 * hangs indefinitely**. Verified on a healthy Windows 10 guest with VMware Tools
 * 12.4.5 running — `whoami.exe` and `powershell.exe` return immediately, while
 * `cmd.exe /c exit 0`, `cmd.exe /c dir`, and `runScriptInGuest` with cmd all
 * time out, with or without `-interactive`. The old probe used
 * `cmd.exe /c exit 0`, so a perfectly good Windows VM could never reach `ready`.
 */
async function probeCredentials(
  cred: GuestCredential,
  vmxPath: string,
  isWindows: boolean,
): Promise<boolean> {
  const path = isWindows ? "C:\\Windows\\System32\\kernel32.dll" : "/bin/sh";
  return vmrun.fileExistsInGuest(cred, vmxPath, path);
}

/**
 * Land a freshly-installed VM in a clean, safe resting state: powered off, with
 * the install media detached and the generated answer-file ISO deleted.
 *
 * The VM must be powered off first. Editing a running VM's .vmx does not stick —
 * VMware rewrites the file when the VM powers down, which silently undid an
 * earlier attempt to eject the media (`sata0:2.startConnected` was back to
 * `TRUE` afterwards).
 *
 * Deleting the seed ISO matters beyond tidiness: an `autounattend.xml` embeds
 * the account password in plain text, so leaving the image on disk leaves the
 * guest's password readable on the host. The CD-ROM devices are removed
 * entirely rather than just disconnected, so nothing points at the deleted file.
 *
 * Snapshotting last, with the VM off, also produces a smaller snapshot that
 * restores to a clean powered-off machine rather than mid-session state.
 */
async function finishProvisioning(
  vmxPath: string,
  vmName: string,
  snapshotName: string | undefined,
  note: (s: string) => void,
): Promise<string | undefined> {
  if (await vmrun.isRunning(vmxPath)) {
    await vmrun.stop(vmxPath, "soft").catch(() => undefined);
    for (let i = 0; i < 20 && (await vmrun.isRunning(vmxPath)); i++) await sleep(5_000);
    if (await vmrun.isRunning(vmxPath)) await vmrun.stop(vmxPath, "hard").catch(() => undefined);
    note("Powered off so the .vmx edits below actually persist.");
  }

  const cfg = parseVmx(vmxPath);
  for (const device of ["sata0:1", "sata0:2", "sata0:3"]) removeCdrom(cfg, device);
  writeVmx(vmxPath, cfg);
  note("Detached the install media; the VM boots from its own disk.");

  const seed = seedIsoPathFor(vmName);
  if (fs.existsSync(seed)) {
    fs.rmSync(seed, { force: true });
    note("Deleted the generated answer-file ISO (it contained the account password in clear text).");
  }

  if (!snapshotName) return undefined;
  await vmrun.snapshot(vmxPath, snapshotName);
  note(`Took snapshot "${snapshotName}" of the powered-off VM.`);
  return snapshotName;
}

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
      // Windows guests get an LSI Logic SAS controller, not NVMe. WinPE's NVMe
      // path on Workstation produced `0x800701B1` (ERROR_DEVICE_HARDWARE_ERROR)
      // partway through copying files — the disk partitioned and formatted
      // cleanly, then the copy died. LSI Logic SAS is also VMware's own
      // recommendation for Windows. Linux is left on NVMe, where Kali and
      // Ubuntu both installed without trouble.
      diskAdapter: kind === "windows" ? "lsilogic" : "nvme",
      firmware: req.firmware,
      network: req.network,
      customVnet: req.customVnet,
      installIso: isoPath,
      tags: req.tags,
    } satisfies CreateVmArgs);
    vmxPath = created.vmxPath;
    const savedSpec: ProvisionSpec = {
      installIso: req.installIso, guestOsId: req.guestOsId, username: req.username,
      memoryMb: req.memoryMb, cpus: req.cpus, diskGb: req.diskGb, firmware: req.firmware,
      network: req.network, customVnet: req.customVnet,
      windowsImageName: req.windowsImageName, windowsImageIndex: req.windowsImageIndex,
      productKey: req.productKey, bypassHardwareChecks: req.bypassHardwareChecks,
      autologin: req.autologin, extraPackages: req.extraPackages,
      timezone: req.timezone, locale: req.locale,
      bootCommand: req.bootCommand, bootWaitSec: req.bootWaitSec, keyDelayMs: req.keyDelayMs,
      installTimeoutMin: req.installTimeoutMin, snapshotWhenReady: req.snapshotWhenReady,
      tags: req.tags,
    };
    // Persist the request so a later retry can rebuild this VM identically
    // without the caller having to remember what they asked for (#9).
    updateRecord(req.name, {
      lifecycle: "provisioning", credentialRef: req.credentialRef,
      phase: "created", provisionSpec: savedSpec,
    });
    const setPhase = (p: ProvisionPhase) => updateRecord(req.name, { phase: p });
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
    setPhase("seeded");

    // ---------------------------------------------------------------- boot
    const spec = defaultBootCommand(kind, { seedUrl, hostname: req.name });
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
    setPhase("booted");

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
    setPhase("installing");

    // ---------------------------------------------------------------- wait
    //
    // Accept "installed" as well as "running". open-vm-tools frequently settles
    // on `installed` after a fresh install — the service is up and guest
    // operations partly work, but VMware never completes the version handshake
    // until something nudges it. Waiting for `running` means sitting out the
    // entire timeout on a VM that is actually fine.
    const deadline = Date.now() + req.installTimeoutMin * 60_000;
    const toolsPresent = (s: string) => s === "running" || s === "installed";
    let toolsState = await vmrun.checkToolsState(vmxPath);
    while (!toolsPresent(toolsState) && Date.now() < deadline) {
      await sleep(20_000);
      toolsState = await vmrun.checkToolsState(vmxPath);
    }

    if (!toolsPresent(toolsState)) {
      const shot = await grabScreenshot(vmxPath).catch(() => undefined);
      updateRecord(req.name, { lifecycle: "failed", lastError: "Tools never came up" });
      throw new Error(
        `Install did not complete within ${req.installTimeoutMin} minutes (VMware Tools state: ${toolsState}). ` +
          `The VM is left running so you can inspect it${shot ? `; screenshot: ${shot}` : ""}.`,
      );
    }
    note(`VMware Tools is running after ${Math.round((Date.now() - started) / 60000)} min.`);
    setPhase("tools-present");

    // ---------------------------------------------------------------- verify login
    // Tools reporting present does not mean the account is usable, so prove it
    // by running a real command as the new user.
    let loginVerified = false;
    const loginDeadline = Date.now() + 12 * 60_000;
    let nudged = false;
    while (!loginVerified && Date.now() < loginDeadline) {
      const probe = await probeCredentials(cred, vmxPath, kind === "windows").catch(() => false);
      if (probe) {
        loginVerified = true;
        break;
      }

      // Half way through, if Tools is stuck at "installed", reboot once. That
      // completes the handshake in practice; observed on Kali, where guest ops
      // went from failing to working immediately afterwards. Cheaper than
      // failing the whole provision on a VM that has installed correctly.
      if (!nudged && Date.now() > loginDeadline - 6 * 60_000) {
        nudged = true;
        const state = await vmrun.checkToolsState(vmxPath);
        if (state !== "running") {
          note(`Tools stuck at "${state}" and guest commands failing — rebooting once to complete the handshake.`);
          await vmrun.reset(vmxPath, "soft").catch(() => undefined);
          await sleep(60_000);
        }
      }
      await sleep(15_000);
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
    setPhase("login-verified");

    // ---------------------------------------------------------------- finish
    const snapshot = await finishProvisioning(
      vmxPath,
      req.name,
      req.snapshotWhenReady ? "clean" : undefined,
      note,
    );

    updateRecord(req.name, {
      lifecycle: "ready",
      credentialRef: req.credentialRef,
      seedIso: undefined,
      lastError: undefined,
      phase: "finished",
    });

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
    if (await probeCredentials(o.cred, o.vmxPath, o.isWindows).catch(() => false)) loginVerified = true;
    else await sleep(15_000);
  }
  if (!loginVerified) {
    updateRecord(o.name, { lifecycle: "failed", lastError: "guest credentials did not work" });
    throw new Error(
      `VMware Tools is running but "${o.cred.username}" could not execute a command in the guest.`,
    );
  }
  note(`Verified login as "${o.cred.username}".`);

  const snapshot = await finishProvisioning(o.vmxPath, o.name, o.snapshotName, note);

  // Clear any error from an earlier failed attempt; the VM is good now.
  updateRecord(o.name, { lifecycle: "ready", lastError: undefined, phase: "finished" });
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
