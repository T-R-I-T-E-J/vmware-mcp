import { describe, it, expect } from "vitest";
import { parseBootCommand, charToKey, NAMED_KEYS, KEYSYM, type BootStep } from "./keymap.js";

describe("charToKey", () => {
  it("maps lowercase letters to their ASCII keysym with no modifiers", () => {
    const k = charToKey("a");
    expect(k).not.toBeNull();
    expect(k!.keysym).toBe(0x61);
    expect(k!.modifiers).toEqual([]);
  });

  it("maps uppercase letters with Shift modifier", () => {
    const k = charToKey("A");
    expect(k).not.toBeNull();
    expect(k!.keysym).toBe(0x41);
    expect(k!.modifiers).toContain(KEYSYM.Shift_L);
  });

  it("maps digits directly", () => {
    const k = charToKey("5");
    expect(k).not.toBeNull();
    expect(k!.keysym).toBe(0x35);
  });

  it("maps newline to Return", () => {
    const k = charToKey("\n");
    expect(k).not.toBeNull();
    expect(k!.keysym).toBe(KEYSYM.Return);
  });

  it("maps tab to Tab", () => {
    const k = charToKey("\t");
    expect(k).not.toBeNull();
    expect(k!.keysym).toBe(KEYSYM.Tab);
  });

  it("maps symbols needing Shift", () => {
    const k = charToKey("!");
    expect(k).not.toBeNull();
    expect(k!.modifiers).toContain(KEYSYM.Shift_L);
  });

  it("returns null for non-ASCII characters outside Latin-1", () => {
    const k = charToKey("\u0100");
    expect(k).toBeNull();
  });
});

describe("NAMED_KEYS", () => {
  it("maps enter to Return", () => {
    expect(NAMED_KEYS.enter).toBe(KEYSYM.Return);
  });

  it("maps esc to Escape", () => {
    expect(NAMED_KEYS.esc).toBe(KEYSYM.Escape);
  });

  it("maps arrow keys correctly", () => {
    expect(NAMED_KEYS.left).toBe(KEYSYM.Left);
    expect(NAMED_KEYS.right).toBe(KEYSYM.Right);
    expect(NAMED_KEYS.up).toBe(KEYSYM.Up);
    expect(NAMED_KEYS.down).toBe(KEYSYM.Down);
  });

  it("maps F1 through F12", () => {
    for (let i = 1; i <= 12; i++) {
      expect(NAMED_KEYS[`f${i}`]).toBe(0xffbd + i);
    }
  });

  it("maps spacebar to 0x20", () => {
    expect(NAMED_KEYS.spacebar).toBe(0x20);
    expect(NAMED_KEYS.space).toBe(0x20);
  });

  it("maps modifier key names to keysyms", () => {
    expect(NAMED_KEYS.leftshift).toBe(KEYSYM.Shift_L);
    expect(NAMED_KEYS.leftctrl).toBe(KEYSYM.Control_L);
    expect(NAMED_KEYS.leftalt).toBe(KEYSYM.Alt_L);
  });
});

