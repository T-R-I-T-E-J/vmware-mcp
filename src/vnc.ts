import net from "node:net";
import crypto from "node:crypto";
import type { BootStep } from "./keymap.js";

/**
 * A minimal RFB 3.8 client, just enough to send KeyEvent and PointerEvent
 * messages to a VMware Workstation VM's built-in VNC server (RFC 6143).
 *
 * This exists because `vmcli MKS sendKeyEvent` is a silent no-op on Workstation
 * 17.6.2. Typing at a bootloader menu is the only way to pass kernel arguments
 * to a Linux installer without remastering a multi-gigabyte ISO, so a working
 * keyboard path is load-bearing for unattended provisioning.
 *
 * Only what we need is implemented: no framebuffer decoding, no encodings
 * negotiation beyond the handshake.
 */

const MSG_KEY_EVENT = 4;
const MSG_POINTER_EVENT = 5;

const SEC_NONE = 1;
const SEC_VNC_AUTH = 2;

export interface VncOptions {
  host?: string;
  port: number;
  password?: string;
  connectTimeoutMs?: number;
}

export class VncClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private waiters: Array<{ need: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }> = [];
  width = 0;
  height = 0;
  name = "";

  constructor(private readonly opts: VncOptions) {}

  private onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.waiters.length > 0 && this.buffer.length >= this.waiters[0].need) {
      const w = this.waiters.shift()!;
      const out = this.buffer.subarray(0, w.need);
      this.buffer = this.buffer.subarray(w.need);
      w.resolve(out);
    }
  };

  private read(need: number, timeoutMs = 10_000): Promise<Buffer> {
    if (this.buffer.length >= need) {
      const out = this.buffer.subarray(0, need);
      this.buffer = this.buffer.subarray(need);
      return Promise.resolve(out);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x.resolve !== wrapped);
        reject(new Error(`VNC read timed out waiting for ${need} bytes`));
      }, timeoutMs);
      const wrapped = (b: Buffer) => {
        clearTimeout(timer);
        resolve(b);
      };
      this.waiters.push({ need, resolve: wrapped, reject });
    });
  }

  private write(b: Buffer): void {
    if (!this.socket) throw new Error("VNC socket is not connected");
    this.socket.write(b, (err) => {
      if (err && this.socket) {
        this.socket.destroy();
        this.socket = null;
      }
    });
  }

  async connect(): Promise<void> {
    const host = this.opts.host ?? "127.0.0.1";
    const timeout = this.opts.connectTimeoutMs ?? 10_000;

    this.socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host, port: this.opts.port });
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error(`Timed out connecting to VNC at ${host}:${this.opts.port}`));
      }, timeout);
      s.once("connect", () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(t);
        reject(
          new Error(
            `Could not connect to the VM's VNC server at ${host}:${this.opts.port} (${e.message}). Enable VNC on the VM with enable_console_input.`,
          ),
        );
      });
    });
    this.socket.on("data", this.onData);
    this.socket.on("error", () => {
      for (const w of this.waiters) w.reject(new Error("VNC socket error"));
      this.waiters = [];
    });

    // ---- ProtocolVersion handshake
    const version = (await this.read(12)).toString("ascii");
    if (!/^RFB \d{3}\.\d{3}\n$/.test(version)) {
      throw new Error(`Unexpected VNC greeting: ${JSON.stringify(version)}`);
    }
    this.write(Buffer.from("RFB 003.008\n", "ascii"));

    // ---- Security handshake
    const nTypes = (await this.read(1)).readUInt8(0);
    if (nTypes === 0) {
      const len = (await this.read(4)).readUInt32BE(0);
      const reason = (await this.read(len)).toString("utf8");
      throw new Error(`VNC server rejected the connection: ${reason}`);
    }
    const types = [...(await this.read(nTypes))];

    if (types.includes(SEC_NONE) && !this.opts.password) {
      this.write(Buffer.from([SEC_NONE]));
    } else if (types.includes(SEC_VNC_AUTH)) {
      if (!this.opts.password) {
        throw new Error("This VM's VNC server requires a password; none was configured.");
      }
      this.write(Buffer.from([SEC_VNC_AUTH]));
      const challenge = await this.read(16);
      this.write(vncAuthResponse(challenge, this.opts.password));
    } else {
      throw new Error(`No supported VNC security type on offer (server sent: ${types.join(", ")}).`);
    }

    const secResult = (await this.read(4)).readUInt32BE(0);
    if (secResult !== 0) {
      let reason = "authentication failed";
      try {
        const len = (await this.read(4, 2000)).readUInt32BE(0);
        reason = (await this.read(len, 2000)).toString("utf8");
      } catch {
        /* RFB 3.3 servers omit the reason string */
      }
      throw new Error(`VNC authentication failed: ${reason}`);
    }

    // ---- ClientInit: shared = 1, so we don't disconnect anyone else's console
    this.write(Buffer.from([1]));

    // ---- ServerInit
    const init = await this.read(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    const nameLen = init.readUInt32BE(20);
    // A malicious or broken VNC server could send a huge name length, causing OOM.
    // VMware's VNC server sends short names (the .vmx path), so 1024 is generous.
    if (nameLen > 1024) {
      throw new Error(`VNC server sent an implausible desktop name length (${nameLen}).`);
    }
    this.name = nameLen > 0 ? (await this.read(nameLen)).toString("utf8") : "";
  }

  keyEvent(keysym: number, down: boolean): void {
    const b = Buffer.alloc(8);
    b.writeUInt8(MSG_KEY_EVENT, 0);
    b.writeUInt8(down ? 1 : 0, 1);
    b.writeUInt16BE(0, 2);
    b.writeUInt32BE(keysym >>> 0, 4);
    this.write(b);
  }

  pointerEvent(x: number, y: number, buttonMask: number): void {
    const b = Buffer.alloc(6);
    b.writeUInt8(MSG_POINTER_EVENT, 0);
    b.writeUInt8(buttonMask & 0xff, 1);
    b.writeUInt16BE(x, 2);
    b.writeUInt16BE(y, 4);
    this.write(b);
  }

  close(): void {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
  }
}

