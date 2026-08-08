import { execFile } from "node:child_process";
import { loadConfig } from "./config.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
    readonly redactedCommand: string,
  ) {
    super(message);
    this.name = "ExecError";
  }
}

/**
 * vmrun takes the guest password as a bare argv value (-gp <password>). Anything
 * that renders an argv list for a human — error messages, logs — must go through
 * here first. Also covers -p (encrypted VM password) and -gu, which is less
 * sensitive but still identifying.
 */
const SECRET_FLAGS = new Set(["-gp", "-p", "-vp"]);

export function redactArgv(argv: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    out.push(quoteForDisplay(a));
    if (SECRET_FLAGS.has(a) && i + 1 < argv.length) {
      out.push("***");
      i++;
    }
  }
  return out.join(" ");
}

function quoteForDisplay(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Non-zero exit is returned rather than thrown. Some vmrun probes use exit code as data. */
  allowFailure?: boolean;
  /** Guard against a runaway guest command dumping gigabytes into memory. */
  maxBufferBytes?: number;
}

/**
 * The single place this server spawns a process. `execFile` with an argv array and
 * no shell, so guest command strings and file paths can never be reinterpreted as
 * shell syntax — important when the arguments come from a model.
 */
export function run(file: string, argv: string[], opts: RunOptions = {}): Promise<ExecResult> {
  const cfg = loadConfig();
  const timeout = opts.timeoutMs ?? cfg.execTimeoutMs;
  const maxBuffer = Math.max(1024, opts.maxBufferBytes ?? 16 * 1024 * 1024);

  return new Promise((resolve, reject) => {
    execFile(
      file,
      argv,
      { timeout, maxBuffer, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        let exitCode = 0;
        if (err) {
          // execFile sets err.code for launch errors (ENOENT, etc.), and
          // err.signal for processes killed by signal. For non-zero exits,
          // the exit code lives on err itself, not err.code.
          const e = err as NodeJS.ErrnoException & { signal?: string; status?: number };
          if (e.status !== undefined && e.status !== null) {
            exitCode = e.status;
          } else if (typeof e.code === "number") {
            exitCode = e.code;
          } else if (e.signal) {
            exitCode = 128 + (typeof e.signal === "string" && e.signal.startsWith("SIG") ? 0 : 0) + 1;
          } else {
            exitCode = 1;
          }
        }

        const result: ExecResult = {
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: exitCode,
        };
        const shown = `${quoteForDisplay(file)} ${redactArgv(argv)}`;

        if (!err || opts.allowFailure) {
          resolve(result);
          return;
        }
        if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT" || (err as { killed?: boolean }).killed) {
          reject(
            new ExecError(`Timed out after ${timeout}ms: ${shown}`, result, shown),
          );
          return;
        }
        // maxBuffer exceeded: output was truncated. Include what we captured.
        if ((err as NodeJS.ErrnoException).code === "ENOBUFS") {
          reject(
            new ExecError(
              `Output exceeded ${maxBuffer} bytes (maxBuffer): ${shown}`,
              result,
              shown,
            ),
          );
          return;
        }
        const detail = (result.stderr || result.stdout).trim().split("\n")[0] || err.message;
        reject(new ExecError(`${shown} failed: ${detail}`, result, shown));
      },
    );
  });
}
