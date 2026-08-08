# Field notes: seven failure modes in unattended VM provisioning on VMware Workstation 17.6.2

> Everything below was observed on real hardware — Windows 11 Home Single
> Language, VMware Workstation 17 Pro 17.6.2, 16 GB RAM — while building and
> testing this server. Nothing here is from documentation.

Each is also filed as an issue:

| Issue | State | |
|---|---|---|
| [#1](../../issues/1) | open | `vmcli MKS sendKeyEvent` is a silent no-op |
| [#2](../../issues/2) | open | `vmrun captureScreen` requires a guest login |
| [#3](../../issues/3) | fixed | "architecture not supported" is really a DNS failure |
| [#4](../../issues/4) | fixed | Bootloader drops keystrokes under memory pressure |
| [#5](../../issues/5) | fixed | Windows Setup rejects the answer file's `<ProductKey>` |
| [#6](../../issues/6) | fixed | `vmcli VM Create` emits its own disk and a RAM cap |

#1 and #2 stay open: both are defects in VMware Workstation itself, worked
around here but unresolved upstream.

Unattended OS installation is one of the most failure-prone things in
automation, and it is worth being explicit about *why*: you are driving three
completely different, undocumented, timing-sensitive interfaces (isolinux, GRUB,
Windows Setup) by typing at a screen, with no API and no error channel. When it
goes wrong, the usual symptom is a VM that simply sits there.

These are the seven distinct failures hit while getting Debian, Ubuntu, and
Windows 10 to install hands-off, what actually caused each, and what was changed.

---

## 1. `vmcli Disk Create` fails immediately after `VM Create`

**Symptom**

```
vmcli.exe Disk Create -f G:\VMs\smoke-debian\smoke-debian.vmdk -a lsilogic -s 20480MB -t 0
  → Failed to create virtual disk
```

The identical command succeeded when run by hand against a different filename.

**Cause.** `vmcli VM Create` already emits its own `<name>.vmdk` — a 20 GB
`monolithicSparse` disk — which is undocumented. The explicit `Disk Create` was
colliding with a file that already existed.

**Fix.** Delete the auto-created `.vmdk` before creating the real one, rather
than extending it: `vmware-vdiskmanager` can only grow a disk, so replacing it is
the only way to honour a `diskGb` smaller than 20.

`vmcli VM Create` also writes `memory.maxsize = "880"` beside its 512 MB default,
which silently clamps requested RAM. That key is now removed at creation time.

---

## 2. `vmcli MKS sendKeyEvent` is a silent no-op

**Symptom.** Keystrokes never reach the guest. The command accepts its
arguments, exits 0, prints nothing, and the guest does not move. Verified against
a live Debian installer boot menu: the highlighted entry never changed while the
menu's own countdown kept ticking, proving the screen was live.

Enabling the VNC console (`RemoteDisplay.vnc.enabled`) and confirming
`vncEnabled: true` in `vmcli MKS query` made no difference.

**Why it matters.** This is load-bearing. Every Linux installer needs a kernel
argument that an unmodified ISO cannot carry, and remastering a 6 GB Ubuntu image
per VM is not viable. Without working keyboard input, **no Linux guest can be
provisioned at all.**

**Fix.** Drive the VM's built-in VNC server directly over RFB (RFC 6143) with a
~200-line client — `src/vnc.ts`. Documented protocol, observably works.
`create_vm` now enables the VNC console on every VM it creates.

---

## 3. `vmrun captureScreen` requires a guest login

**Symptom**

```
Error: Anonymous guest operations are not allowed on this virtual machine.
You must call VixVM_LoginInGuest before performing guest operations
```

**Cause.** `vmrun` treats screen capture as a guest operation, so it needs
VMware Tools and credentials — neither of which exists during an OS install,
which is precisely when a screenshot is most valuable.

**Fix.** Use `vmcli MKS captureScreenshot`, which works against a VM with no
guest agent, no credentials, and no OS. (Note the irony with #2: of the two MKS
subcommands, screen capture works and key injection does not.)

---

## 4. Install dies at "Configure the package manager"

**Symptom.** Debian reports *"The specified Debian archive mirror does not seem
to support your architecture."* Nothing about that message is true — the mirror
is fine and `amd64` is obviously supported.

**Diagnosis.** Typing into the installer's debug shell on VT2 over VNC:

```
choose-mirror: command: wget --no-verbose \
  http://deb.debian.org/debian/dists/bookworm/main/binary-amd64/Release -O - | grep ^Architecture:
choose-mirror: architecture not supported by selected mirror
```

`choose-mirror` greps for `Architecture:` in whatever `wget` returns. If the
fetch fails for *any* reason, the grep finds nothing and it reports an
architecture problem. The real error was:

```
Resolving deb.debian.org... failed: Connection timed out.
```

The host's router (its only configured resolver) had stopped answering DNS.
VMware NAT forwards guest DNS to the host's resolver, so a broken router DNS
breaks every guest install. Confirmed from the host: raw IP connectivity worked,
`1.1.1.1` resolved fine, the configured resolver did not.

**Fix.** The generated preseed now writes public resolvers **ahead of** the
DHCP-supplied one via `preseed/early_command`. Order matters — appending is not
enough, because the resolver tries the dead DHCP entry first and stalls.

**Lesson.** Take installer error messages as a starting point, not a diagnosis.

---

## 5. Dropped keystrokes at the boot prompt

**Symptom.** A Debian install that had worked minutes earlier silently sat at its
menu. The screenshot showed what the prompt actually received:

```
boot: uto url=http:                                      ← failed run
boot: auto url=http://192.168.119.1:64317/preseed.cfg    ← successful run
```

The leading `a` and everything past `http:` were dropped.

**Cause.** Bootloader prompts poll the keyboard slowly. The host had ~2 GB of
available RAM and was paging heavily, so at 60 ms between keystrokes characters
were lost. Nothing reports this — the installer just waits.

**Fix.** Four changes, because one was not enough:

- key delay 60 ms → **150 ms**
- key press-and-hold 15 ms → **40 ms**
- seed URL shortened from `:59457/preseed.cfg` to `:8080/p` (fixed port, short
  alias) — a third fewer characters to lose
- **two automatic retypes** if the preseed is not fetched within 75 s, so a
  dropped character self-corrects instead of costing an hour

**Lesson.** Anything typed at a virtual console is lossy, and loss scales with
host load. Type less, type slower, and verify rather than assume.

---

## 6. Windows Setup rejects the answer file

**Symptom**

> Windows cannot read the `<ProductKey>` setting from the unattend answer file.

The useful half: the seed ISO was *found and parsed*, which proved the ISO
builder works with Windows Setup.

**Cause.** Consumer Windows media ships a multi-edition `install.esd` with no
`ei.cfg`. Without a product key, Setup cannot choose an edition — it either shows
a picker (breaking the unattended run) or fails outright.

**Fix.** Inject Microsoft's published generic *KMS client setup key* matching the
requested edition. These activate nothing; they exist precisely so unattended
installs can select an edition. Server media is excluded — evaluation ISOs carry
their own licence and reject these keys.

**This is the only one of the seven that documentation would have prevented.**

---

## 7. Ubuntu's GRUB line-edit boot command

Expected to be the most fragile: unlike isolinux, Ubuntu needs `e` pressed to
edit the highlighted entry, then a position-sensitive walk down to the `linux`
line, `<end>`, ` autoinstall`, and `<f10>`. Three `<down>` presses is a guess
about GRUB's layout that no API confirms.

**It worked on the first attempt** — after the #5 timing fixes were in place.
Labelling the cloud-init seed ISO `CIDATA` lets cloud-init discover it on its
own, so the typed argument is just `autoinstall` with no `ds=nocloud;s=...`
locator, which keeps the fragile part short.

---

## What made this tractable

Every one of these took minutes rather than hours to diagnose, because the server
can see and touch a VM that has no OS on it yet:

- `capture_screen` (via `vmcli`, not `vmrun`) shows the actual screen with no
  guest agent — that is how the truncated `boot: uto url=http:` was found
- `send_keys` (via VNC) types into the installer's own debug shell, which is how
  the real `choose-mirror` error came out of `/var/log/syslog`

Without those two, each failure is an unresponsive VM and a guess.

## Environment notes for reproducing

- Free RAM is a correctness issue, not just a speed one — failure #5 was caused
  by memory pressure. Provision one VM at a time on a 16 GB host.
- `Get-WindowsImage` / `dism /Get-WimInfo` need elevation, so Windows editions
  cannot be enumerated from an unprivileged session; hence the generic-key table.
- Hyper-V/VBS being active (`HypervisorPresent: True`, as with WSL2 or Memory
  Integrity) puts Workstation into a slower mode. It still works.
