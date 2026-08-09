import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBootCommand, charToKey, KEYSYM, NAMED_KEYS } from "../src/keymap.js";

test("plain text becomes one keystroke per character", () => {
  const steps = parseBootCommand("abc");
  assert.equal(steps.length, 3);
  assert.deepEqual(
    steps.map((s) => (s.kind === "key" ? s.keysym : null)),
    [0x61, 0x62, 0x63],
  );
});

test("uppercase and shifted symbols carry Shift_L", () => {
  const [upper] = parseBootCommand("A");
  assert.equal(upper.kind, "key");
  if (upper.kind === "key") {
    assert.equal(upper.keysym, 0x41);
    assert.deepEqual(upper.modifiers, [KEYSYM.Shift_L]);
  }
  const [bang] = parseBootCommand("!");
  if (bang.kind === "key") assert.deepEqual(bang.modifiers, [KEYSYM.Shift_L]);
});

test("unshifted characters carry no modifier", () => {
  for (const ch of ["a", "1", "-", "/", "."]) {
    const [s] = parseBootCommand(ch);
    if (s.kind === "key") assert.deepEqual(s.modifiers, [], `${ch} should need no modifier`);
  }
});

test("named keys resolve to their keysyms", () => {
  for (const [token, expected] of [
    ["<enter>", KEYSYM.Return],
    ["<esc>", KEYSYM.Escape],
    ["<tab>", KEYSYM.Tab],
    ["<down>", KEYSYM.Down],
    ["<f10>", NAMED_KEYS.f10],
  ] as const) {
    const [s] = parseBootCommand(token);
    assert.equal(s.kind, "key");
    if (s.kind === "key") assert.equal(s.keysym, expected, `${token}`);
  }
});

test("function keys are contiguous from F1", () => {
  assert.equal(NAMED_KEYS.f1, 0xffbe);
  assert.equal(NAMED_KEYS.f12, 0xffbe + 11);
});

test("modifier combinations parse", () => {
  const [s] = parseBootCommand("<ctrl-alt-delete>");
  assert.equal(s.kind, "key");
  if (s.kind === "key") {
    assert.equal(s.keysym, KEYSYM.Delete);
    assert.deepEqual(s.modifiers, [KEYSYM.Control_L, KEYSYM.Alt_L]);
  }
});

test("wait tokens produce the right durations", () => {
  const cases: Array<[string, number]> = [
    ["<wait>", 1000],
    ["<wait5>", 5000],
    ["<wait500ms>", 500],
    ["<wait2s>", 2000],
  ];
  for (const [token, ms] of cases) {
    const [s] = parseBootCommand(token);
    assert.equal(s.kind, "wait");
    if (s.kind === "wait") assert.equal(s.ms, ms, token);
  }
});

test("a real boot command parses end to end", () => {
  // The exact command that provisions Debian and Kali.
  const steps = parseBootCommand("<esc><wait2>auto locale=en_US keymap=us url=http://1.2.3.4:8080/p<enter>");
  assert.equal(steps[0].kind, "key");
  assert.equal(steps[1].kind, "wait");
  assert.equal(steps.at(-1)?.kind, "key");
  const typed = steps
    .filter((s) => s.kind === "key" && s.label.length === 1)
    .map((s) => (s.kind === "key" ? s.label : ""))
    .join("");
  assert.equal(typed, "auto locale=en_US keymap=us url=http://1.2.3.4:8080/p");
});

test("unterminated and unknown tokens throw rather than half-typing", () => {
  // A boot command that silently drops part of itself is worse than one that refuses.
  assert.throws(() => parseBootCommand("<enter"), /Unterminated/);
  assert.throws(() => parseBootCommand("<nosuchkey>"), /Unknown key/);
  assert.throws(() => parseBootCommand("<hyper-a>"), /Unknown modifier/);
});

test("unmappable characters are rejected", () => {
  assert.throws(() => parseBootCommand("中"), /cannot be typed/);
});

test("charToKey handles newline and tab as their named keys", () => {
  assert.equal(charToKey("\n")?.keysym, KEYSYM.Return);
  assert.equal(charToKey("\t")?.keysym, KEYSYM.Tab);
});
