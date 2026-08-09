# Roadmap

What is done, what is unproven, and what is missing. Kept honest on purpose —
"built" and "verified" are tracked separately, because on this project the gap
between them has been the whole story.

Bugs found along the way live in [`docs/field-notes.md`](docs/field-notes.md)
and as [issues](../../issues).

---

## Status of the 57 tools

Verification means the tool ran against real hardware and did what it claimed.

### Verified ✅

| Area | Tools |
|---|---|
| Discovery / lifecycle | `list_isos` `list_vms` `get_vm_info` `create_vm` `delete_vm` `register_vm` |
| Power | `start_vm` `stop_vm` `reset_vm` |
| Screen & input | `capture_screen` `send_keys` `enable_console_input` |
| Provisioning | `preview_answer_file` `get_boot_command` |
| Network (host side) | `list_host_networks` `get_host_gateway_ip` |
| Fleet | `fleet_status` |
| Internals | path allowlist, `confirm: true` gates, IMAPI2 seed ISO, sha512-crypt |

`provision_vm` is **verified** on both Linux paths: Kali 2024.4 (preseed over
HTTP) and Ubuntu 24.04 (cloud-init `CIDATA` seed) each went from a blank disk to
`ready`. Kali also exercised the boot-command retry path — attempts 1 and 2
dropped keystrokes, attempt 3 landed. Windows is still in progress.

### Built, not yet verified ⛔

Roughly **35 of 57 tools**. Not known-broken — unproven. Everything here needs a
guest that boots with VMware Tools running, which is exactly what has been
blocked.

- All 14 `guest_*` tools
- `snapshot_create` `snapshot_revert` `snapshot_delete`
- `get_guest_ip` `set_network` `add_shared_folder` `remove_shared_folder`
  `list_shared_folders` `set_port_forward` `list_port_forwards`
- `wait_for_tools` `install_tools` `finalize_provision`
- `fleet_start` `fleet_stop` `fleet_run` `fleet_snapshot` `fleet_revert`
- `configure_vm` `suspend_vm` `type_in_guest` `set_guest_resolution`
  `send_key_sequence`

**Unblocking this is the top priority.** One finished Linux install verifies the
majority of it in a single pass.

---

## Backlog

### P0 — Clone VMs instead of reinstalling them ([#7](../../issues/7))

The original goal was running *multiple* VMs. Today each one costs a 30–40 minute
install, so a ten-VM lab is a lost afternoon and 400 GB.

`vmrun clone` is already wrapped in `src/vmrun.ts` — it is simply not exposed as
a tool. With a template plus linked clones, VM #2 onward take about 30 seconds
and a few hundred MB each.

- `clone_vm` (full and linked), requiring a snapshot for linked mode
- `mark_template` / template flag in the registry
- `fleet_clone` — build N VMs from one template in a single call

This changes what the server is for: from "install VMs" to "spin up a lab".

### P1 — Verify the guest layer ([#8](../../issues/8))

Finish one Linux install, then exercise `guest_run`, `guest_exec_capture`, file
round-trip, `get_guest_ip`, snapshots, and `fleet_run`. Move ~35 tools from
unproven to verified.

### P1 — Provision resume ([#9](../../issues/9))

A failed install cannot be retried; the VM has to be deleted and rebuilt.
`finalize_provision` recovers a VM whose install finished on its own, but there
is no path back from a failure partway through.

### P2 — Expose what already exists ([#10](../../issues/10))

Helpers implemented in `src/vmrun.ts` with no tool wrapping them:
`pause` `unpause` `renameFileInGuest` `setSharedFolderState`
`disableSharedFolders`.

### P2 — Tests ([#11](../../issues/11))

No unit tests beyond the `sha512crypt` self-check. The pure logic is cheap to
cover and is where silent breakage would hurt most:

- `keymap.ts` — boot-command parsing, modifier handling
- `vmx.ts` — parse/patch round-trip
- `paths.ts` — allowlist, `..` traversal, symlink escape
- answer-file generators — snapshot tests on the emitted XML/YAML/preseed

Then CI on push.

### P2 — Recursive directory copy ([#12](../../issues/12))

`guest_copy_to` / `guest_copy_from` handle single files only, because that is all
`vmrun` offers. Walking a tree and copying file-by-file is the fix.

### P3 — Hardware and format coverage ([#13](../../issues/13))

Multiple NICs (`create_vm` only wires `ethernet0`), USB passthrough, OVF/OVA
import and export, hot-add CPU/RAM, encrypted VMs (`-vp` is redacted in `exec.ts`
but no tool accepts it), ISO library subdirectory scanning.

---

## Guest OS support

| Guest | Path | State |
|---|---|---|
| Windows 10 | `autounattend.xml` on seed CD | Installs unattended; OOBE, auto-logon, and Tools install unverified |
| Ubuntu 24.04 desktop | cloud-init `CIDATA` seed | **✅ Verified end to end — reached `ready`** |
| Debian 12 | preseed over HTTP | Reaches package install; completion unverified |
| Kali 2024.4 | preseed over HTTP (Kali mirror) | **✅ Verified end to end — reached `ready`** |
| Windows Server 2019 | `autounattend.xml`, image index 2 | Untested |
| Windows 7 | `autounattend.xml` | Untested, best-effort — Tools support on 17.x is legacy |

## Environment notes

- Provision one VM at a time on a 16 GB host. Free RAM is a *correctness* issue:
  memory pressure caused dropped keystrokes ([#4](../../issues/4)).
- Windows edition enumeration needs elevation, so the generic-key table in
  `src/seed/autounattend.ts` is inference, not lookup ([#5](../../issues/5)).