/**
 * VNC's DES challenge-response. The password is truncated/padded to 8 bytes and
 * each byte's bits are reversed — a quirk of the original protocol, not a typo.
 */
function vncAuthResponse(challenge: Buffer, password: string): Buffer {
  const key = Buffer.alloc(8);
  Buffer.from(password, "ascii").copy(key, 0, 0, Math.min(8, password.length));
  for (let i = 0; i < 8; i++) {
    let b = key[i];
    let r = 0;
    for (let bit = 0; bit < 8; bit++) r |= ((b >> bit) & 1) << (7 - bit);
    key[i] = r;
  }
  const out = Buffer.alloc(16);
  for (const offset of [0, 8]) {
    const cipher = crypto.createCipheriv("des-ecb", key, null);
    cipher.setAutoPadding(false);
    Buffer.concat([cipher.update(challenge.subarray(offset, offset + 8)), cipher.final()]).copy(out, offset);
  }
  return out;
}

/**
 * Play a parsed boot command against a VM's VNC console.
 * Modifiers are pressed before and released after each key so combinations and
 * shifted characters behave the way a human typing them would.
 */
export async function playBootCommand(
  opts: VncOptions,
  steps: BootStep[],
  keyDelayMs = 60,
): Promise<{ keysSent: number; waitedMs: number }> {
  const client = new VncClient(opts);
  await client.connect();
  let keysSent = 0;
  let waitedMs = 0;
  try {
    for (const step of steps) {
      if (step.kind === "wait") {
        waitedMs += step.ms;
        await sleep(step.ms);
        continue;
      }
      for (const m of step.modifiers) client.keyEvent(m, true);
      if (step.modifiers.length) await sleep(20); // let the modifier register first
      client.keyEvent(step.keysym, true);
      // Bootloader prompts (isolinux, GRUB) poll the keyboard slowly and drop
      // keys held too briefly — especially on a loaded host. 40ms is the
      // shortest hold observed to survive a memory-starved host here.
      await sleep(40);
      client.keyEvent(step.keysym, false);
      for (const m of [...step.modifiers].reverse()) client.keyEvent(m, false);
      await sleep(10);
      keysSent++;
      if (keyDelayMs > 0) await sleep(keyDelayMs);
    }
    // Let the last writes drain before tearing the socket down.
    await sleep(150);
  } finally {
    client.close();
  }
  return { keysSent, waitedMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
