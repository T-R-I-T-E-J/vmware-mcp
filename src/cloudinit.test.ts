import { describe, it, expect } from "vitest";
import { buildUserData, buildMetaData } from "./seed/cloudinit.js";

describe("buildUserData", () => {
  const hash = "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1";

  it("generates valid cloud-init user-data", () => {
    const yaml = buildUserData(
      {
        hostname: "ubuntu-lab",
        username: "labuser",
        password: "testpass",
      },
      hash,
    );

    expect(yaml).toContain("#cloud-config");
    expect(yaml).toContain("autoinstall:");
    expect(yaml).toContain("version: 1");
    expect(yaml).toContain("hostname: ubuntu-lab");
    expect(yaml).toContain(`username: labuser`);
    expect(yaml).toContain(`password: "${hash}"`);
  });

  it("includes open-vm-tools in package list", () => {
    const yaml = buildUserData(
      { hostname: "test", username: "u", password: "p" },
      hash,
    );
    expect(yaml).toContain("open-vm-tools");
  });

  it("includes openssh-server", () => {
    const yaml = buildUserData(
      { hostname: "test", username: "u", password: "p" },
      hash,
    );
    expect(yaml).toContain("openssh-server");
  });

  it("includes autologin packages and GDM config when requested", () => {
    const yaml = buildUserData(
      { hostname: "test", username: "u", password: "p", autologin: true },
      hash,
    );
    expect(yaml).toContain("open-vm-tools-desktop");
    expect(yaml).toContain("AutomaticLoginEnable=true");
    expect(yaml).toContain("AutomaticLogin=u");
  });

  it("includes provisioned marker in late-commands", () => {
    const yaml = buildUserData(
      { hostname: "test", username: "u", password: "p" },
      hash,
    );
    expect(yaml).toContain("vmware-mcp-ready");
  });

  it("accepts custom locale, timezone, and keyboard", () => {
    const yaml = buildUserData(
      {
        hostname: "test",
        username: "u",
        password: "p",
        locale: "fr_FR.UTF-8",
        timezone: "Europe/Paris",
        keyboardLayout: "fr",
      },
      hash,
    );
    expect(yaml).toContain("locale: fr_FR.UTF-8");
    expect(yaml).toContain("timezone: Europe/Paris");
    expect(yaml).toContain("layout: fr");
  });

  it("includes shutdown: reboot", () => {
    const yaml = buildUserData(
      { hostname: "test", username: "u", password: "p" },
      hash,
    );
    expect(yaml).toContain("shutdown: reboot");
  });
});

describe("buildMetaData", () => {
  it("generates valid meta-data", () => {
    const md = buildMetaData("i-abc123", "my-host");
    expect(md).toContain("instance-id: i-abc123");
    expect(md).toContain("local-hostname: my-host");
  });
});
