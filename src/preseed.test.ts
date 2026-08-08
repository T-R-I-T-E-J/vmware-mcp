import { describe, it, expect } from "vitest";
import { buildPreseed, kaliDefaults } from "./seed/preseed.js";

describe("buildPreseed", () => {
  it("generates a valid preseed with required sections", () => {
    const cfg = buildPreseed({
      hostname: "test-debian",
      username: "labuser",
      password: "testpass",
    });

    expect(cfg).toContain("d-i debian-installer/locale string");
    expect(cfg).toContain("d-i passwd/username string labuser");
    expect(cfg).toContain("d-i passwd/user-password password testpass");
    expect(cfg).toContain("d-i netcfg/get_hostname string test-debian");
    expect(cfg).toContain("open-vm-tools");
    expect(cfg).toContain("d-i partman-auto/method string regular");
    expect(cfg).toContain("d-i grub-installer/bootdev string default");
  });

  it("disables root login by default", () => {
    const cfg = buildPreseed({
      hostname: "test",
      username: "u",
      password: "p",
    });
    expect(cfg).toContain("d-i passwd/root-login boolean false");
    expect(cfg).not.toContain("d-i passwd/root-password");
  });

  it("enables root login when root password is provided", () => {
    const cfg = buildPreseed({
      hostname: "test",
      username: "u",
      password: "p",
      rootPassword: "rootpw",
    });
    expect(cfg).toContain("d-i passwd/root-login boolean true");
    expect(cfg).toContain("d-i passwd/root-password password rootpw");
  });

  it("includes DNS fallback entries", () => {
    const cfg = buildPreseed({
      hostname: "test",
      username: "u",
      password: "p",
    });
    expect(cfg).toContain("nameserver 1.1.1.1");
    expect(cfg).toContain("nameserver 8.8.8.8");
  });

  it("includes autologin config when requested", () => {
    const cfg = buildPreseed({
      hostname: "test",
      username: "u",
      password: "p",
      autologin: true,
    });
    expect(cfg).toContain("autologin-user");
    expect(cfg).toContain("open-vm-tools-desktop");
  });

  it("includes provisioned marker in late commands", () => {
    const cfg = buildPreseed({
      hostname: "test",
      username: "u",
      password: "p",
    });
    expect(cfg).toContain("vmware-mcp-ready");
  });

  it("accepts custom mirror and tasks", () => {
    const cfg = buildPreseed({
      hostname: "test",
      username: "u",
      password: "p",
      mirrorHostname: "mirror.example.com",
      mirrorDirectory: "/custom-debian",
      tasks: ["standard", "gnome-desktop"],
    });
    expect(cfg).toContain("d-i mirror/http/hostname string mirror.example.com");
    expect(cfg).toContain("d-i mirror/http/directory string /custom-debian");
    expect(cfg).toContain("tasksel tasksel/first multiselect standard, gnome-desktop");
  });
});

describe("kaliDefaults", () => {
  it("returns Kali-specific settings", () => {
    const defaults = kaliDefaults();
    expect(defaults.mirrorHostname).toBe("http.kali.org");
    expect(defaults.mirrorDirectory).toBe("/kali");
    expect(defaults.tasks).toContain("kali-desktop-xfce");
    expect(defaults.tasks).toContain("kali-tools-top10");
  });
});
