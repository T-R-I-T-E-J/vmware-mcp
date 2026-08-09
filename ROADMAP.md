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

`provision_vm` is **verified on all three delivery paths**, each from a blank
disk to `ready`:

- **Kali 2024.4** — preseed over HTTP. Also exercised the boot-command retry
  path: attempts 1 and 2 dropped keystrokes, attempt 3 landed.
- **Ubuntu 24.04** — cloud-init `CIDATA` seed ISO, GRUB line-edit boot command.
- **Windows 10 Pro** — `autounattend.xml` on a seed CD, auto-logon, VMware Tools
  installed at first logon. 7/7 guest checks pass.

**All four requested guests are verified.** Windows 7 remains untested and
best-effort — Tools support on Workstation 17 is legacy.

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

Everything below P0 was closed in the audit-fix pass; see
[`scripts/verify-fixes.mjs`](scripts/verify-fixes.mjs), which re-checks each one
against a live host rather than trusting the commit message.

### Done

| Issue | Fix | Verified by |
|---|---|---|
| [#7](../../issues/7) | `clone_vm`, `fleet_clone`, `mark_template`, `delete_clone_tree` | linked clone in 4 s / 4 MB; 3 clones in 7.5 s; clone boots and answers `guest_exec_capture` |
| [#10](../../issues/10) | `pause_vm`, `unpause_vm`, `guest_rename`, `set_shared_folder_state`, `disable_shared_folders` | all present in the tool list |
| [#11](../../issues/11) | `node:test` suite | 35 tests passing |
| [#12](../../issues/12) | `guest_copy_dir_to` / `guest_copy_dir_from` | nested tree round-trips host→guest→host, 3 copied 0 failed |
| [#18](../../issues/18) | seed ISOs deleted after provisioning | seed directory empty |
| [#19](../../issues/19) | media detached with the VM powered off | no `sata0:1-3` entries on any VM |
| [#20](../../issues/20) | `assertHostPathAllowed` on every host read and write | write to `C:\Windows\Temp` refused |
| [#21](../../issues/21) | `icacls` ACL on `credentials.json` | ACL reads `<user>:(F)` only |
| [#22](../../issues/22) | in-process port reservation + live-listener check | four VMs, four distinct ports |
| [#23](../../issues/23) | directory lock + pid-unique temp file | registry valid, no `.tmp` leftovers |
| [#24](../../issues/24) | probe the guest when `osFamily` is unknown | forced `osFamily: "other"` still selected bash |
| [#25](../../issues/25) | prune scratch files older than the retention window | 30-day-old file removed, fresh one kept |

### Still open

**[#1](../../issues/1) and [#2](../../issues/2)** are VMware defects, worked
around but unresolved upstream. Not fixable here.

**[#9](../../issues/9) Provision resume** — a failed install still cannot be
retried; the VM has to be deleted and rebuilt. `finalize_provision` covers the
adjacent case where an install *completed* while the orchestrator was down.

**[#13](../../issues/13) Hardware and format coverage** — multiple NICs, USB
passthrough, OVF import/export, hot-add CPU/RAM, encrypted VMs, ISO library
subdirectories.

**[#8](../../issues/8) Remaining verification** — Windows 7 is untested and
best-effort; the Server 2019 `<AdministratorPassword>` fix has not been proven on
a fresh install, because that OOBE prompt was cleared by hand to avoid a rebuild.

**Rule learned the hard way ([#19](../../issues/19)): a `.vmx` edit made while a
VM is running does not persist** — VMware rewrites the file at power-off.
`configure_vm` and `set_network` already refuse on a running VM; anything else
touching the `.vmx` must do the same.

## Guest OS support

| Guest | Path | State |
|---|---|---|
| Windows 10 | `autounattend.xml` on seed CD | **✅ Verified end to end — reached `ready`, 7/7 guest checks** |
| Ubuntu 24.04 desktop | cloud-init `CIDATA` seed | **✅ Verified end to end — reached `ready`** |
| Debian 12 | preseed over HTTP | Reaches package install; completion unverified |
| Kali 2024.4 | preseed over HTTP (Kali mirror) | **✅ Verified end to end — reached `ready`** |
| Windows Server 2019 | `autounattend.xml`, image index 2 | **✅ Verified end to end — reached `ready`, 7/7 guest checks** |
| Windows 7 | `autounattend.xml` | Untested, best-effort — Tools support on 17.x is legacy |

## Environment notes

- Provision one VM at a time on a 16 GB host. Free RAM is a *correctness* issue:
  memory pressure caused dropped keystrokes ([#4](../../issues/4)).
- Windows edition enumeration needs elevation, so the generic-key table in
  `src/seed/autounattend.ts` is inference, not lookup ([#5](../../issues/5)).
