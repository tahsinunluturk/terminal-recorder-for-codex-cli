"use strict";

// The example AGENTS.md commands must be understood by the viewer as documented.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
if (typeof global.atob !== "function") global.atob = (value) => Buffer.from(value, "base64").toString("binary");
const {consume, processes, state, relatedProcesses, processPresentation} = require("./app.js");

const agents = fs.readFileSync(path.join(__dirname, "..", "examples", "step-wrappers", "AGENTS.md"), "utf8")
  .replaceAll("ENGAGEMENT_NAME", "webapp");
const commands = [...agents.matchAll(/```bash\n([\s\S]*?)```/g)]
  .map((match) => match[1].replace(/\\\n\s*/g, "").trim());
assert.equal(commands.length, 5, "AGENTS.md shows five example commands");

processes.clear();
state.notes = {};
commands.forEach((command, index) => {
  consume({type: "start", ts: `2026-10-18T12:00:0${index}Z`, connection_id: "c", session_id: null,
    process_id: `p${index}`, argv: ["bash", "-lc", command], cwd: "/tmp"});
});
const [list, save, read, service, report] = commands.map((_, index) => processes.get(`c:p${index}`));
assert.equal(list.reason, "List the source files");
assert.equal(processPresentation(save).kind, "GET");
assert.equal(service.reason, "Run the app for manual checks");
assert.equal(processPresentation(report).subtitle, "Reported purpose: Check the service is up");
const linked = (proc) => relatedProcesses(proc).map((link) => link.related.processId).sort();
assert.deepEqual(linked(save), ["p2", "p4"], "the saved response links to its reader and its report");
assert.deepEqual(linked(report), ["p1", "p2"], "the report links to the step and the reader it cites");
console.log("Example wrapper checks passed");
