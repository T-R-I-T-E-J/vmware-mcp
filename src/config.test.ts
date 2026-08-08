import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vmmcp-cfg-test-"));
const credFile = path.join(tmpRoot, "credentials.json");
const vmRoot = path.join(tmpRoot, "vms");

beforeAll(() => {
  process.env.VM_ROOT = vmRoot;
  process.env.ISO_LIBRARY = path.join(tmpRoot, "iso");
  process.env.VMWARE_MCP_WORK_DIR = path.join(tmpRoot, "work");
  process.env.VMWARE_MCP_CREDENTIALS = credFile;
  fs.mkdirSync(vmRoot, { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "iso"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "work"), { recursive: true });
});

afterAll(() => {
  delete process.env.VM_ROOT;
  delete process.env.VMWARE_MCP_CREDENTIALS;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Must come after env setup because loadConfig is called on import
const configMod = await import("./config.js");
const { saveCredential, loadCredential, resolveCredential } = configMod;

describe("saveCredential and loadCredential", () => {
  it("writes and reads back a credential atomically", () => {
    saveCredential("test-vm", { username: "admin", password: "secret" });
    const cred = loadCredential("test-vm");
    expect(cred.username).toBe("admin");
    expect(cred.password).toBe("secret");
  });

  it("recovery from corrupt credentials file by overwriting", () => {
    fs.writeFileSync(credFile, "not valid json!!!", "utf8");
    saveCredential("fresh", { username: "u", password: "p" });
    const cred = loadCredential("fresh");
    expect(cred.username).toBe("u");
  });

  it("preserves existing credentials when saving a new one", () => {
    saveCredential("vm1", { username: "u1", password: "p1" });
    saveCredential("vm2", { username: "u2", password: "p2" });
    const c1 = loadCredential("vm1");
    const c2 = loadCredential("vm2");
    expect(c1.username).toBe("u1");
    expect(c2.username).toBe("u2");
  });
});

describe("resolveCredential", () => {
  it("prefers inline credentials over stored ref", () => {
    saveCredential("stored", { username: "stored-user", password: "stored-pass" });
    const cred = resolveCredential({
      credentialRef: "stored",
      guestUser: "inline-user",
      guestPassword: "inline-pass",
    });
    expect(cred.username).toBe("inline-user");
    expect(cred.password).toBe("inline-pass");
  });

  it("handles guestPassword being an empty string (falsy but defined)", () => {
    const cred = resolveCredential({ guestUser: "u", guestPassword: "" });
    expect(cred.username).toBe("u");
    expect(cred.password).toBe("");
  });

  it("throws when no credentials are provided", () => {
    expect(() => resolveCredential({})).toThrow("Guest credentials required");
  });
});
