// Exercise guest_copy_dir_to / guest_copy_dir_from against a live guest.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const VM = process.argv[2] ?? "kali-lab";
const WORK = path.join(process.env.APPDATA, "vmware-mcp", "work");
const SRC = path.join(WORK, "dirtest");
const BACK = path.join(WORK, "dirback");

fs.rmSync(SRC, { recursive: true, force: true });
fs.rmSync(BACK, { recursive: true, force: true });
fs.mkdirSync(path.join(SRC, "sub", "deep"), { recursive: true });
fs.writeFileSync(path.join(SRC, "a.txt"), "file a");
fs.writeFileSync(path.join(SRC, "sub", "b.txt"), "file b");
fs.writeFileSync(path.join(SRC, "sub", "deep", "c.txt"), "file c");

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
const client = new Client({ name: "dircopy", version: "1.0.0" });
await client.connect(transport);

async function call(name, args, sec = 600) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: sec * 1000, maxTotalTimeout: sec * 1000 });
  const out = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${r.isError ? "[ERROR]" : "[ok]"}\n${out.slice(0, 1200)}`);
  return { ok: !r.isError, out };
}

const isWindows = /win/i.test(VM);
const guestDir = isWindows ? "C:\\Windows\\Temp\\dirtest" : "/tmp/dirtest";

await call("guest_copy_dir_to", { vm: VM, hostDir: SRC, guestDir, credentialRef: VM });
await call("guest_exec_capture", {
  vm: VM,
  command: isWindows
    ? `Get-ChildItem -Recurse -File '${guestDir}' | ForEach-Object FullName; Get-Content '${guestDir}\\sub\\deep\\c.txt'`
    : `find ${guestDir} -type f | sort; echo ---; cat ${guestDir}/sub/deep/c.txt`,
  credentialRef: VM,
});
await call("guest_copy_dir_from", { vm: VM, guestDir, hostDir: BACK, credentialRef: VM });

const back = [];
const walk = (d, p = "") => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full, p ? `${p}/${e.name}` : e.name);
    else back.push((p ? `${p}/` : "") + e.name);
  }
};
if (fs.existsSync(BACK)) walk(BACK);
back.sort();
console.log(`\n=== round trip ===\nback on host: ${back.join(", ") || "(none)"}`);
const expected = ["a.txt", "sub/b.txt", "sub/deep/c.txt"];
const ok = JSON.stringify(back) === JSON.stringify(expected);
console.log(ok ? "OK round trip preserved the tree" : `FAIL expected ${expected.join(", ")}`);
if (ok) console.log("c.txt contents:", fs.readFileSync(path.join(BACK, "sub", "deep", "c.txt"), "utf8"));

fs.rmSync(SRC, { recursive: true, force: true });
fs.rmSync(BACK, { recursive: true, force: true });
await client.close();
process.exit(ok ? 0 : 1);
