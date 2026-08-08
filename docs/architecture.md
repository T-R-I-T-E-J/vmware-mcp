# Project scope & architecture

A guided tour for anyone arriving at this repo cold: what the project does, why
it exists, how it is put together, and which VMware interfaces it drives.

---

## 1. What this project is

**An MCP server that gives an AI agent hands inside VMware Workstation.**

Claude can already write a script. What it cannot normally do is *operate a
computer that has no operating system on it yet* — press a key at a boot menu,
read what a BIOS prompt says, answer an installer's questions. This server
provides that.

You ask for a VM. Roughly 30 minutes later you have a running machine with a
working login, and every tool needed to run commands inside it.

```mermaid
flowchart LR
    U["You"] -->|"build me a Windows 10 lab VM"| C["Claude Code"]
    C -->|"MCP over stdio"| S["<b>vmware-mcp</b><br/>57 tools"]
    S --> W["VMware Workstation 17 Pro"]
    W --> V1["win10-lab"]
    W --> V2["ubuntu-lab"]
    W --> V3["kali-lab"]
    V1 -.->|"run commands,<br/>copy files,<br/>screenshots"| S
```

### What makes it different

Most VM automation can only talk to a guest that **already** boots, has an agent
installed, and has working networking. That is a large assumption: it cannot
install an OS, and it cannot help when networking is what's broken.

This server works in the gap before any of that exists.

```mermaid
flowchart TB
    subgraph pre["Before the OS exists — no agent, no credentials, no network"]
        direction LR
        A1["<b>See</b><br/>vmcli MKS captureScreenshot"]
        A2["<b>Type</b><br/>VNC KeyEvent · src/vnc.ts"]
        A3["<b>Power &amp; storage</b><br/>vmrun start/stop/snapshot"]
    end
    subgraph post["After install — VMware Tools running"]
        direction LR
        B1["<b>Run</b><br/>guest_run · guest_exec_capture"]
        B2["<b>Files</b><br/>copy in/out, read, write"]
        B3["<b>Network</b><br/>guest IP, shared folders"]
    end
    pre ==>|"unattended install<br/>bridges the gap"| post
```

The left-hand box is the interesting half, and the reason the odd design choices
below exist.

---

## 2. The three channels it drives

VMware exposes no single API that covers everything, so the server speaks three
protocols and picks per operation.

```mermaid
flowchart TD
    S["vmware-mcp"]
    S --> R["<b>vmrun.exe</b><br/>power · snapshots · clone<br/>guest ops via VMware Tools"]
    S --> M["<b>vmcli.exe</b><br/>VM/disk creation · vmx config<br/>screenshots"]
    S --> V["<b>VNC / RFB</b><br/>src/vnc.ts<br/>keyboard input"]
    S --> H["<b>HTTP seed server</b><br/>src/seed/httpSeed.ts<br/>serves preseed to installers"]
    R --> W["VMware Workstation"]
    M --> W
    V --> W
    H -.->|"fetched by the guest"| W
```

| Channel | Used for | Requires a guest OS? |
|---|---|---|
| `vmrun` | power, snapshots, clone, all `guest_*` operations | Guest ops: **yes** (VMware Tools + credentials) |
| `vmcli` | `VM Create`, disks, `.vmx` config, **screenshots** | No |
| VNC (RFB) | keyboard input at bootloaders and login screens | No |
| HTTP seed | handing `preseed.cfg` to Debian/Kali installers | No |

### Which VMware functions we actually call

The whole server rests on this surface. Nothing else from VMware is used.

```mermaid
flowchart LR
    subgraph vmrun["<b>vmrun.exe</b> — VIX"]
        direction TB
        R1["start · stop · reset<br/>suspend · pause · unpause"]
        R2["snapshot · listSnapshots<br/>revertToSnapshot · deleteSnapshot"]
        R3["runProgramInGuest<br/>runScriptInGuest<br/>listProcessesInGuest<br/>killProcessInGuest"]
        R4["CopyFileFromHostToGuest<br/>CopyFileFromGuestToHost<br/>listDirectoryInGuest<br/>fileExistsInGuest"]
        R5["getGuestIPAddress<br/>addSharedFolder<br/>setPortForwarding"]
        R6["clone · deleteVM<br/>checkToolsState · installTools"]
    end
    subgraph vmcli["<b>vmcli.exe</b>"]
        direction TB
        C1["VM Create"]
        C2["Disk Create"]
        C3["ConfigParams SetEntry"]
        C4["MKS captureScreenshot"]
    end
    subgraph other["Other"]
        direction TB
        O1["vmware-vdiskmanager -x<br/>grow a disk"]
        O2["RFB / VNC KeyEvent<br/>src/vnc.ts"]
        O3["IMAPI2 COM<br/>build seed ISOs"]
        O4["direct .vmx editing<br/>src/vmx.ts"]
    end
```

