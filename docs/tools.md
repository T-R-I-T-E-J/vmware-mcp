# Tool reference

Every tool the server exposes, generated from its own registered schemas by
[`scripts/gen-tool-docs.mjs`](../scripts/gen-tool-docs.mjs) — so this file cannot
drift from the code.

**57 tools.** ⚠️ marks tools that refuse to run without `confirm: true`.


## Discovery & lifecycle

[`list_isos`](#listisos) · [`list_vms`](#listvms) · [`get_vm_info`](#getvminfo) · [`create_vm`](#createvm) · [`configure_vm`](#configurevm) · [`delete_vm`](#deletevm) · [`register_vm`](#registervm)

### list_isos

_list_isos · read-only_

List the install media available in the read-only ISO library (ISO_LIBRARY). These are the ISOs create_vm and provision_vm can attach.

Takes no arguments.

### list_vms

_list_vms · read-only_

List every VM this server manages: those recorded in the registry, any VM directory found under VM_ROOT, and each path allowlisted via EXTRA_VM_PATHS. Includes current power state.

Takes no arguments.

### get_vm_info

_get_vm_info · read-only_

Full detail for one VM: resolved .vmx path, power state, VMware Tools state, key hardware settings read from the .vmx, snapshots, and registry metadata including provisioning notes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |

### create_vm

_create_vm_

Create a new VM under VM_ROOT: builds the .vmx via vmcli, creates a growable virtual disk, sets CPU/RAM/firmware/network, and optionally attaches an install ISO. The VM is left powered off. Use provision_vm instead if you want an unattended OS install end to end.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | **required** | VM name; becomes the folder name under VM_ROOT |
| `guestOsId` | string | **required** | vmcli guest OS id, e.g. windows9-64, windows11-64, windows9srv-64, windows2019srv-64 |
| `memoryMb` | integer | default `4096` |  |
| `cpus` | integer | default `2` |  |
| `coresPerSocket` | integer | optional |  |
| `diskGb` | integer | default `60` |  |
| `diskAdapter` | `nvme` \| `lsilogic` \| `sata` \| `ide` | default `"nvme"` |  |
| `firmware` | `bios` \| `efi` | default `"bios"` |  |
| `network` | `nat` \| `bridged` \| `hostonly` \| `custom` \| `none` | default `"nat"` |  |
| `customVnet` | string | optional | Required when network is "custom", e.g. "VMnet2" |
| `installIso` | string | optional | ISO filename within ISO_LIBRARY, or an absolute path inside it |
| `tags` | array | default `[]` |  |

### configure_vm

_configure_vm_

Change hardware on a powered-off VM: CPU, RAM, network type, attach or detach a CD-ROM ISO, or grow the virtual disk. Growing a disk only enlarges the container; the guest filesystem still has to be extended from inside.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `memoryMb` | integer | optional |  |
| `cpus` | integer | optional |  |
| `network` | `nat` \| `bridged` \| `hostonly` \| `custom` \| `none` | optional |  |
| `customVnet` | string | optional |  |
| `attachIso` | string | optional | ISO filename within ISO_LIBRARY, or absolute path inside it |
| `isoDevice` | string | default `"sata0:1"` | CD-ROM device slot |
| `detachIso` | boolean | default `false` | Detach the ISO at isoDevice |
| `growDiskGb` | integer | optional | New total disk size in GB |

### delete_vm ⚠️

_delete_vm_

Permanently delete a VM and every file in its directory. Irreversible. Requires confirm: true and refuses any VM outside VM_ROOT.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `confirm` | boolean | default `false` | Must be true. This operation is destructive and is refused without it. |

### register_vm

_register_vm_

Add an already-existing VM to the registry so it can carry tags, a credential reference, and take part in fleet_* operations. Does not modify the VM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `name` | string | optional | Registry name; defaults to the VM folder name |
| `guestOsId` | string | optional |  |
| `credentialRef` | string | optional |  |
| `tags` | array | default `[]` |  |

## Power

[`start_vm`](#startvm) · [`stop_vm`](#stopvm) · [`reset_vm`](#resetvm) · [`suspend_vm`](#suspendvm) · [`wait_for_tools`](#waitfortools) · [`install_tools`](#installtools)

### start_vm

_start_vm_

Power on a VM. mode "nogui" runs it headless in the background; "gui" opens the Workstation window, which you need if you plan to watch the console or send MKS keystrokes during an OS install.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `mode` | `gui` \| `nogui` | default `"nogui"` |  |
| `waitForTools` | boolean | default `false` | Block until VMware Tools reports running |
| `toolsTimeoutSec` | integer | default `300` |  |

### stop_vm

_stop_vm_

Power off a VM. "soft" asks the guest to shut down cleanly via VMware Tools and needs Tools running; "hard" is the equivalent of pulling the plug.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `mode` | `soft` \| `hard` | default `"soft"` |  |

### reset_vm

_reset_vm_

Restart a running VM. Soft reset asks the guest to reboot; hard reset is a virtual reset button.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `mode` | `soft` \| `hard` | default `"soft"` |  |

### suspend_vm

_suspend_vm_

Suspend a running VM to disk, preserving its exact state. start_vm resumes it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `mode` | `soft` \| `hard` | default `"soft"` |  |

### wait_for_tools

_wait_for_tools · read-only_

Block until VMware Tools reports running inside the guest. Tools running is the precondition for every guest_* tool, so this is the standard gate after a boot or a snapshot revert.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `timeoutSec` | integer | default `600` |  |

### install_tools

_install_tools_

Mount the VMware Tools installer in the running guest. On Windows this attaches the Tools ISO and the installer must then be run inside the guest; on Linux prefer installing open-vm-tools from the distro's package manager via guest_run.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |

## Unattended provisioning

[`provision_vm`](#provisionvm) · [`get_provision_status`](#getprovisionstatus) · [`finalize_provision`](#finalizeprovision) · [`preview_answer_file`](#previewanswerfile) · [`get_boot_command`](#getbootcommand)

### provision_vm

_provision_vm_

Build a VM and run its OS install end to end with no interaction: creates the hardware, generates the answer file (autounattend.xml for Windows, cloud-init for Ubuntu, preseed for Debian/Kali), delivers it, types any boot command the installer needs, waits for the install, and verifies the new account can actually run commands before reporting success. This is a long-running call — a Windows or Ubuntu install typically takes 20-40 minutes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | **required** | VM name; becomes the folder under VM_ROOT and the hostname |
| `installIso` | string | **required** | ISO filename from list_isos |
| `guestOsId` | string | **required** | vmcli guest OS id, e.g. windows9-64, windows9srv-64, ubuntu-64, debian12-64 |
| `username` | string | **required** | Account to create and log in as |
| `password` | string | **required** |  |
| `credentialRef` | string | optional | Store the credentials under this name and attach it to the VM for later guest_* calls |
| `memoryMb` | integer | default `4096` |  |
| `cpus` | integer | default `2` |  |
| `diskGb` | integer | default `60` |  |
| `firmware` | `bios` \| `efi` | default `"bios"` |  |
| `network` | `nat` \| `bridged` \| `hostonly` \| `custom` \| `none` | default `"nat"` |  |
| `customVnet` | string | optional |  |
| `tags` | array | default `[]` |  |
| `windowsImageName` | string | optional | Windows edition in install.wim, e.g. "Windows 10 Pro". Omit if the ISO has one image. |
| `windowsImageIndex` | integer | optional |  |
| `productKey` | string | optional |  |
| `bypassHardwareChecks` | boolean | default `false` | Windows 11 only: bypass the TPM and Secure Boot requirements |
| `autologin` | boolean | default `true` | Linux: enable desktop auto-logon |
| `extraPackages` | array | default `[]` |  |
| `timezone` | string | optional |  |
| `locale` | string | optional |  |
| `bootCommand` | string | optional | Override the typed boot command (send_keys syntax) |
| `bootWaitSec` | integer | optional |  |
| `keyDelayMs` | integer | optional |  |
| `installTimeoutMin` | integer | default `60` |  |
| `snapshotWhenReady` | boolean | default `true` |  |
| `wait` | boolean | default `false` | Block until the install finishes. Off by default because an OS install outlasts most client timeouts; leave it off and poll get_provision_status instead. |

### get_provision_status

_get_provision_status · read-only_

Report where a VM is in provisioning: its lifecycle state, the progress notes recorded so far, VMware Tools state, and any error. Use this to follow a provision_vm run or to understand why one failed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |

### finalize_provision

_finalize_provision_

Run the post-install steps for a VM that finished installing outside provision_vm — waits for VMware Tools, proves the account can run commands, ejects the install media so the VM stops rebooting into its installer, snapshots it, and marks it ready. Use this when the server was restarted mid-install, or when you installed a VM by hand and want it under management.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `credentialRef` | string | optional |  |
| `guestUser` | string | optional |  |
| `guestPassword` | string | optional |  |
| `waitMinutes` | integer | default `30` |  |
| `snapshotName` | string | default `"clean"` | Empty string skips the snapshot |

### preview_answer_file

_preview_answer_file · read-only_

Render the unattended answer file that provision_vm would generate, without creating anything. Use this to check partitioning, the account, or package selection before committing to a long install.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `installIso` | string | **required** | ISO filename from list_isos |
| `guestOsId` | string | **required** |  |
| `name` | string | default `"preview"` |  |
| `username` | string | default `"labuser"` |  |
| `password` | string | default `"ChangeMe123!"` |  |
| `firmware` | `bios` \| `efi` | default `"bios"` |  |
| `autologin` | boolean | default `true` |  |
| `bypassHardwareChecks` | boolean | default `false` |  |

### get_boot_command

_get_boot_command · read-only_

Show the keystrokes provision_vm types at the bootloader for a given installer, with its timing. Useful when tuning a boot command that is not landing.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `installerKind` | `windows` \| `debian` \| `kali` \| `ubuntu-autoinstall` | **required** |  |
| `seedUrl` | string | optional |  |

## Guest control

[`set_credential`](#setcredential) · [`guest_run`](#guestrun) · [`guest_run_script`](#guestrunscript) · [`guest_exec_capture`](#guestexeccapture) · [`guest_copy_to`](#guestcopyto) · [`guest_copy_from`](#guestcopyfrom) · [`guest_read_file`](#guestreadfile) · [`guest_write_file`](#guestwritefile) · [`guest_list_dir`](#guestlistdir) · [`guest_path_exists`](#guestpathexists) · [`guest_mkdir`](#guestmkdir) · [`guest_delete`](#guestdelete) · [`guest_list_processes`](#guestlistprocesses) · [`guest_kill_process`](#guestkillprocess)

### set_credential

_set_credential_

Save a named guest username/password to the credentials file so later guest_* calls can reference it by name instead of repeating the password. The password is never echoed back.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ref` | string | **required** | Name to store these credentials under |
| `username` | string | **required** |  |
| `password` | string | **required** |  |

### guest_run

_guest_run_

Execute a program inside the guest OS via VMware Tools. Give the full path to the executable (e.g. C:\Windows\System32\cmd.exe or /bin/ls) plus its arguments as a list. This runs the binary directly with no shell, so pipes and redirection do not work — use guest_run_script for those. Requires VMware Tools running.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `program` | string | **required** | Full path to the executable inside the guest |
| `args` | array | default `[]` |  |
| `noWait` | boolean | default `false` | Return immediately instead of waiting for exit |
| `interactive` | boolean | default `false` | Run in the interactive desktop session (needed for GUI apps) |
| `timeoutSec` | integer | default `300` |  |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### guest_run_script

_guest_run_script_

Run a script inside the guest with a chosen interpreter — /bin/bash on Linux, or C:\Windows\System32\cmd.exe / powershell.exe on Windows. Unlike guest_run this supports pipes, redirection, and multi-line logic. Requires VMware Tools running.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `interpreter` | string | default `"/bin/bash"` | Full path to the interpreter inside the guest |
| `script` | string | **required** | Script body |
| `timeoutSec` | integer | default `600` |  |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### guest_exec_capture

_guest_exec_capture_

The practical way to get output back from a guest. Runs a shell command, redirects stdout and stderr to a temp file inside the guest, copies that file to the host, and returns its contents. Works on both Windows and Linux guests.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `command` | string | **required** | Shell command line to run inside the guest |
| `shell` | `auto` \| `bash` \| `cmd` \| `powershell` | default `"auto"` | "auto" picks cmd/powershell for Windows guests and bash otherwise |
| `timeoutSec` | integer | default `600` |  |
| `maxBytes` | integer | default `200000` |  |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### guest_copy_to

_guest_copy_to_

Copy a single file from the host into the guest. The destination directory must already exist.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `hostPath` | string | **required** | Absolute path on the host |
| `guestPath` | string | **required** | Absolute destination path inside the guest |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### guest_copy_from

_guest_copy_from_

Copy a single file from the guest to the host. If hostPath is omitted the file lands in the server's work directory and the path is returned.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `guestPath` | string | **required** | Absolute path inside the guest |
| `hostPath` | string | optional | Absolute destination on the host |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### guest_read_file

_guest_read_file · read-only_

Fetch a text file out of the guest and return its contents inline.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `guestPath` | string | **required** |  |
| `maxBytes` | integer | default `200000` |  |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### guest_write_file

_guest_write_file_

Create or overwrite a text file inside the guest. Content is staged on the host and copied in, so it is safe for content containing quotes, newlines, or shell metacharacters.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `guestPath` | string | **required** |  |
| `content` | string | **required** |  |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### guest_list_dir

_guest_list_dir · read-only_

List the contents of a directory inside the guest.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `guestPath` | string | **required** |  |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### guest_path_exists

_guest_path_exists · read-only_

Report whether a path inside the guest exists, and whether it is a file or a directory.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `guestPath` | string | **required** |  |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### guest_mkdir

_guest_mkdir_

Create a directory inside the guest.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `guestPath` | string | **required** |  |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### guest_delete ⚠️

_guest_delete_

Delete a file or a directory inside the guest.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `guestPath` | string | **required** |  |
| `isDirectory` | boolean | default `false` |  |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### guest_list_processes

_guest_list_processes · read-only_

List processes running inside the guest, with pid, owner, and command line.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `filter` | string | optional | Case-insensitive substring match on the command line |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### guest_kill_process ⚠️

_guest_kill_process_

Terminate a process inside the guest by pid.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `pid` | integer | **required** |  |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

## Screen & input

[`capture_screen`](#capturescreen) · [`send_keys`](#sendkeys) · [`send_key_sequence`](#sendkeysequence) · [`enable_console_input`](#enableconsoleinput) · [`type_in_guest`](#typeinguest) · [`set_guest_resolution`](#setguestresolution)

### capture_screen

_capture_screen · read-only_

Capture the VM's current screen and return it as an image. Works with no guest agent and no credentials, so it is the way to see what a VM is doing during an OS install, at a boot menu, or at a login prompt.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `savePath` | string | optional | Optional host path to keep a copy of the PNG |
| `returnImage` | boolean | default `true` | Return the image inline. Set false to only get the file path. |

### send_keys

_send_keys_

Send keystrokes straight to the VM's virtual keyboard. This does not need VMware Tools or credentials, so it works at a BIOS screen, a bootloader menu, or a login prompt. Supports Packer-style tokens: plain text is typed literally, <enter> <tab> <esc> <up> <down> <f2>…<f12> are named keys, <ctrl-alt-del> style combos work, and <wait> / <wait5> pause for that many seconds.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `keys` | string | **required** | e.g. "root<enter><wait2>toor<enter>" |
| `keyDelayMs` | integer | default `60` | Delay between keystrokes. Raise it if the guest drops characters. |

### send_key_sequence

_send_key_sequence_

Pass a key sequence straight through to `vmcli MKS sendKeySequence` in its native syntax. An escape hatch for when send_keys cannot express something.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `sequence` | string | **required** |  |

### enable_console_input

_enable_console_input_

Turn on the VM's built-in VNC console, which is how send_keys reaches the guest keyboard. Needed to type at a BIOS screen, bootloader, or installer — anywhere VMware Tools is not yet running. The VM must be powered off; the setting persists.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `port` | integer | optional | Defaults to the next free port from 5910 |

### type_in_guest

_type_in_guest_

Type a literal string into the guest's active window using VMware Tools. Needs Tools running and guest credentials — unlike send_keys, which talks to the virtual keyboard directly. Prefer send_keys unless you specifically need Tools-mediated input.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `keystrokes` | string | **required** |  |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### set_guest_resolution

_set_guest_resolution_

Change the guest's display resolution. Requires VMware Tools running in the guest.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `width` | integer | **required** |  |
| `height` | integer | **required** |  |

## Networking & sharing

[`get_guest_ip`](#getguestip) · [`set_network`](#setnetwork) · [`list_host_networks`](#listhostnetworks) · [`get_host_gateway_ip`](#gethostgatewayip) · [`add_shared_folder`](#addsharedfolder) · [`remove_shared_folder`](#removesharedfolder) · [`list_shared_folders`](#listsharedfolders) · [`set_port_forward`](#setportforward) · [`list_port_forwards`](#listportforwards)

### get_guest_ip

_get_guest_ip · read-only_

Read the guest's IP address via VMware Tools. Set wait to block until the guest has actually obtained an address, which is useful right after a boot.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `wait` | boolean | default `false` |  |

### set_network

_set_network_

Change a VM's network adapter mode. "nat" shares the host's connection (the default, best for internet access from an isolated guest); "bridged" puts the VM directly on the physical LAN; "hostonly" isolates it to a private network with the host only — the right choice for a malware or exploit lab; "none" disconnects it entirely. The VM must be powered off.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `mode` | `nat` \| `bridged` \| `hostonly` \| `custom` \| `none` | **required** |  |
| `customVnet` | string | optional | Required for "custom", e.g. "VMnet2" |
| `adapterIndex` | integer | default `0` |  |

### list_host_networks

_list_host_networks · read-only_

List the host's VMware virtual networks (VMnet0, VMnet1, VMnet8, …) with their types and subnets. Use this to find the host-side gateway address, which is what a guest must reach to talk to a service running on the host.

Takes no arguments.

### get_host_gateway_ip

_get_host_gateway_ip · read-only_

Return the host-side gateway address for a VMware virtual network — the address a guest uses to reach a service running on the host. Provisioning uses this to serve preseed files to Linux installers.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `hostNetwork` | string | default `"vmnet8"` |  |

### add_shared_folder

_add_shared_folder_

Expose a host directory inside the guest. On Windows guests it appears under \\vmware-host\Shared Folders; on Linux guests it mounts under /mnt/hgfs once open-vm-tools is installed. Shared folders are enabled on the VM as part of this call.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `shareName` | string | **required** |  |
| `hostPath` | string | **required** | Absolute host directory to share |
| `writable` | boolean | default `true` |  |

### remove_shared_folder

_remove_shared_folder_

Stop sharing a host folder with the guest.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `shareName` | string | **required** |  |

### list_shared_folders

_list_shared_folders · read-only_

List the host folders shared with this VM, as recorded in its .vmx.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |

### set_port_forward

_set_port_forward_

Add a NAT port forward so a service inside the guest is reachable from the host. Applies to the host network (usually VMnet8 for NAT) rather than to a specific VM, so the guest IP must be given explicitly.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `hostNetwork` | string | default `"vmnet8"` |  |
| `protocol` | `tcp` \| `udp` | default `"tcp"` |  |
| `hostPort` | integer | **required** |  |
| `guestIp` | string | **required** |  |
| `guestPort` | integer | **required** |  |
| `description` | string | optional |  |

### list_port_forwards

_list_port_forwards · read-only_

List the port forwards configured on a host virtual network.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `hostNetwork` | string | default `"vmnet8"` |  |

## Snapshots

[`snapshot_create`](#snapshotcreate) · [`snapshot_list`](#snapshotlist) · [`snapshot_revert`](#snapshotrevert) · [`snapshot_delete`](#snapshotdelete)

### snapshot_create

_snapshot_create_

Take a snapshot. Works on a running or powered-off VM; snapshotting a running VM also captures its memory, which is slower but resumes instantly.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `name` | string | **required** | Snapshot name |

### snapshot_list

_snapshot_list · read-only_

List a VM's snapshots. Pass showTree to see the parent/child hierarchy.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `showTree` | boolean | default `false` |  |

### snapshot_revert ⚠️

_snapshot_revert_

Roll the VM back to a snapshot. Every change made since that snapshot is discarded. Requires confirm: true.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `name` | string | **required** |  |
| `confirm` | boolean | default `false` | Must be true. This operation is destructive and is refused without it. |

### snapshot_delete ⚠️

_snapshot_delete_

Delete a snapshot, merging its data into the parent. The VM's current state is unaffected. Requires confirm: true.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vm` | string | **required** | VM name (folder under VM_ROOT) or an absolute path to its .vmx file |
| `name` | string | **required** |  |
| `andDeleteChildren` | boolean | default `false` |  |
| `confirm` | boolean | default `false` | Must be true. This operation is destructive and is refused without it. |

## Fleet

[`fleet_status`](#fleetstatus) · [`fleet_start`](#fleetstart) · [`fleet_stop`](#fleetstop) · [`fleet_run`](#fleetrun) · [`fleet_snapshot`](#fleetsnapshot) · [`fleet_revert`](#fleetrevert)

### fleet_status

_fleet_status · read-only_

Report power state, VMware Tools state, and lifecycle for every VM matching a selector. The starting point for any fleet operation.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | **required** | Which VMs to act on: an exact name, a glob like "win*", "tag:lab" to match a tag, or "*" for every registered VM |

### fleet_start

_fleet_start_

Power on every VM matching the selector, a few at a time. Respects the host's max-running-VMs limit; VMs already running are skipped rather than treated as failures.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | **required** | Which VMs to act on: an exact name, a glob like "win*", "tag:lab" to match a tag, or "*" for every registered VM |
| `mode` | `gui` \| `nogui` | default `"nogui"` |  |
| `maxConcurrency` | integer | optional |  |
| `waitForTools` | boolean | default `false` |  |
| `toolsTimeoutSec` | integer | default `600` |  |

### fleet_stop

_fleet_stop_

Power off every running VM matching the selector. "soft" shuts each guest down cleanly via VMware Tools; "hard" is an immediate power cut.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | **required** | Which VMs to act on: an exact name, a glob like "win*", "tag:lab" to match a tag, or "*" for every registered VM |
| `mode` | `soft` \| `hard` | default `"soft"` |  |
| `maxConcurrency` | integer | optional |  |

### fleet_run

_fleet_run_

Run the same shell command inside every matching guest and collect the output from each. Each VM uses its own stored credentialRef unless credentials are given explicitly. VMs without VMware Tools running are reported as failures rather than silently skipped.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | **required** | Which VMs to act on: an exact name, a glob like "win*", "tag:lab" to match a tag, or "*" for every registered VM |
| `command` | string | **required** |  |
| `shell` | `auto` \| `bash` \| `cmd` \| `powershell` | default `"auto"` |  |
| `timeoutSec` | integer | default `300` |  |
| `maxConcurrency` | integer | optional |  |
| `credentialRef` | string | optional | Name of a stored credential in credentials.json |
| `guestUser` | string | optional | Guest username (overrides credentialRef) |
| `guestPassword` | string | optional | Guest password (overrides credentialRef) |

### fleet_snapshot

_fleet_snapshot_

Take a snapshot with the same name on every matching VM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | **required** | Which VMs to act on: an exact name, a glob like "win*", "tag:lab" to match a tag, or "*" for every registered VM |
| `name` | string | **required** |  |
| `maxConcurrency` | integer | optional |  |

### fleet_revert ⚠️

_fleet_revert_

Roll every matching VM back to a named snapshot, discarding all state since. The fast way to reset a lab between runs. Requires confirm: true.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | **required** | Which VMs to act on: an exact name, a glob like "win*", "tag:lab" to match a tag, or "*" for every registered VM |
| `name` | string | **required** |  |
| `maxConcurrency` | integer | optional |  |
| `confirm` | boolean | default `false` | Must be true. This operation is destructive and is refused without it. |
