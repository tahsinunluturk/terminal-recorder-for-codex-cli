"use strict";

const assert = require("node:assert/strict");
const {TerminalRenderer} = require("./terminal_render.js");

function render(...chunks) {
  const terminal = new TerminalRenderer();
  for (const chunk of chunks) terminal.write(chunk);
  return terminal.toString();
}

assert.equal(render("$ pwd\r\n/home/demo\r\n"), "$ pwd\n/home/demo\n");
assert.equal(render("one\n", "two\n"), "one\ntwo\n");
assert.equal(render("old text", "\rnew"), "new text");
assert.equal(render("abc\bX"), "abX");
assert.equal(render("a\tb"), "a       b");
assert.equal(render("123456\r", "a\x1b[K\n"), "a\n");
assert.equal(render("\x1b[2K", "ok"), "ok");
assert.equal(render("red \x1b[31", "mtext\x1b[0m"), "red text");
assert.match(render("before \x1b]8;;https://example.invalid\x07after"), /before ⟦ESC\]8;;https:\/\/example\.invalidBEL⟧after/);
assert.match(render("x\x1b[2Jz"), /x⟦ESC\[2J⟧z/);
assert.match(render("x\x00\u202ez"), /x⟦\\x00⟧⟦\\u202e⟧z/);

const partial = new TerminalRenderer();
partial.write("status\x1b[3");
assert.match(partial.toString(), /status⟦ESC\[3 \(eksik\)⟧/);
partial.write("1m ok");
assert.equal(partial.toString(), "status ok");
assert.equal(partial.toString(), "status ok", "snapshot must not mutate state");

const oversized = new TerminalRenderer();
oversized.write("\x1b]" + "x".repeat(5000));
assert.match(oversized.toString(), /\(eksik\)/, "unterminated controls must remain visible");
assert.match(oversized.toString(), /x{20}/, "ordinary text after a bounded control remains visible");

console.log("Terminal renderer checks passed");
