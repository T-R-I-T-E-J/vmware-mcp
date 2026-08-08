// Generate docs/tools.md from the server's own registered schemas, so the
// reference cannot drift from the code.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["C:\\Users\\trite\\projects\\vmware-mcp\\dist\\index.js"],
  env: { ...process.env, VM_ROOT: "C:\\Users\\trite\\VMs", ISO_LIBRARY: "C:\\Users\\trite\\iso" },
  stderr: "ignore",
});
const client = new Client({ name: "docgen", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();

const GROUPS = [
  ["Discovery & lifecycle", ["list_isos","list_vms","get_vm_info","create_vm","configure_vm","delete_vm","register_vm"]],
  ["Power", ["start_vm","stop_vm","reset_vm","suspend_vm","wait_for_tools","install_tools"]],
  ["Unattended provisioning", ["provision_vm","get_provision_status","finalize_provision","preview_answer_file","get_boot_command"]],
  ["Guest control", ["set_credential","guest_run","guest_run_script","guest_exec_capture","guest_copy_to","guest_copy_from","guest_read_file","guest_write_file","guest_list_dir","guest_path_exists","guest_mkdir","guest_delete","guest_list_processes","guest_kill_process"]],
  ["Screen & input", ["capture_screen","send_keys","send_key_sequence","enable_console_input","type_in_guest","set_guest_resolution"]],
  ["Networking & sharing", ["get_guest_ip","set_network","list_host_networks","get_host_gateway_ip","add_shared_folder","remove_shared_folder","list_shared_folders","set_port_forward","list_port_forwards"]],
  ["Snapshots", ["snapshot_create","snapshot_list","snapshot_revert","snapshot_delete"]],
  ["Fleet", ["fleet_status","fleet_start","fleet_stop","fleet_run","fleet_snapshot","fleet_revert"]],
];

const byName = new Map(tools.map((t) => [t.name, t]));

function params(t) {
  const s = t.inputSchema ?? {};
  const props = s.properties ?? {};
  const required = new Set(s.required ?? []);
  const names = Object.keys(props);
  if (names.length === 0) return "_none_";
  return names
    .map((n) => {
      const p = props[n];
      let type = p.type ?? (p.anyOf ? p.anyOf.map((x) => x.type).filter(Boolean).join("\\|") : "any");
      if (p.enum) type = p.enum.map((v) => `\`${v}\``).join(" \\| ");
      const req = required.has(n) ? "**required**" : p.default !== undefined ? `default \`${JSON.stringify(p.default)}\`` : "optional";
      const desc = (p.description ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      return `| \`${n}\` | ${type} | ${req} | ${desc} |`;
    })
    .join("\n");
}

let out = `# Tool reference

Every tool the server exposes, generated from its own registered schemas by
[\`scripts/gen-tool-docs.mjs\`](../scripts/gen-tool-docs.mjs) — so this file cannot
drift from the code.

**${tools.length} tools.** ⚠️ marks tools that refuse to run without \`confirm: true\`.

`;

for (const [group, names] of GROUPS) {
  const present = names.filter((n) => byName.has(n));
  out += `\n## ${group}\n\n`;
  out += present.map((n) => `[\`${n}\`](#${n.replace(/_/g, "")})`).join(" · ") + "\n";
  for (const n of present) {
    const t = byName.get(n);
    const destructive = t.annotations?.destructiveHint ? " ⚠️" : "";
    const ro = t.annotations?.readOnlyHint ? " · read-only" : "";
    out += `\n### ${n}${destructive}\n\n_${t.annotations?.title ?? n}${ro}_\n\n${t.description ?? ""}\n\n`;
    const p = params(t);
    if (p === "_none_") out += "Takes no arguments.\n";
    else out += `| Parameter | Type | Required | Description |\n|---|---|---|---|\n${p}\n`;
  }
}

const covered = new Set(GROUPS.flatMap(([, n]) => n));
const missed = tools.map((t) => t.name).filter((n) => !covered.has(n));
if (missed.length) out += `\n## Ungrouped\n\n${missed.map((n) => `\`${n}\``).join(", ")}\n`;

fs.writeFileSync("docs/tools.md", out, "utf8");
console.log(`wrote docs/tools.md — ${tools.length} tools, ${missed.length} ungrouped`);
await client.close();
process.exit(0);
