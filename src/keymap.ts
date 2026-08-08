/**
 * X11 keysyms, as required by the RFB (VNC) KeyEvent message.
 *
 * We drive the guest keyboard over VNC rather than through `vmcli MKS
 * sendKeyEvent`, which accepts its arguments and silently does nothing on
 * Workstation 17.6.2 — verified against a live Debian installer boot menu, where
 * the selection never moved and no error was reported. VNC input is documented
 * (RFC 6143) and observably works.
 */

export const KEYSYM = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
  Menu: 0xff67,
  Delete: 0xffff,
  Shift_L: 0xffe1,
  Control_L: 0xffe3,
  Alt_L: 0xffe9,
  Super_L: 0xffeb,
  Caps_Lock: 0xffe5,
  Print: 0xff61,
  Scroll_Lock: 0xff14,
  Pause: 0xff13,
} as const;

/** Named keys usable in a boot command as <enter>, <f2>, <down>, … */
export const NAMED_KEYS: Record<string, number> = {
  enter: KEYSYM.Return,
  return: KEYSYM.Return,
  esc: KEYSYM.Escape,
  escape: KEYSYM.Escape,
  backspace: KEYSYM.BackSpace,
  bs: KEYSYM.BackSpace,
  tab: KEYSYM.Tab,
  space: 0x20,
  spacebar: 0x20,
  capslock: KEYSYM.Caps_Lock,
  insert: KEYSYM.Insert,
  home: KEYSYM.Home,
  end: KEYSYM.End,
  pageup: KEYSYM.PageUp,
  pagedown: KEYSYM.PageDown,
  delete: KEYSYM.Delete,
  del: KEYSYM.Delete,
  left: KEYSYM.Left,
  right: KEYSYM.Right,
  up: KEYSYM.Up,
  down: KEYSYM.Down,
  menu: KEYSYM.Menu,
  printscreen: KEYSYM.Print,
  scrolllock: KEYSYM.Scroll_Lock,
  pause: KEYSYM.Pause,
  leftshift: KEYSYM.Shift_L,
  leftctrl: KEYSYM.Control_L,
  leftalt: KEYSYM.Alt_L,
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`f${i}`] = 0xffbd + i; // F1 = 0xFFBE

/** Characters that require Shift on a US layout. */
const NEEDS_SHIFT = new Set('~!@#$%^&*()_+{}|:"<>?'.split(""));

export interface KeyPress {
  keysym: number;
  /** Modifier keysyms to hold down while this key is pressed. */
  modifiers: number[];
}

/** Map one printable character to a keysym plus any modifiers to hold. */
export function charToKey(ch: string): KeyPress | null {
  if (ch === "\n") return { keysym: KEYSYM.Return, modifiers: [] };
  if (ch === "\t") return { keysym: KEYSYM.Tab, modifiers: [] };
  const code = ch.codePointAt(0);
  if (code === undefined) return null;

  // Printable ASCII maps directly onto its own keysym value.
  if (code >= 0x20 && code <= 0x7e) {
    const needsShift = NEEDS_SHIFT.has(ch) || (ch >= "A" && ch <= "Z");
    return { keysym: code, modifiers: needsShift ? [KEYSYM.Shift_L] : [] };
  }
  // Latin-1 also maps directly.
  if (code >= 0xa0 && code <= 0xff) return { keysym: code, modifiers: [] };
  return null;
}

export type BootStep =
  | { kind: "key"; keysym: number; modifiers: number[]; label: string }
  | { kind: "wait"; ms: number };

/**
 * Parse a Packer-style boot command.
 *
 *   plain text            typed literally
 *   <enter> <tab> <esc>   named keys
 *   <f2> … <f12>          function keys
 *   <ctrl-c> <alt-f2>     modifier combinations
 *   <wait> <wait5>        pause 1s / 5s; <wait500ms> for milliseconds
 *
 * Unrecognized tokens throw. A boot command that half-types is worse than one
 * that refuses to run at all.
 */
export function parseBootCommand(command: string): BootStep[] {
  const steps: BootStep[] = [];
  let i = 0;

  while (i < command.length) {
    if (command[i] === "<") {
      const close = command.indexOf(">", i);
      if (close < 0) throw new Error(`Unterminated "<" at offset ${i} in boot command.`);
      const token = command.slice(i + 1, close).toLowerCase();
      i = close + 1;

      const wait = /^wait(?:(\d+)(ms|s)?)?$/.exec(token);
      if (wait) {
        const n = wait[1] ? Number(wait[1]) : 1;
        steps.push({ kind: "wait", ms: wait[2] === "ms" ? n : n * 1000 });
        continue;
      }

      const parts = token.split("-");
      const keyName = parts.pop() ?? "";
      const modifiers: number[] = [];
      for (const p of parts) {
        if (p === "ctrl") modifiers.push(KEYSYM.Control_L);
        else if (p === "shift") modifiers.push(KEYSYM.Shift_L);
        else if (p === "alt") modifiers.push(KEYSYM.Alt_L);
        else if (p === "gui" || p === "win" || p === "super") modifiers.push(KEYSYM.Super_L);
        else throw new Error(`Unknown modifier "${p}" in <${token}>.`);
      }

      let keysym = NAMED_KEYS[keyName];
      if (keysym === undefined && keyName.length === 1) {
        const k = charToKey(keyName);
        if (k) {
          keysym = k.keysym;
          modifiers.push(...k.modifiers);
        }
      }
      if (keysym === undefined) throw new Error(`Unknown key "<${token}>" in boot command.`);
      steps.push({ kind: "key", keysym, modifiers, label: `<${token}>` });
      continue;
    }

    const ch = command[i++];
    const k = charToKey(ch);
    if (!k) throw new Error(`Character ${JSON.stringify(ch)} cannot be typed on a US keyboard layout.`);
    steps.push({ kind: "key", keysym: k.keysym, modifiers: k.modifiers, label: ch });
  }

  return steps;
}
