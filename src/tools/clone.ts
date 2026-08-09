import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { assertVmPathAllowed, resolveVmxByNameOrPath } from "../paths.js";
import * as vmrun from "../vmrun.js";
import { clearStaleLocks, findVmxInDir, parseVmx, patchVmx } from "../vmx.js";
import { getRecord, listRecords, updateRecord, upsertRecord } from "../registry.js";
import { runFleet } from "../fleet.js";
import { allocateVncPort } from "./screen.js";
import { osFamilyForGuestId } from "./lifecycle.js";
import { confirmArg, defineTool, json, requireConfirm, text, vmArg } from "./common.js";

/**
 * Give a clone its own identity.
 *
 * A linked clone starts as a byte-copy of its parent's .vmx, so without this
 * every clone would share the parent's display name, MAC address and VNC port —
 * meaning they collide on the network and `send_keys` could drive the wrong
 * machine. Clearing `ethernet*.address` lets VMware generate a fresh MAC.
 */
function reidentifyClone(vmxPath: string, name: string): number {
  const cfg = parseVmx(vmxPath);
  const changes: Record<string, string | null> = {
    displayName: name,
    "RemoteDisplay.vnc.enabled": "TRUE",
    "RemoteDisplay.vnc.port": String(allocateVncPort()),
    // A cloned UUID makes VMware prompt "moved or copied?" on first power-on,
    // which blocks an unattended start. Answering it up front keeps clones
    // hands-off, and taking a new UUID is the honest answer for a copy.
    "uuid.action": "create",
  };
  for (const key of cfg.keys()) {
    if (/^ethernet\d+\.(address|generatedaddress|generatedaddressoffset)$/.test(key)) {
      changes[key] = null;
    }
  }
  patchVmx(vmxPath, changes);
  return Number(parseVmx(vmxPath).get("remotedisplay.vnc.port"));
}

/**
 * True when a snapshot captured the VM's memory as well as its disk.
 *
 * `vmrun clone` refuses to branch from one of these, reporting the thoroughly
 * misleading "The virtual machine should not be powered on. It is already
 * running." — even with the VM off and no vmware-vmx process alive. A snapshot
 * taken while a VM was running carries its RAM in a sibling `.vmem`, which is
 * both the tell and the reason (it is a *live* machine state, not a disk state).
 */
function snapshotHasMemory(vmx: string, snapshotName: string): boolean {
  const vmDir = path.dirname(vmx);
  const vmsd = vmx.replace(/\.vmx$/i, ".vmsd");
  if (!fs.existsSync(vmsd)) return false;

  const entries = new Map<string, string>();
  for (const line of fs.readFileSync(vmsd, "utf8").split(/\r?\n/)) {
    const m = /^\s*([\w.]+)\s*=\s*"(.*)"\s*$/.exec(line);
    if (m) entries.set(m[1].toLowerCase(), m[2]);
  }
  for (const [key, value] of entries) {
    if (!/^snapshot\d+\.displayname$/.test(key) || value !== snapshotName) continue;
    const prefix = key.replace(/\.displayname$/, "");
    const vmsn = entries.get(`${prefix}.filename`);
    if (!vmsn) return false;
    return fs.existsSync(path.join(vmDir, vmsn.replace(/\.vmsn$/i, ".vmem")));
  }
  return false;
}

/**
 * Return a snapshot suitable to clone from, creating one if needed.
 *
 * The VM is already known to be powered off by this point, so any snapshot taken
 * here is disk-only and safe to branch from.
 */
async function ensureSnapshot(vmx: string, preferred: string): Promise<string> {
  const existing = (await vmrun.listSnapshots(vmx).catch(() => [] as string[]))
    .map((s) => s.trim())
    .filter(Boolean);

  const usable = existing.filter((s) => !snapshotHasMemory(vmx, s));
  if (usable.includes(preferred)) return preferred;
  if (usable.length > 0) return usable[usable.length - 1];

  // Either there are no snapshots, or every one of them carries memory state.
  const name = existing.includes(preferred) ? `${preferred}-offline` : preferred;
  await vmrun.snapshot(vmx, name);
  return name;
}

export interface CloneOptions {
  sourceVmx: string;
  newName: string;
  linked: boolean;
  snapshot?: string;
  tags: string[];
  credentialRef?: string;
}

