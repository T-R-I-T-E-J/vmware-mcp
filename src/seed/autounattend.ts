/**
 * Windows unattended-install answer file.
 *
 * Windows Setup scans the root of every removable volume for `autounattend.xml`
 * at boot, so simply attaching this on a second CD-ROM is enough — no boot
 * command or kernel arguments needed. That makes Windows the most reliable of
 * the unattended paths.
 */

export interface WindowsUnattendOptions {
  /** Local administrator account the install creates and logs into. */
  username: string;
  password: string;
  computerName: string;
  /** Windows edition name as it appears in the ISO's install.wim, e.g. "Windows 10 Pro". */
  imageName?: string;
  /** Server media uses its own embedded evaluation licence, so no key is injected. */
  isServer?: boolean;
  /** Alternatively select the edition by its index in install.wim. */
  imageIndex?: number;
  productKey?: string;
  locale?: string;
  timeZone?: string;
  /** UEFI installs need a different partition layout than BIOS ones. */
  firmware: "bios" | "efi";
  /** Windows 11 refuses to install without TPM 2.0 and Secure Boot unless bypassed. */
  bypassHardwareChecks?: boolean;
  /** Path to the mounted VMware Tools installer inside the guest. */
  installVmwareTools?: boolean;
  /** Extra commands run at first logon, after Tools. */
  firstLogonCommands?: string[];
}

/**
 * Microsoft's published generic (KMS client setup) keys. These do not activate
 * anything — they exist precisely so unattended installs can pick an edition.
 *
 * They are needed because consumer Windows media ships a multi-edition
 * install.esd with no ei.cfg. Without a key, Setup either shows an edition
 * picker (breaking the unattended run) or fails outright with "Windows cannot
 * read the <ProductKey> setting from the unattend answer file" — which is the
 * error this host produced on the Windows 10 ISO.
 */
const GENERIC_KEYS: Record<string, string> = {
  "windows 10 pro": "W269N-WFGWX-YVC9B-4J6C9-T83GX",
  "windows 10 pro n": "MH37W-N47XK-V7XM9-C7227-GCQG9",
  "windows 10 home": "TX9XD-98N7V-6WMQ6-BX7FG-H8Q99",
  "windows 10 home n": "3KHY7-WNT83-DGQKR-F7HPR-844BM",
  "windows 10 home single language": "7HNRX-D7KGG-3K4RQ-4WPJ4-YTDFH",
  "windows 10 education": "NW6C2-QMPVW-D7KKK-3GKT6-VCFB2",
  "windows 10 enterprise": "NPPR9-FWDCX-D2C8J-H872K-2YT43",
  "windows 11 pro": "W269N-WFGWX-YVC9B-4J6C9-T83GX",
  "windows 11 home": "TX9XD-98N7V-6WMQ6-BX7FG-H8Q99",
};

/**
 * Pick a key for the requested edition. Server media is deliberately excluded:
 * evaluation ISOs carry their own embedded licence and reject KMS client keys.
 */
