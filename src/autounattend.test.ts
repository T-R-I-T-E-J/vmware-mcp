import { describe, it, expect } from "vitest";
import { buildAutounattend, genericKeyFor } from "./seed/autounattend.js";

describe("genericKeyFor", () => {
  it("returns a key for Windows 10 Pro", () => {
    const key = genericKeyFor("Windows 10 Pro", false);
    expect(key).toBeDefined();
    expect(key).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  });

  it("returns undefined for server editions", () => {
    const key = genericKeyFor("Windows Server 2019", true);
    expect(key).toBeUndefined();
  });

  it("defaults to Windows 10 Pro when imageName is undefined", () => {
    const key = genericKeyFor(undefined, false);
    expect(key).toBe("W269N-WFGWX-YVC9B-4J6C9-T83GX");
  });
});

describe("buildAutounattend", () => {
  it("generates valid XML with required elements", () => {
    const xml = buildAutounattend({
      username: "testuser",
      password: "testpass",
      computerName: "TEST-PC",
      firmware: "bios",
      installVmwareTools: true,
    });

    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("<unattend");
    expect(xml).toContain("<AcceptEula>true</AcceptEula>");
    expect(xml).toContain("<Name>testuser</Name>");
    expect(xml).toContain("<ComputerName>TEST-PC</ComputerName>");
    expect(xml).toContain("<AutoLogon>");
    expect(xml).toContain("<Enabled>true</Enabled>");
  });

  it("includes product key by default", () => {
    const xml = buildAutounattend({
      username: "u",
      password: "p",
      computerName: "PC",
      firmware: "bios",
    });
    expect(xml).toContain("<ProductKey>");
    expect(xml).toContain("<Key>");
  });

  it("uses custom product key when provided", () => {
    const xml = buildAutounattend({
      username: "u",
      password: "p",
      computerName: "PC",
      firmware: "bios",
      productKey: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE",
    });
    expect(xml).toContain("AAAAA-BBBBB-CCCCC-DDDDD-EEEEE");
  });

  it("bypasses hardware checks when requested", () => {
    const xml = buildAutounattend({
      username: "u",
      password: "p",
      computerName: "PC",
      firmware: "bios",
      bypassHardwareChecks: true,
    });
    expect(xml).toContain("BypassTPMCheck");
    expect(xml).toContain("BypassSecureBootCheck");
  });

  it("generates UEFI partition layout", () => {
    const xml = buildAutounattend({
      username: "u",
      password: "p",
      computerName: "PC",
      firmware: "efi",
    });
    expect(xml).toContain("<Type>EFI</Type>");
    expect(xml).toContain("<Type>MSR</Type>");
  });

  it("generates BIOS partition layout", () => {
    const xml = buildAutounattend({
      username: "u",
      password: "p",
      computerName: "PC",
      firmware: "bios",
    });
    expect(xml).toContain("<Active>true</Active>");
    expect(xml).toContain("<PartitionID>2</PartitionID>");
  });

  it("includes FirstLogonCommands with VMware Tools install", () => {
    const xml = buildAutounattend({
      username: "u",
      password: "p",
      computerName: "PC",
      firmware: "bios",
      installVmwareTools: true,
    });
    expect(xml).toContain("setup64.exe");
    expect(xml).toContain("vmware-mcp-ready.txt");
  });

  it("XML-escapes special characters in passwords", () => {
    const xml = buildAutounattend({
      username: "u",
      password: "p<test>&\"'",
      computerName: "PC",
      firmware: "bios",
    });
    expect(xml).not.toContain("p<test>");
    expect(xml).toContain("&lt;");
    expect(xml).toContain("&quot;");
  });
});