export async function cloneVmCore(o: CloneOptions): Promise<{
  name: string;
  vmxPath: string;
  mode: "linked" | "full";
  snapshot?: string;
  vncPort: number;
  sizeMb: number;
}> {
  const cfg = loadConfig();
  const destDir = path.join(cfg.vmRoot, o.newName);
  assertVmPathAllowed(destDir);
  if (fs.existsSync(destDir)) throw new Error(`A VM directory already exists at ${destDir}.`);

  if (await vmrun.isRunning(o.sourceVmx)) {
    throw new Error(
      "The source VM is running. Power it off before cloning — cloning a live VM captures an inconsistent disk.",
    );
  }
  // Safe now that the VM is confirmed off: a harness killed mid-run leaves a
  // .lck behind, after which VMware insists the VM "is already running".
  clearStaleLocks(path.dirname(o.sourceVmx));

  // Linked clones must branch from a snapshot. Full clones do not, but taking
  // one is harmless and keeps both paths identical.
  const snapshot = o.linked ? await ensureSnapshot(o.sourceVmx, o.snapshot ?? "clean") : o.snapshot;

  const destVmx = path.join(destDir, `${o.newName}.vmx`);
  await vmrun.clone(o.sourceVmx, destVmx, o.linked ? "linked" : "full", {
    snapshot,
    cloneName: o.newName,
  });

  const vmxPath = fs.existsSync(destVmx) ? destVmx : findVmxInDir(destDir);
  if (!vmxPath) throw new Error(`vmrun clone did not produce a .vmx in ${destDir}.`);

  const vncPort = reidentifyClone(vmxPath, o.newName);

  const src = listRecords().find((r) => r.vmxPath.toLowerCase() === o.sourceVmx.toLowerCase());
  const guestOsId = src?.guestOsId ?? parseVmx(vmxPath).get("guestos") ?? "other";
  upsertRecord({
    name: o.newName,
    vmxPath,
    guestOsId,
    osFamily: osFamilyForGuestId(guestOsId),
    lifecycle: "ready", // a clone of a ready VM is itself ready
    tags: o.tags,
    credentialRef: o.credentialRef ?? src?.credentialRef,
  });

  let sizeMb = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { sizeMb += fs.statSync(full).size; } catch { /* transient */ } }
    }
  };
  walk(destDir);

  return {
    name: o.newName,
    vmxPath,
    mode: o.linked ? "linked" : "full",
    snapshot,
    vncPort,
    sizeMb: Math.round(sizeMb / 1048576),
  };
}

