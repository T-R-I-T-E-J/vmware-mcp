import crypto from "node:crypto";

/**
 * SHA-512 crypt(3), the `$6$` format used in /etc/shadow.
 *
 * Ubuntu's autoinstall and Debian's preseed both want a pre-hashed password, and
 * Node has no crypt(3) binding. Python's `crypt` module is Unix-only so it is
 * unavailable on this host, and shelling out to OpenSSL cannot produce `$6$`
 * either. So the algorithm is implemented here, per Ulrich Drepper's
 * specification, and checked against the spec's own test vectors in
 * `verifySelfTest()`.
 */

const B64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function sha512(...parts: Buffer[]): Buffer {
  const h = crypto.createHash("sha512");
  for (const p of parts) h.update(p);
  return h.digest();
}

/** crypt(3)'s custom base64: little-endian groups of three bytes, 6 bits at a time. */
function to64(v: number, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += B64[v & 0x3f];
    v >>>= 6;
  }
  return out;
}

function encodeDigest(d: Buffer): string {
  // The permutation below is part of the spec, not an arbitrary ordering.
  const order: Array<[number, number, number]> = [
    [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26],
    [6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32],
    [12, 33, 54], [34, 55, 13], [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38],
    [18, 39, 60], [40, 61, 19], [62, 20, 41],
  ];
  let out = "";
  for (const [a, b, c] of order) {
    out += to64((d[a] << 16) | (d[b] << 8) | d[c], 4);
  }
  out += to64(d[63], 2);
  return out;
}

export interface Sha512CryptOptions {
  /** Up to 16 characters. Random if omitted. */
  salt?: string;
  /** 1000–999_999_999. Omitted from the output when it is the 5000 default. */
  rounds?: number;
}

export function sha512Crypt(password: string, opts: Sha512CryptOptions = {}): string {
  const pw = Buffer.from(password, "utf8");
  const saltStr = (opts.salt ?? crypto.randomBytes(12).toString("base64").replace(/[+/=]/g, "."))
    .slice(0, 16);
  const salt = Buffer.from(saltStr, "utf8");

  const hasRounds = opts.rounds !== undefined;
  const rounds = Math.min(999_999_999, Math.max(1000, opts.rounds ?? 5000));

  // Digest B: password + salt + password
  const B = sha512(pw, salt, pw);

  // Digest A: password + salt + B repeated to the password's length, then a
  // bit-driven cascade over the password length.
  const aParts: Buffer[] = [pw, salt];
  for (let i = pw.length; i > 0; i -= 64) aParts.push(B.subarray(0, Math.min(64, i)));
  for (let i = pw.length; i > 0; i >>>= 1) {
    aParts.push(i & 1 ? B : pw);
  }
  const A = sha512(...aParts);

  // Sequence DP: the password repeated, hashed.
  const dpParts: Buffer[] = [];
  for (let i = 0; i < pw.length; i++) dpParts.push(pw);
  const DP = sha512(...dpParts);
  const P = Buffer.concat(
    Array.from({ length: Math.ceil(pw.length / 64) }, () => DP),
  ).subarray(0, pw.length);

  // Sequence DS: the salt repeated 16 + A[0] times, hashed.
  const dsParts: Buffer[] = [];
  for (let i = 0; i < 16 + A[0]; i++) dsParts.push(salt);
  const DS = sha512(...dsParts);
  const S = Buffer.concat(
    Array.from({ length: Math.ceil(salt.length / 64) }, () => DS),
  ).subarray(0, salt.length);

  // The stretching loop.
  let C = A;
  for (let i = 0; i < rounds; i++) {
    const parts: Buffer[] = [];
    parts.push(i & 1 ? P : C);
    if (i % 3 !== 0) parts.push(S);
    if (i % 7 !== 0) parts.push(P);
    parts.push(i & 1 ? C : P);
    C = sha512(...parts);
  }

  const prefix = hasRounds ? `$6$rounds=${rounds}$${saltStr}` : `$6$${saltStr}`;
  return `${prefix}$${encodeDigest(C)}`;
}

/**
 * Test vectors from the SHA-crypt specification. Called at startup of any code
 * path that generates a password hash — a silently wrong hash would produce a
 * VM nobody can log into, discovered only after a 20-minute install.
 */
export function verifySelfTest(): void {
  const cases: Array<[string, Sha512CryptOptions, string]> = [
    [
      "Hello world!",
      { salt: "saltstring" },
      "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1",
    ],
    [
      "Hello world!",
      { salt: "saltstringsaltstring", rounds: 10000 },
      "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.",
    ],
  ];
  for (const [pw, opts, expected] of cases) {
    const got = sha512Crypt(pw, opts);
    if (got !== expected) {
      throw new Error(`sha512Crypt self-test failed.\n  expected ${expected}\n  got      ${got}`);
    }
  }
}
