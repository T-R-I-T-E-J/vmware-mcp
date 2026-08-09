// Round-trip a VM through OVF: export to .ova, import it back, confirm the
// import is a usable VM in the registry.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SRC = process.argv[2] ?? "ovf-probe";
const WORK = path.join(process.env.APPDATA, "vmware-mcp", "work");
const OVA = path.join(WORK, `${SRC}.ova`);
const IMPORTED = `${SRC}-reimported`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["C:\\Users\\trite\\projects\\vmware-mcp\\dist\\index.js"],
  env: {
    ...process.env,
    VM_ROOT: process.env.VM_ROOT ?? "C:\\Users\\trite\\VMs",
    ISO_LIBRARY: process.env.ISO_LIBRARY ?? "C:\\Users\\trite\\iso",
  },
  stderr: "ignore",
});
const client = new Client({ name: "ovf", version: "1.0.0" });
await client.connect(transport);

async function call(name, args, sec = 1800) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: sec * 1000, maxTotalTimeout: sec * 1000 });
  const out = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${r.isError ? "[ERROR]" : "[ok]"}\n${out.slice(0, 900)}`);
  return { ok: !r.isError, out };
}

fs.rmSync(OVA, { force: true });
const exported = await call("export_ovf", { vm: SRC, destination: OVA, format: "ova" });
const haveOva = fs.existsSync(OVA);
console.log(`\nOVA on disk: ${haveOva ? `${Math.round(fs.statSync(OVA).size / 1048576)} MB` : "MISSING"}`);

let imported = { ok: false };
if (haveOva) {
  imported = await call("import_ovf", { source: OVA, name: IMPORTED, tags: ["probe", "imported"] });
  if (imported.ok) await call("get_vm_info", { vm: IMPORTED }, 120);
}

const ok = exported.ok && haveOva && imported.ok;
console.log(`\n=== OVF round trip: ${ok ? "OK" : "FAILED"} ===`);
await client.close();
process.exit(ok ? 0 : 1);