export function registerCloneTools(server: McpServer): void {
  defineTool(
    server,
    "clone_vm",
    {
      title: "Clone a VM",
      description:
        "Copy an existing VM into a new one. A linked clone shares the parent's disk and takes seconds and a few hundred MB; a full clone is independent but copies every gigabyte. The clone gets its own name, MAC address and console port, so it can run alongside its parent. The source must be powered off.",
      inputSchema: {
        ...vmArg,
        newName: z.string().min(1).describe("Name for the clone; becomes its folder under VM_ROOT"),
        linked: z
          .boolean()
          .default(true)
          .describe("Linked (fast, shares the parent's disk, parent must stay put) or full (independent)"),
        snapshot: z
          .string()
          .optional()
          .describe("Snapshot to branch from. Defaults to 'clean', created if the VM has no snapshot."),
        tags: z.array(z.string()).default([]),
        credentialRef: z.string().optional().describe("Defaults to the source VM's credential"),
      },
    },
    async (a) => {
      const sourceVmx = resolveVmxByNameOrPath(a.vm);
      const r = await cloneVmCore({
        sourceVmx,
        newName: a.newName,
        linked: a.linked,
        snapshot: a.snapshot,
        tags: a.tags,
        credentialRef: a.credentialRef,
      });
      return json({
        ...r,
        note:
          r.mode === "linked"
            ? "Linked clone: it depends on the parent VM's files, so deleting or moving the parent breaks it."
            : "Full clone: entirely independent of the source.",
      });
    },
  );

  defineTool(
    server,
    "fleet_clone",
    {
      title: "Clone one VM into many",
      description:
        "Build N copies of a VM in one call — the fast way to stand up a lab. Names are the prefix plus a number (lab-1, lab-2, …). Linked clones make this take seconds per VM rather than a full OS install each. The source must be powered off.",
      inputSchema: {
        ...vmArg,
        count: z.number().int().min(1).max(50),
        namePrefix: z.string().min(1).describe('e.g. "lab" produces lab-1, lab-2, …'),
        startIndex: z.number().int().min(0).default(1),
        linked: z.boolean().default(true),
        snapshot: z.string().optional(),
        tags: z.array(z.string()).default([]),
        maxConcurrency: z.number().int().min(1).max(8).default(2),
      },
    },
    async (a) => {
      const cfg = loadConfig();
      const sourceVmx = resolveVmxByNameOrPath(a.vm);
      if (await vmrun.isRunning(sourceVmx)) {
        throw new Error("The source VM is running. Power it off before cloning.");
      }

      // Create the snapshot once up front; N parallel clones racing to create
      // the same snapshot on the same parent would collide.
      const snapshot = a.linked ? await ensureSnapshot(sourceVmx, a.snapshot ?? "clean") : a.snapshot;

      const names = Array.from({ length: a.count }, (_, i) => `${a.namePrefix}-${a.startIndex + i}`);
      const taken = names.filter((n) => fs.existsSync(path.join(cfg.vmRoot, n)));
      if (taken.length) throw new Error(`These names already exist: ${taken.join(", ")}`);

      const summary = await runFleet(
        names,
        (n) => n,
        (n) => cloneVmCore({ sourceVmx, newName: n, linked: a.linked, snapshot, tags: a.tags }),
        a.maxConcurrency,
      );
      return json({ source: sourceVmx, snapshot, ...summary });
    },
  );

  defineTool(
    server,
    "mark_template",
    {
      title: "Mark a VM as a template",
      description:
        "Flag a VM as a template to clone from. Templates are excluded from fleet_start so a golden image is not powered on by accident, and clone_vm reports which template a VM came from.",
      inputSchema: {
        ...vmArg,
        isTemplate: z.boolean().default(true),
      },
    },
    async (a) => {
      const vmx = resolveVmxByNameOrPath(a.vm);
      const rec = listRecords().find((r) => r.vmxPath.toLowerCase() === vmx.toLowerCase());
      if (!rec) throw new Error(`${vmx} is not in the registry. Add it with register_vm first.`);

      const tags = new Set(rec.tags);
      if (a.isTemplate) tags.add("template");
      else tags.delete("template");
      const updated = updateRecord(rec.name, { tags: [...tags] });

      return json({
        name: rec.name,
        isTemplate: a.isTemplate,
        tags: updated?.tags ?? [],
        note: a.isTemplate
          ? "Excluded from fleet_start. Clone it with clone_vm or fleet_clone."
          : "No longer treated as a template.",
      });
    },
  );

  defineTool(
    server,
    "delete_clone_tree",
    {
      title: "Delete a template's clones",
      description:
        "Delete every linked clone made from a template, leaving the template itself. Use before deleting or moving a template, since linked clones break when their parent goes away. Requires confirm: true.",
      inputSchema: {
        namePrefix: z.string().min(1).describe("Delete VMs whose name starts with this"),
        ...confirmArg,
      },
      destructive: true,
    },
    async (a) => {
      const cfg = loadConfig();
      const victims = listRecords().filter(
        (r) => r.name.startsWith(a.namePrefix) && !r.tags.includes("template"),
      );
      requireConfirm(a.confirm, `deleting ${victims.length} VM(s) matching "${a.namePrefix}*"`);
      if (victims.length === 0) return text(`No non-template VMs match "${a.namePrefix}*".`);

      const summary = await runFleet(
        victims,
        (r) => r.name,
        async (r) => {
          const dir = path.dirname(r.vmxPath);
          const rel = path.relative(cfg.vmRoot, dir);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new Error(`refusing: ${dir} is outside VM_ROOT`);
          }
          if (await vmrun.isRunning(r.vmxPath)) await vmrun.stop(r.vmxPath, "hard").catch(() => undefined);
          await vmrun.deleteVM(r.vmxPath).catch(() => undefined);
          fs.rmSync(dir, { recursive: true, force: true });
          return { deleted: dir };
        },
        4,
      );
      return json(summary);
    },
  );
}