export function genericKeyFor(imageName: string | undefined, guestIsServer: boolean): string | undefined {
  if (guestIsServer) return undefined;
  return GENERIC_KEYS[(imageName ?? "Windows 10 Pro").trim().toLowerCase()];
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

/**
 * BIOS installs get a single System Reserved + primary layout; UEFI needs the
 * EFI System Partition and MSR that Windows Setup expects on GPT.
 */
function diskConfiguration(firmware: "bios" | "efi"): string {
  if (firmware === "efi") {
    return `
        <DiskConfiguration>
          <Disk wcm:action="add">
            <DiskID>0</DiskID>
            <WillWipeDisk>true</WillWipeDisk>
            <CreatePartitions>
              <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>
              <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>128</Size></CreatePartition>
              <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
            </CreatePartitions>
            <ModifyPartitions>
              <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Label>System</Label><Format>FAT32</Format></ModifyPartition>
              <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
              <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Label>Windows</Label><Letter>C</Letter><Format>NTFS</Format></ModifyPartition>
            </ModifyPartitions>
          </Disk>
        </DiskConfiguration>
        <ImageInstall>
          <OSImage>
            <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
          </OSImage>
        </ImageInstall>`;
  }
  return `
        <DiskConfiguration>
          <Disk wcm:action="add">
            <DiskID>0</DiskID>
            <WillWipeDisk>true</WillWipeDisk>
            <CreatePartitions>
              <CreatePartition wcm:action="add"><Order>1</Order><Type>Primary</Type><Size>500</Size></CreatePartition>
              <CreatePartition wcm:action="add"><Order>2</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
            </CreatePartitions>
            <ModifyPartitions>
              <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Label>System</Label><Format>NTFS</Format><Active>true</Active></ModifyPartition>
              <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID><Label>Windows</Label><Letter>C</Letter><Format>NTFS</Format></ModifyPartition>
            </ModifyPartitions>
          </Disk>
        </DiskConfiguration>
        <ImageInstall>
          <OSImage>
            <InstallTo><DiskID>0</DiskID><PartitionID>2</PartitionID></InstallTo>
          </OSImage>
        </ImageInstall>`;
}

/**
 * Windows 11 blocks install on VMs without TPM 2.0 / Secure Boot / enough RAM.
 * These registry values, written from WinPE before setup proceeds, are the
 * documented bypass.
 */
function hardwareBypass(): string {
  const keys = ["BypassTPMCheck", "BypassSecureBootCheck", "BypassRAMCheck", "BypassCPUCheck", "BypassStorageCheck"];
  return `
        <RunSynchronous>
          ${keys
            .map(
              (k, i) => `<RunSynchronousCommand wcm:action="add">
            <Order>${i + 1}</Order>
            <Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v ${k} /t REG_DWORD /d 1 /f</Path>
          </RunSynchronousCommand>`,
            )
            .join("\n          ")}
        </RunSynchronous>`;
}

export function buildAutounattend(o: WindowsUnattendOptions): string {
  const locale = o.locale ?? "en-US";
  const tz = o.timeZone ?? "UTC";
  const user = xmlEscape(o.username);
  const pass = xmlEscape(o.password);

  // An explicit key wins; otherwise fall back to the generic edition-selection
  // key so multi-edition media does not stop at a picker.
  const effectiveKey = o.productKey ?? genericKeyFor(o.imageName, o.isServer ?? false);

  const imageSelector = o.imageName
    ? `<InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/NAME</Key><Value>${xmlEscape(o.imageName)}</Value></MetaData></InstallFrom>`
    : o.imageIndex !== undefined
      ? `<InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>${o.imageIndex}</Value></MetaData></InstallFrom>`
      : "";

  const disk = diskConfiguration(o.firmware).replace(
    "<InstallTo>",
    `${imageSelector}\n            <InstallTo>`,
  );

  // VMware Tools autoruns from the mounted ISO; setup64.exe /S /v"/qn" is the
  // silent-install invocation, and REBOOT=R suppresses its own restart so the
  // sequence below stays in order.
  const logonCommands: string[] = [];
  if (o.installVmwareTools) {
    logonCommands.push(
      `cmd /c for %d in (D E F G H I J) do @if exist %d:\\setup64.exe start /wait %d:\\setup64.exe /S /v"/qn REBOOT=R"`,
    );
  }
  logonCommands.push(
    // Marker the provisioner polls for to know first logon really completed.
    `cmd /c echo provisioned > C:\\Windows\\Temp\\vmware-mcp-ready.txt`,
  );
  logonCommands.push(...(o.firstLogonCommands ?? []));

  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <SetupUILanguage><UILanguage>${locale}</UILanguage></SetupUILanguage>
      <InputLocale>${locale}</InputLocale>
      <SystemLocale>${locale}</SystemLocale>
      <UILanguage>${locale}</UILanguage>
      <UserLocale>${locale}</UserLocale>
    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">${
      o.bypassHardwareChecks ? hardwareBypass() : ""
    }${disk}
      <UserData>
        <AcceptEula>true</AcceptEula>
        <FullName>${user}</FullName>
        <Organization></Organization>
        ${
          effectiveKey
            ? `<ProductKey><Key>${xmlEscape(effectiveKey)}</Key><WillShowUI>OnError</WillShowUI></ProductKey>`
            : `<ProductKey><WillShowUI>OnError</WillShowUI></ProductKey>`
        }
      </UserData>
    </component>
  </settings>

  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <ComputerName>${xmlEscape(o.computerName)}</ComputerName>
      <TimeZone>${xmlEscape(tz)}</TimeZone>
    </component>
    <component name="Microsoft-Windows-TerminalServices-LocalSessionManager" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <fDenyTSConnections>false</fDenyTSConnections>
    </component>
  </settings>

  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <InputLocale>${locale}</InputLocale>
      <SystemLocale>${locale}</SystemLocale>
      <UILanguage>${locale}</UILanguage>
      <UserLocale>${locale}</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <NetworkLocation>Work</NetworkLocation>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <!--
          Windows Server's OOBE stops on "Customize settings" demanding a
          password for the built-in Administrator, even when a LocalAccount and
          AutoLogon are supplied — observed on Server 2019, which sat at that
          screen until it was typed in by hand. Client Windows does not ask, but
          setting it is harmless there, so it is always emitted.
        -->
        <AdministratorPassword><Value>${pass}</Value><PlainText>true</PlainText></AdministratorPassword>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>${user}</Name>
            <DisplayName>${user}</DisplayName>
            <Group>Administrators</Group>
            <Password><Value>${pass}</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled>
        <Username>${user}</Username>
        <LogonCount>5</LogonCount>
        <Password><Value>${pass}</Value><PlainText>true</PlainText></Password>
      </AutoLogon>
      <FirstLogonCommands>
        ${logonCommands
          .map(
            (c, i) => `<SynchronousCommand wcm:action="add">
          <Order>${i + 1}</Order>
          <CommandLine>${xmlEscape(c)}</CommandLine>
          <RequiresUserInput>false</RequiresUserInput>
        </SynchronousCommand>`,
          )
          .join("\n        ")}
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;
}
