// Send a keystroke string to a VM and screenshot the result, without going
// through shell JSON quoting. Usage: node scripts/keys.mjs <vm> "<keys>" [png]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [vm, keys, png] = process.argv.slice(2);
if (!vm || !keys) {
  console.error('usage: node scripts/keys.mjs <vm> "<keys>" [screenshot.png]');
  process.exit(1);
}

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
const client = new Client({ name: "keys", version: "1.0.0" });
await client.connect(transport);

const r = await client.callTool(
  { name: "send_keys", arguments: { vm, keys } },
  undefined,
  { timeout: 600000, maxTotalTimeout: 600000 },
);
console.log((r.content ?? []).map((c) => c.text ?? "").join("\n"));

if (png) {
  const s = await client.callTool(
    { name: "capture_screen", arguments: { vm, savePath: png, returnImage: false } },
    undefined,
    { timeout: 120000, maxTotalTimeout: 120000 },
  );
  console.log((s.content ?? []).map((c) => c.text ?? "").join("\n"));
}

await client.close();
process.exit(0);