| VMware function | Used by | Needs a guest OS? |
|---|---|---|
| `vmrun start/stop/reset/suspend` | `start_vm` `stop_vm` `reset_vm` `suspend_vm` | No |
| `vmrun snapshot` family | all `snapshot_*`, `fleet_snapshot`, `fleet_revert` | No |
| `vmrun runProgramInGuest` / `runScriptInGuest` | `guest_run` `guest_run_script` `guest_exec_capture` `fleet_run` | **Yes** |
| `vmrun CopyFile*` / `listDirectoryInGuest` | all `guest_copy_*`, `guest_read_file`, `guest_write_file` | **Yes** |
| `vmrun listProcessesInGuest` / `killProcessInGuest` | `guest_list_processes` `guest_kill_process` | **Yes** |
| `vmrun getGuestIPAddress` | `get_guest_ip` | **Yes** |
| `vmrun addSharedFolder` / `setPortForwarding` | shared-folder and port-forward tools | Partly |
| `vmrun checkToolsState` | `wait_for_tools`, every `guest_*` precondition | No |
| `vmrun clone` | *not yet exposed* — see [#7](../../issues/7) | No |
| `vmcli VM Create` + `Disk Create` | `create_vm` `provision_vm` | No |
| `vmcli ConfigParams SetEntry` | `configure_vm` | No |
| `vmcli MKS captureScreenshot` | `capture_screen` | No |
| `vmware-vdiskmanager -x` | `configure_vm` (grow disk) | No |
| RFB `KeyEvent` (our own client) | `send_keys`, every boot command | No |
| IMAPI2 COM | seed ISO generation | No |
| Direct `.vmx` editing | `create_vm` `configure_vm` `set_network` | No |

Two deliberate absences: **`vmrun captureScreen`** is unused (it demands a guest
login), and **`vmcli MKS sendKeyEvent`** is unused (it silently does nothing).
Both are explained below.

### Why VNC, and not the obvious API

`vmcli MKS sendKeyEvent` is the documented way to send a keystroke. On
Workstation 17.6.2 it **accepts its arguments, exits 0, and delivers nothing** —
verified against a live installer boot menu that never moved
([#1](../../issues/1)). Since every Linux installer needs a kernel argument that
an unmodified ISO cannot carry, a working keyboard is not optional: without it
**no Linux guest can be provisioned at all**.

So keyboard input goes over the VM's built-in VNC server using a small RFB
client (RFC 6143, ~250 lines). `create_vm` enables that console on every VM it
creates.

---

## 3. How the code is arranged

```mermaid
flowchart TD
    subgraph tools["src/tools/ — 57 MCP tools"]
        direction LR
        T1["lifecycle"]; T2["power"]; T3["guest"]; T4["screen"]
        T5["network"]; T6["snapshots"]; T7["provision"]; T8["fleet"]
    end
    subgraph domain["Domain logic"]
        direction LR
        D1["provision.ts<br/>install state machine"]
        D2["seed/<br/>answer files + ISO builder"]
        D3["bootCommand.ts<br/>per-installer keystrokes"]
    end
    subgraph drivers["Drivers"]
        direction LR
        V1["vmrun.ts"]; V2["vmcli.ts"]; V3["vnc.ts"]; V4["vmx.ts"]
    end
    subgraph support["Cross-cutting"]
        direction LR
        S1["paths.ts<br/>allowlist"]; S2["registry.ts<br/>VM inventory"]; S3["config.ts"]
    end
    tools --> domain
    tools --> drivers
    tools --> support
    domain --> drivers
    drivers --> E["<b>exec.ts</b><br/>execFile · timeouts · password redaction"]
    E --> P["vmrun.exe · vmcli.exe · powershell.exe"]
```

**The one rule:** tools never spawn processes. Everything funnels through
`exec.ts`, the single place `execFile` is called — so timeouts, error
normalisation, and password redaction are implemented once and cannot be
bypassed. Processes are spawned with an argv array and **never a shell**, so a
guest command coming from a model cannot be reinterpreted as host shell syntax.

| File | Responsibility |
|---|---|
| `exec.ts` | The only process spawner. Redacts anything after `-gp`/`-p`/`-vp` |
| `paths.ts` | Allowlist gate — every VM path resolves through `fs.realpath` |
| `registry.ts` | JSON inventory: name → vmx, OS family, lifecycle, tags, notes |
| `vmx.ts` | Parse and patch `.vmx` files (flat `key = "value"`) |
| `vnc.ts` | Minimal RFB client — the keyboard |
| `provision.ts` | The install state machine |
| `seed/isoBuilder.ts` | Builds answer-file ISOs via IMAPI2 (no Windows ADK needed) |
| `seed/sha512crypt.ts` | `$6$` password hashing, checked against spec vectors |

---

## 4. How an unattended install actually works

This is the core of the project. `provision_vm` takes a blank disk and an ISO and
returns a machine you can run commands on.

```mermaid
sequenceDiagram
    participant C as Claude
    participant S as vmware-mcp
    participant W as Workstation
    participant G as Guest

    C->>S: provision_vm(name, iso, user, password)
    S->>W: vmcli VM Create + disk + .vmx settings

    alt Windows / Ubuntu
        S->>S: generate answer file
        S->>S: build seed ISO (IMAPI2, ISO9660+Joliet)
        S->>W: attach as second CD-ROM
    else Debian / Kali
        S->>S: start HTTP server on the vmnet8 host IP
    end

    S->>W: power on
    Note over S,G: wait for the bootloader
    S->>G: type boot command over VNC

    opt Debian / Kali
        G->>S: GET /p  (preseed)
        Note over S,G: no fetch in 75s → retype (2 attempts)
    end

    G->>G: partition, install, create account, install Tools
    loop poll
        S->>W: checkToolsState
    end
    S->>G: run a command as the new user
    G-->>S: exit 0 → login verified
    S->>W: eject media, snapshot "clean"
    S-->>C: lifecycle = ready
```

**"Ready" is proven, not assumed.** VMware Tools can report *running* before the
account is usable, so the server additionally executes a real command as the new
user. Only then does the VM become `ready`.

### Answer-file delivery differs per OS

```mermaid
flowchart LR
    subgraph win["Windows 10 / 11 / Server"]
        W1["autounattend.xml"] --> W2["seed CD-ROM"] --> W3["Setup auto-scans<br/>removable media"]
    end
    subgraph ubu["Ubuntu 24.04"]
        U1["cloud-init user-data"] --> U2["seed CD labelled<br/><b>CIDATA</b>"] --> U3["type 'autoinstall'<br/>at GRUB"]
    end
    subgraph deb["Debian 12 / Kali"]
        D1["preseed.cfg"] --> D2["HTTP from host"] --> D3["type 'auto url=...'<br/>at boot prompt"]
    end
```

Windows is the only one needing no kernel argument — Setup finds
`autounattend.xml` by itself, which makes it the most reliable path. The Linux
installers all need something typed, which is why the keyboard channel matters
so much.

Debian/Kali use HTTP rather than a second CD because `preseed/file=` is
unreliable when the installer disc already owns `/cdrom`. The server binds that
HTTP listener to the **vmnet8 host address only**, never `0.0.0.0`, so the answer
file is never exposed to the physical LAN.

---

## 5. VM lifecycle

```mermaid
stateDiagram-v2
    [*] --> created: create_vm
    created --> provisioning: provision_vm
    provisioning --> ready: Tools running<br/>AND login verified
    provisioning --> failed: timeout or<br/>bad credentials
    failed --> provisioning: retry (planned, #9)
    [*] --> imported: register_vm
    imported --> ready
    ready --> [*]: delete_vm (confirm)
    note right of ready
        All guest_* tools work
        from here onward
    end note
```

---

## 6. The safety model

The server can destroy VMs, so every path is gated.

```mermaid
flowchart TD
    I["VM path from a tool call"] --> RP["fs.realpath<br/>(defeats symlinks and ..)"]
    RP --> Q{"inside VM_ROOT?"}
    Q -->|yes| OK["✅ allowed"]
    Q -->|no| X{"listed in<br/>EXTRA_VM_PATHS?"}
    X -->|yes| OK2["✅ allowed for read/write<br/>❌ delete_vm still refuses"]
    X -->|no| D["❌ PathNotAllowedError"]
```

- **`G:\iso` is read-only.** ISOs can be listed and attached, never written.
  `VM_ROOT` is deliberately a *different* directory, so a `delete_vm` bug can
  never reach your install media.
- **Destructive tools require `confirm: true`** — `delete_vm`,
  `snapshot_revert`, `snapshot_delete`, `fleet_revert`.
- **Guest passwords** live in `%APPDATA%\vmware-mcp\credentials.json` and are
  referenced by name, so they need not appear in tool arguments. They are
  redacted from every error message and log line.

---

## 7. The 57 tools

```mermaid
flowchart LR
    R["vmware-mcp"] --- G1["<b>Lifecycle</b> · 7<br/>list_isos · list_vms · get_vm_info<br/>create_vm · configure_vm<br/>delete_vm · register_vm"]
    R --- G2["<b>Power</b> · 6<br/>start · stop · reset · suspend<br/>wait_for_tools · install_tools"]
    R --- G3["<b>Provisioning</b> · 5<br/>provision_vm · get_provision_status<br/>finalize_provision<br/>preview_answer_file · get_boot_command"]
    R --- G4["<b>Guest control</b> · 14<br/>guest_run · guest_run_script<br/>guest_exec_capture · copy in/out<br/>read/write · list_dir · processes"]
    R --- G5["<b>Screen &amp; input</b> · 6<br/>capture_screen · send_keys<br/>enable_console_input<br/>type_in_guest · set_resolution"]
    R --- G6["<b>Network</b> · 9<br/>get_guest_ip · set_network<br/>shared folders · port forwards"]
    R --- G7["<b>Snapshots</b> · 4<br/>create · list · revert · delete"]
    R --- G8["<b>Fleet</b> · 6<br/>status · start · stop<br/>run · snapshot · revert"]
```

Full parameters for every tool: **[docs/tools.md](tools.md)** (generated from the
server's own schemas). Verification status per tool: [ROADMAP.md](../ROADMAP.md).

### Which tool do I want?

```mermaid
flowchart TD
    S{"What are you<br/>trying to do?"}
    S --> A["Get a new VM"]
    S --> B["Do something<br/>inside a guest"]
    S --> C["The VM is stuck<br/>or has no OS"]
    S --> D["Act on many VMs"]

    A --> A1{"Want the OS<br/>installed too?"}
    A1 -->|yes| A2["<b>provision_vm</b><br/>then poll get_provision_status"]
    A1 -->|no| A3["<b>create_vm</b><br/>then start_vm"]

    B --> B1{"Need the<br/>output back?"}
    B1 -->|yes| B2["<b>guest_exec_capture</b>"]
    B1 -->|no| B3["guest_run · guest_run_script"]
    B --> B4["Files → guest_copy_to/from<br/>guest_read_file · guest_write_file"]

    C --> C1["<b>capture_screen</b><br/>see what it's doing"]
    C1 --> C2["<b>send_keys</b><br/>type at the console"]
    C2 --> C3["needs enable_console_input<br/>if VM predates this server"]

    D --> D1["fleet_status → fleet_start<br/>fleet_run → fleet_snapshot"]
```

The `guest_*` branch needs VMware Tools running and credentials. The
`capture_screen` / `send_keys` branch needs neither — which is why it is the
answer whenever something is broken.

---

## 8. Where to start reading

| Interest | Start here |
|---|---|
| Using it | [`README.md`](../README.md) |
| Why it's built this way | [`docs/field-notes.md`](field-notes.md) — seven real failures |
| What's done vs unproven | [`ROADMAP.md`](../ROADMAP.md) |
| The unusual code | `src/vnc.ts` (keyboard), `src/seed/isoBuilder.ts` (ISOs without the ADK), `src/seed/sha512crypt.ts` |
| The core logic | `src/provision.ts` |

### Honest status

**Kali 2024.4 has been provisioned end to end** — blank disk to `lifecycle:
ready`, with the account proven by running commands in it:

```
kali-lab   lifecycle: ready   toolsState: running   snapshots: clean, verified
guest_exec_capture → Linux kali 6.11.2-amd64 · uid=1000(labuser)
get_guest_ip       → 192.168.119.138
file write/read    → 22 bytes, exact round-trip
fleet_run          → 1 succeeded, 0 failed
```

That verified the guest layer. Windows 10, Ubuntu, and Server 2019 remain
untested to completion. `ROADMAP.md` tracks status per tool rather than claiming
the whole surface works.
