// MCP smoke-test client: spawns the server over stdio and calls tools by name.
// Usage: node smoke.mjs <toolName> '<jsonArgs>' [<toolName> '<jsonArgs>' ...]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = "C:\\Users\\trite\\projects\\vmware-mcp\\dist\\index.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: {
    ...process.env,
    VM_ROOT: process.env.VM_ROOT ?? "C:\\Users\\trite\\VMs",
    ISO_LIBRARY: process.env.ISO_LIBRARY ?? "C:\\Users\\trite\\iso",
  },
  stderr: "inherit",
});

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`TOOLS (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(", ")}\n`);

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const name = argv[i];
  const args = JSON.parse(argv[i + 1] ?? "{}");
  console.log(`--- ${name} ${JSON.stringify(args)}`);
  try {
    const r = await client.callTool({ name, arguments: args });
    for (const c of r.content ?? []) {
      if (c.type === "text") console.log(c.text.length > 3000 ? c.text.slice(0, 3000) + "\n…truncated" : c.text);
      else console.log(`[${c.type} content, ${c.data?.length ?? 0} b64 chars]`);
    }
    if (r.isError) console.log("(isError)");
  } catch (e) {
    console.log("CALL FAILED:", e.message);
  }
  console.log();
}

await client.close();
process.exit(0);
