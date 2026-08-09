// Call one tool with a long timeout, without shell JSON quoting problems.
// Usage: node scripts/call.mjs <tool> '<json>' [timeoutSec]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, jsonArgs, timeoutSec] = process.argv.slice(2);
if (!tool) {
  console.error("usage: node scripts/call.mjs <tool> '<json>' [timeoutSec]");
  process.exit(1);
}
const timeout = (Number(timeoutSec) || 1800) * 1000;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["C:\\Users\\trite\\projects\\vmware-mcp\\dist\\index.js"],
  env: {
    ...process.env,
    VM_ROOT: process.env.VM_ROOT ?? "C:\\Users\\trite\\VMs",
    ISO_LIBRARY: process.env.ISO_LIBRARY ?? "C:\\Users\\trite\\iso",
  },
  stderr: "inherit",
});
const client = new Client({ name: "call", version: "1.0.0" });
await client.connect(transport);

const r = await client.callTool(
  { name: tool, arguments: JSON.parse(jsonArgs || "{}") },
  undefined,
  { timeout, maxTotalTimeout: timeout },
);
console.log((r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n"));
if (r.isError) process.exitCode = 1;

await client.close();
process.exit(r.isError ? 1 : 0);
