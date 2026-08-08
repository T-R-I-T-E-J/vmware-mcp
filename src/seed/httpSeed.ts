import http from "node:http";
import { hostGatewayIp } from "../tools/network.js";

/**
 * A short-lived HTTP server that hands a preseed file to a Debian/Kali installer.
 *
 * The Debian installer's `preseed/file=` only reliably reads from the install
 * medium itself, and the installer disc already owns /cdrom — so serving the
 * preseed over HTTP and passing `auto url=...` is the approach that actually
 * works. It is also what Packer does.
 *
 * The server binds to the host's address on the VM's virtual network only, never
 * 0.0.0.0, so the answer file is not exposed to the physical LAN.
 */
export interface SeedServer {
  url: string;
  hostIp: string;
  port: number;
  /** Resolves once the installer has fetched the file. */
  waitForFetch: (timeoutMs: number) => Promise<boolean>;
  fetchCount: () => number;
  close: () => void;
}

export async function startSeedServer(
  files: Record<string, string>,
  opts: { hostNetwork?: string; port?: number } = {},
): Promise<SeedServer> {
  const hostIp = await hostGatewayIp(opts.hostNetwork ?? "vmnet8");
  if (!hostIp) {
    throw new Error(
      `Could not determine the host's address on ${opts.hostNetwork ?? "vmnet8"}. Is the VMware NAT network configured?`,
    );
  }

  let fetches = 0;
  const fetchWaiters: Array<() => void> = [];

  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0].replace(/^\/+/, ""));
    const body = files[name];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    fetches++;
    while (fetchWaiters.length) fetchWaiters.shift()!();
  });

  // Every character of the seed URL has to be typed at a bootloader prompt that
  // drops keys under load, so prefer a short, fixed port over an ephemeral
  // five-digit one: ":8080" is four keystrokes fewer than ":59457", and paired
  // with the "/p" alias it cuts the boot command by a third.
  const candidates = opts.port ? [opts.port] : [8080, 8000, 8888, 0];
  let port = 0;
  let lastErr: Error | null = null;
  for (const candidate of candidates) {
    try {
      port = await new Promise<number>((resolve, reject) => {
        const onError = (e: Error) => reject(e);
        server.once("error", onError);
        server.listen(candidate, hostIp, () => {
          server.removeListener("error", onError);
          const addr = server.address();
          if (addr && typeof addr === "object") resolve(addr.port);
          else reject(new Error("Seed server did not bind to a port."));
        });
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e as Error;
    }
  }
  if (lastErr) throw new Error(`Could not bind the seed server on ${hostIp}: ${lastErr.message}`);

  return {
    url: `http://${hostIp}:${port}`,
    hostIp,
    port,
    fetchCount: () => fetches,
    waitForFetch: (timeoutMs) =>
      new Promise<boolean>((resolve) => {
        if (fetches > 0) return resolve(true);
        const timer = setTimeout(() => resolve(false), timeoutMs);
        fetchWaiters.push(() => {
          clearTimeout(timer);
          resolve(true);
        });
      }),
    close: () => server.close(),
  };
}
