import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vmmcp-cfg-test-"));
const credFile = path.join(tmpRoot, "credentials.json");

vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  // We only override loadConfig — everything else uses the original implementation.
  let cfgCache: ReturnType<typeof actual.loadConfig> | null = null;
  return {
    ...actual,
    loadConfig: () => {
      if (cfgCache) return cfgCache;
      cfgCache = {
        vmwareDir: "C:\\VMware",
        vmrun: "C:\\VMware\\vmrun.exe",
        vmcli: "C:\\VMware\\vmcli.exe",
        vdiskmanager: "C:\\VMware\\vmware-vdiskmanager.exe",
        toolsWindowsIso: null,
        vmRoot: path.join(tmpRoot, "vms"),
        isoLibrary: path.join(tmpRoot, "iso"),
        extraVmPaths: [] as string[],
        workDir: path.join(tmpRoot, "work"),
        credentialsFile: credFile,
        execTimeoutMs: 120000,
        defaultConcurrency: 4,
        maxRunningVms: 8,
      };
      return cfgCache;
    },
  };
});

import { saveCredential, loadCredential, resolveCredential } from "./config.js";

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("saveCredential and loadCredential", () => {
  it("writes and reads back a credential atomically", () => {
    saveCredential("test-vm", { username: "admin", password: "secret" });
    const cred = loadCredential("test-vm");
    expect(cred.username).toBe("admin");
    expect(cred.password).toBe("secret");
  });

  it("recovery from corrupt credentials file by overwriting", () => {
    const dir = path.dirname(credFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(credFile, "not valid json!!!", "utf8");
    // Should not throw — overwrites the corrupt file with the new credential.
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
