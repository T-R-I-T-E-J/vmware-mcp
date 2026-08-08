# Paste-ready GitHub issue

Create the issue at `https://github.com/<you>/vmware-mcp/issues/new`.

**Title:**

```
Field notes: 7 failure modes in unattended VM provisioning on Workstation 17.6.2
```

**Labels:** `documentation`, `known-issues`, `upstream-bug`

**Body:** paste the contents of [`docs/field-notes.md`](field-notes.md), or use
this shorter version:

---

Recording the failures hit while getting Debian 12, Ubuntu 24.04, and Windows 10
to install completely hands-off, so they don't have to be rediscovered. Full
detail with screenshots and log excerpts in `docs/field-notes.md`.

Environment: Windows 11 Home Single Language, VMware Workstation 17 Pro 17.6.2,
16 GB RAM.

| # | Failure | Cause | Status |
|---|---|---|---|
| 1 | `vmcli Disk Create` fails after `VM Create` | `VM Create` silently emits its own 20 GB disk; also writes a `memory.maxsize` cap that clamps RAM | Fixed — replace the disk, drop the cap |
| 2 | Keystrokes never reach the guest | **`vmcli MKS sendKeyEvent` is a silent no-op** — accepts args, exits 0, delivers nothing | Worked around — RFB/VNC client (`src/vnc.ts`) |
| 3 | `vmrun captureScreen` refuses | Treated as a guest operation, so it needs Tools + credentials — unusable during an install | Worked around — `vmcli MKS captureScreenshot` |
| 4 | Debian dies at "Configure the package manager" | Misleading error. Real cause: DNS lookup failure (host's router resolver died); VMware NAT forwards guest DNS to the host | Fixed — preseed writes public resolvers *ahead of* the DHCP one |
| 5 | Boot prompt received `boot: uto url=http:` | Bootloader dropped keystrokes; host was memory-starved and paging | Fixed — 150 ms key delay, 40 ms hold, shorter URL, 2 auto-retypes |
| 6 | Windows Setup: "cannot read the `<ProductKey>` setting" | Multi-edition `install.esd` with no `ei.cfg` — Setup can't pick an edition | Fixed — inject generic KMS client setup key per edition |
| 7 | Ubuntu GRUB line-edit boot command | — | Worked first attempt once #5 was fixed |

### Two upstream bugs worth flagging

**#2 is the significant one.** `vmcli MKS sendKeyEvent <hid> <modifier>` reports
success and does nothing, on 17.6.2, with the VNC console enabled and
`vncEnabled: true` confirmed via `vmcli MKS query`. Verified against a live
Debian installer boot menu: the selection never moved while the menu's own
countdown kept ticking, so the screen was demonstrably live. This is
load-bearing — every Linux installer needs a kernel argument an unmodified ISO
cannot carry, so without keyboard input **no Linux guest can be provisioned at
all** short of remastering multi-gigabyte ISOs.

**#3 is the same module behaving inconsistently:** of the two MKS subcommands,
screen capture works against a VM with no guest agent, while key injection does
not.

### Takeaways

- Installer error messages are a starting point, not a diagnosis. #4 said
  "architecture not supported"; the truth was a failed DNS lookup.
- Console typing is lossy, and loss scales with host load. Free RAM is a
  *correctness* issue here, not just a speed one.
- Provision one VM at a time on a 16 GB host.
- Of the seven, only #6 was preventable by reading documentation.
