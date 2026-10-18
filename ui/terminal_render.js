"use strict";

// A deliberately small terminal *text projection*. The capture journal, not this
// overwritten screen view, is the byte-for-byte record. Never insert its result
// as HTML; callers must render it with textContent (or an equivalent text API).
(function () {
  const ESC = "\x1b";
  const BEL = "\x07";
  const MAX_CONTROL_LENGTH = 4096;

  function visibleControl(raw, incomplete = false) {
    let body = "";
    for (const ch of raw) {
      const code = ch.codePointAt(0);
      if (ch === ESC) body += "ESC";
      else if (ch === BEL) body += "BEL";
      else if (ch === "\n") body += "\\n";
      else if (ch === "\r") body += "\\r";
      else if (ch === "\t") body += "\\t";
      else if (code < 32 || (code >= 127 && code <= 159)) {
        body += code <= 255 ? "\\x" + code.toString(16).padStart(2, "0")
          : "\\u" + code.toString(16).padStart(4, "0");
      } else if (isBidiControl(code)) {
        body += "\\u" + code.toString(16).padStart(4, "0");
      } else body += ch;
    }
    return "⟦" + body + (incomplete ? " (eksik)" : "") + "⟧";
  }

  function isBidiControl(code) {
    return code === 0x200e || code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
  }

  class TerminalRenderer {
    constructor() {
      this.lines = [[]];
      this.column = 0;
      this.mode = "text";
      this.pending = "";
    }

    _line() {
      return this.lines[this.lines.length - 1];
    }

    _put(ch) {
      const line = this._line();
      while (line.length < this.column) line.push(" ");
      line[this.column] = ch;
      this.column += 1;
    }

    _putString(value) {
      for (const ch of value) this._put(ch);
    }

    _annotate(raw, incomplete = false) {
      this._putString(visibleControl(raw, incomplete));
      this.mode = "text";
      this.pending = "";
    }

    _checkControlLength() {
      if (this.pending.length >= MAX_CONTROL_LENGTH) this._annotate(this.pending, true);
    }

    _finishCsi() {
      const value = this.pending;
      // Graphics rendition changes appearance only. Dropping it cannot alter
      // the visible command/output text, and avoids running terminal escapes.
      if (/^\x1b\[[0-9;:]*m$/.test(value)) {
        this.mode = "text";
        this.pending = "";
        return;
      }
      const erase = /^\x1b\[(?:([012]))?K$/.exec(value);
      if (erase) {
        const line = this._line();
        const mode = erase[1] || "0";
        if (mode === "0") line.length = Math.min(line.length, this.column);
        else if (mode === "1") {
          for (let index = 0; index <= this.column && index < line.length; index += 1) line[index] = " ";
        } else line.length = 0;
        this.mode = "text";
        this.pending = "";
        return;
      }
      this._annotate(value);
    }

    _writeChar(ch) {
      if (this.mode === "text") {
        if (ch === ESC) {
          this.mode = "esc";
          this.pending = ch;
        } else if (ch === "\r") this.column = 0;
        else if (ch === "\n") {
          this.lines.push([]);
          this.column = 0;
        } else if (ch === "\b") this.column = Math.max(0, this.column - 1);
        else if (ch === "\t") {
          this.column += 8 - (this.column % 8);
          const line = this._line();
          while (line.length < this.column) line.push(" ");
        } else {
          const code = ch.codePointAt(0);
          if (code < 32 || (code >= 127 && code <= 159) || isBidiControl(code)) {
            this._putString(visibleControl(ch));
          } else this._put(ch);
        }
        return;
      }

      if (this.mode === "esc") {
        if (ch === ESC) {
          this._annotate(this.pending, true);
          this.mode = "esc";
          this.pending = ESC;
        } else if (ch === "[") {
          this.mode = "csi";
          this.pending += ch;
        } else if (ch === "]") {
          this.mode = "osc";
          this.pending += ch;
        } else if (ch === "P" || ch === "X" || ch === "^" || ch === "_") {
          this.mode = "string";
          this.pending += ch;
        } else {
          this._annotate(this.pending + ch);
        }
        return;
      }

      if (this.mode === "csi") {
        if (ch === ESC) {
          this._annotate(this.pending, true);
          this.mode = "esc";
          this.pending = ESC;
        } else {
          this.pending += ch;
          const code = ch.codePointAt(0);
          if (code >= 0x40 && code <= 0x7e) this._finishCsi();
          else this._checkControlLength();
        }
        return;
      }

      if (this.mode === "osc" || this.mode === "string") {
        this.pending += ch;
        if (ch === ESC) this.mode += "_esc";
        else if (this.mode === "osc" && ch === BEL) this._annotate(this.pending);
        else this._checkControlLength();
        return;
      }

      // OSC, DCS, SOS, PM and APC strings end at ESC \\; OSC may also use BEL.
      if (this.mode === "osc_esc" || this.mode === "string_esc") {
        const former = this.mode === "osc_esc" ? "osc" : "string";
        this.pending += ch;
        if (ch === "\\") this._annotate(this.pending);
        else {
          this.mode = ch === ESC ? former + "_esc" : former;
          this._checkControlLength();
        }
      }
    }

    write(text) {
      for (const ch of String(text)) this._writeChar(ch);
      return this;
    }

    toString() {
      const rendered = this.lines.map((line) => line.join("")).join("\n");
      // An unfinished sequence is visible during live streaming, and vanishes
      // once the remainder arrives and the completed sequence is interpreted.
      return this.pending ? rendered + visibleControl(this.pending, true) : rendered;
    }
  }

  if (typeof module !== "undefined" && module.exports) module.exports = {TerminalRenderer};
  if (typeof window !== "undefined") window.TerminalRenderer = TerminalRenderer;
})();
