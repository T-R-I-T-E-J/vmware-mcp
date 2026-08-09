/**
 * Per-installer boot commands — the keystrokes typed at the bootloader before
 * the OS installer starts.
 *
 * Only Windows can be fully automated with an answer file alone; every Linux
 * installer here needs a kernel argument that an unmodified ISO cannot carry, so
 * the argument is typed at the boot prompt instead of remastering a multi-GB
 * image. Timings are host-speed dependent, which is why every one of these is
 * overridable per call.
 */

export type InstallerKind = "windows" | "debian" | "kali" | "ubuntu-autoinstall";

export interface BootCommandContext {
  /** Base URL of the seed HTTP server, e.g. http://192.168.119.1:54321 */
  seedUrl?: string;
  hostname?: string;
}

export interface BootCommandSpec {
  /** Seconds to wait after power-on before typing anything. */
  bootWaitSec: number;
  /** Keystrokes, in send_keys syntax. */
  command: string;
  /** Milliseconds between keystrokes. */
  keyDelayMs: number;
  notes: string;
}

export function defaultBootCommand(kind: InstallerKind, ctx: BootCommandContext = {}): BootCommandSpec {
  switch (kind) {
    case "windows":
      return {
        bootWaitSec: 4,
        // Windows install media prompts "Press any key to boot from CD or DVD".
        // If nothing is pressed it falls through to a blank disk and hangs on
        // "no bootable device", so we press space a few times across the window.
        command: "<spacebar><wait1><spacebar><wait1><spacebar>",
        keyDelayMs: 100,
        notes:
          "Answers come from autounattend.xml on the attached seed CD; Windows Setup finds it without any kernel arguments.",
      };

    case "debian":
      return {
        bootWaitSec: 12,
        // Esc leaves the graphical isolinux menu for a plain `boot:` prompt,
        // where `auto url=` fetches the preseed over HTTP.
        // locale and keymap must ride the kernel command line: debian-installer
        // asks them before it fetches the preseed, so setting them in the
        // preseed file is too late and the UI comes up in whatever the
        // installer defaulted to (observed: Polish). See #16.
        command: `<esc><wait2>auto locale=en_US keymap=us url=${ctx.seedUrl ?? "http://SEED_URL"}/p<enter>`,
        // Deliberately slow. At 60ms a loaded host dropped characters and the
        // prompt received "uto url=http:" instead of the full URL, which fails
        // silently — the installer just sits at its menu.
        keyDelayMs: 150,
        notes: "Preseed is served over HTTP because the installer disc already owns /cdrom.",
      };

    case "kali":
      return {
        bootWaitSec: 14,
        // locale and keymap must ride the kernel command line: debian-installer
        // asks them before it fetches the preseed, so setting them in the
        // preseed file is too late and the UI comes up in whatever the
        // installer defaulted to (observed: Polish). See #16.
        command: `<esc><wait2>auto locale=en_US keymap=us url=${ctx.seedUrl ?? "http://SEED_URL"}/p<enter>`,
        // Deliberately slow. At 60ms a loaded host dropped characters and the
        // prompt received "uto url=http:" instead of the full URL, which fails
        // silently — the installer just sits at its menu.
        keyDelayMs: 150,
        notes: "Kali ships the Debian installer, so the Debian preseed path applies unchanged.",
      };

    case "ubuntu-autoinstall":
      return {
        bootWaitSec: 8,
        // Ubuntu boots GRUB, not isolinux. Edit the highlighted entry with `e`,
        // jump to the end of the linux line, append `autoinstall`, and boot with
        // F10. cloud-init finds the CIDATA seed CD on its own, so no ds= is needed.
        command:
          "<wait2><e><wait2><down><down><down><end> autoinstall<wait1><f10>",
        keyDelayMs: 80,
        notes:
          "GRUB line editing is position-sensitive; if the install does not start unattended, screenshot after the <e> and adjust the number of <down> presses.",
      };
  }
}

/** Map a registry osFamily plus the ISO name onto an installer kind. */
export function installerKindFor(osFamily: string, isoName: string): InstallerKind {
  const iso = isoName.toLowerCase();
  if (osFamily === "windows") return "windows";
  if (iso.includes("kali")) return "kali";
  if (osFamily === "ubuntu" || iso.includes("ubuntu")) return "ubuntu-autoinstall";
  return "debian";
}
