import { describe, it, expect } from "vitest";
import { redactArgv } from "./exec.js";

describe("redactArgv", () => {
  it("redacts password after -gp flag", () => {
    const result = redactArgv(["vmrun.exe", "-T", "ws", "-gu", "admin", "-gp", "secret123", "start"]);
    expect(result).toContain("***");
    expect(result).not.toContain("secret123");
  });

  it("redacts password after -p flag", () => {
    const result = redactArgv(["vmrun.exe", "-p", "encrypted-pass", "start"]);
    expect(result).toContain("***");
    expect(result).not.toContain("encrypted-pass");
  });

  it("redacts password after -vp flag", () => {
    const result = redactArgv(["vmrun.exe", "-vp", "vpro-pass"]);
    expect(result).toContain("***");
    expect(result).not.toContain("vpro-pass");
  });

  it("preserves non-secret arguments", () => {
    const result = redactArgv(["vmrun.exe", "-T", "ws", "start", "test.vmx", "nogui"]);
    expect(result).toContain("vmrun.exe");
    expect(result).toContain("start");
    expect(result).toContain("test.vmx");
    expect(result).toContain("nogui");
  });

  it("handles empty argv", () => {
    const result = redactArgv([]);
    expect(result).toBe("");
  });

  it("quotes args containing spaces", () => {
    const result = redactArgv(["C:\\Program Files\\vmrun.exe", "start"]);
    expect(result).toContain('"C:\\Program Files\\vmrun.exe"');
  });

  it("does not redact non-flag args that look similar", () => {
    const result = redactArgv(["vmrun.exe", "start", "test-gp.vmx", "nogui"]);
    expect(result).toContain("test-gp.vmx");
    expect(result).not.toContain("***");
  });

  it("redacts multiple password args in sequence", () => {
    const result = redactArgv(["vmrun.exe", "-gp", "pass1", "-gp", "pass2"]);
    const stars = (result.match(/\*\*\*/g) ?? []).length;
    expect(stars).toBe(2);
  });

  it("handles -gp at end of argv with no value", () => {
    const result = redactArgv(["vmrun.exe", "start", "-gp"]);
    expect(result).toContain("-gp");
  });
});
