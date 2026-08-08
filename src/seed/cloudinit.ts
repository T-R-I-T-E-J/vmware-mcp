/**
 * Ubuntu autoinstall (Subiquity) via a cloud-init NoCloud seed.
 *
 * The seed goes on a second CD-ROM labelled CIDATA, which cloud-init discovers
 * on its own — so the boot command only has to add the `autoinstall` kernel
 * argument, not a `ds=nocloud;s=...` locator.
 */

export interface CloudInitOptions {
  hostname: string;
  username: string;
  password: string;
  locale?: string;
  keyboardLayout?: string;
  timezone?: string;
  /** Log the desktop user in automatically once installed. */
  autologin?: boolean;
  extraPackages?: string[];
  lateCommands?: string[];
  /** Full-disk install target. */
  diskMatchSize?: "largest" | "smallest";
}

export { sha512Crypt } from "./sha512crypt.js";

export function buildUserData(o: CloudInitOptions, passwordHash: string): string {
  const packages = [
    "open-vm-tools",
    ...(o.autologin ? ["open-vm-tools-desktop"] : []),
    "openssh-server",
    ...(o.extraPackages ?? []),
  ];

  const late: string[] = [];
  if (o.autologin) {
    late.push(
      `mkdir -p /target/etc/gdm3`,
      `printf '[daemon]\\nAutomaticLoginEnable=true\\nAutomaticLogin=${o.username}\\n' > /target/etc/gdm3/custom.conf`,
    );
  }
  late.push(`printf 'provisioned\\n' > /target/var/log/vmware-mcp-ready`);
  late.push(...(o.lateCommands ?? []));

  return `#cloud-config
autoinstall:
  version: 1
  locale: ${o.locale ?? "en_US.UTF-8"}
  keyboard:
    layout: ${o.keyboardLayout ?? "us"}
  timezone: ${o.timezone ?? "Etc/UTC"}
  identity:
    hostname: ${o.hostname}
    username: ${o.username}
    password: "${passwordHash}"
  ssh:
    install-server: true
    allow-pw: true
  storage:
    layout:
      name: direct
      match:
        size: ${o.diskMatchSize ?? "largest"}
  packages:
${packages.map((p) => `    - ${p}`).join("\n")}
  user-data:
    disable_root: false
  late-commands:
${late.map((c) => `    - ${JSON.stringify(["sh", "-c", c])}`).join("\n")}
  shutdown: reboot
`;
}

export function buildMetaData(instanceId: string, hostname: string): string {
  return `instance-id: ${instanceId}\nlocal-hostname: ${hostname}\n`;
}