describe("parseBootCommand", () => {
  it("parses plain text into individual key steps", () => {
    const steps = parseBootCommand("abc");
    expect(steps).toHaveLength(3);
    expect(steps[0].kind).toBe("key");
    expect((steps[0] as { kind: "key"; keysym: number }).keysym).toBe(0x61);
  });

  it("parses named keys in angle brackets", () => {
    const steps = parseBootCommand("<enter>");
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("key");
    expect((steps[0] as { kind: "key"; keysym: number }).keysym).toBe(KEYSYM.Return);
  });

  it("parses function keys", () => {
    const steps = parseBootCommand("<f2>");
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("key");
    expect((steps[0] as { kind: "key"; keysym: number }).keysym).toBe(NAMED_KEYS.f2);
  });

  it("parses modifier combinations like <ctrl-c>", () => {
    const steps = parseBootCommand("<ctrl-c>");
    expect(steps).toHaveLength(1);
    const step = steps[0] as { kind: "key"; keysym: number; modifiers: number[] };
    expect(step.kind).toBe("key");
    expect(step.modifiers).toContain(KEYSYM.Control_L);
  });

  it("parses <alt-f2> correctly", () => {
    const steps = parseBootCommand("<alt-f2>");
    const step = steps[0] as { kind: "key"; keysym: number; modifiers: number[] };
    expect(step.modifiers).toContain(KEYSYM.Alt_L);
    expect(step.keysym).toBe(NAMED_KEYS.f2);
  });

  it("parses wait tokens", () => {
    const steps = parseBootCommand("<wait>");
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("wait");
    expect((steps[0] as { kind: "wait"; ms: number }).ms).toBe(1000);
  });

  it("parses <wait5> as 5 seconds", () => {
    const steps = parseBootCommand("<wait5>");
    expect(steps[0].kind).toBe("wait");
    expect((steps[0] as { kind: "wait"; ms: number }).ms).toBe(5000);
  });

  it("parses <wait500ms> correctly", () => {
    const steps = parseBootCommand("<wait500ms>");
    expect(steps[0].kind).toBe("wait");
    expect((steps[0] as { kind: "wait"; ms: number }).ms).toBe(500);
  });

  it("parses a complete Debian boot command", () => {
    const cmd = '<esc><wait2>auto url=http://192.168.119.1:8080/p<enter>';
    const steps = parseBootCommand(cmd);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].kind).toBe("key");
    const firstKey = steps[0] as { kind: "key"; label: string };
    expect(firstKey.label).toBe("<esc>");
  });

  it("parses the Ubuntu GRUB sequence", () => {
    const cmd = '<wait2><e><wait2><down><down><down><end> autoinstall<wait1><f10>';
    const steps = parseBootCommand(cmd);
    expect(steps.length).toBeGreaterThan(0);
    const f10 = steps[steps.length - 1] as { kind: "key"; keysym: number };
    expect(f10.keysym).toBe(NAMED_KEYS.f10);
  });

  it("throws on unterminated angle bracket", () => {
    expect(() => parseBootCommand('<esc')).toThrow('Unterminated');
  });

  it("throws on unknown key token", () => {
    expect(() => parseBootCommand('<nonexistent>')).toThrow('Unknown key');
  });

  it("throws on unknown modifier", () => {
    expect(() => parseBootCommand('<bogus-c>')).toThrow('Unknown modifier');
  });

  it("parses <ctrl-alt-del> with multiple modifiers", () => {
    const steps = parseBootCommand("<ctrl-alt-del>");
    const step = steps[0] as { kind: "key"; keysym: number; modifiers: number[] };
    expect(step.modifiers).toContain(KEYSYM.Control_L);
    expect(step.modifiers).toContain(KEYSYM.Alt_L);
    expect(step.keysym).toBe(KEYSYM.Delete);
  });

  it("handles single-character named keys in angle brackets", () => {
    const steps = parseBootCommand("<a>");
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("key");
    expect((steps[0] as { kind: "key"; keysym: number }).keysym).toBe(0x61);
  });

  it("preserves step ordering correctly", () => {
    const cmd = "abc<enter>def";
    const steps = parseBootCommand(cmd);
    expect(steps).toHaveLength(7);
    const kinds = steps.map((s: BootStep) => s.kind);
    expect(kinds.every((k: string) => k === "key")).toBe(true);
  });

  it("throws on non-US-keyboard character", () => {
    // em dash is not printable on a US layout
    expect(() => parseBootCommand("\u2014")).toThrow("cannot be typed");
  });

  it("handles multi-character text between named keys", () => {
    const steps = parseBootCommand("auto url=http://host/p<enter>");
    const kinds = steps.map((s: BootStep) => s.kind);
    expect(kinds.filter((k) => k === "key").length).toBeGreaterThan(0);
    const last = steps[steps.length - 1];
    expect(last.kind).toBe("key");
  });

  it("parses <gui-r> as Super modifier", () => {
    const steps = parseBootCommand("<gui-r>");
    const step = steps[0] as { kind: "key"; keysym: number; modifiers: number[] };
    expect(step.modifiers).toContain(KEYSYM.Super_L);
  });

  it("parses <win-r> and <super-r> as Super modifier", () => {
    const s1 = parseBootCommand("<win-r>")[0] as { kind: "key"; modifiers: number[] };
    const s2 = parseBootCommand("<super-r>")[0] as { kind: "key"; modifiers: number[] };
    expect(s1.modifiers).toContain(KEYSYM.Super_L);
    expect(s2.modifiers).toContain(KEYSYM.Super_L);
  });

  it("handles numeric keys with shift for symbols", () => {
    const steps = parseBootCommand("1");
    const step = steps[0] as { kind: "key"; keysym: number; modifiers: number[] };
    expect(step.keysym).toBe(0x31);
    expect(step.modifiers).toEqual([]);
  });

  it("handles empty boot command", () => {
    const steps = parseBootCommand("");
    expect(steps).toHaveLength(0);
  });
});
