"use strict";

// Checks for filtering, output search, Markdown export and the timeline layout.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
if (typeof global.atob !== "function") global.atob = (value) => Buffer.from(value, "base64").toString("binary");
const {consume, processes, state, statusCategories, filterMatch, timelineLayout, overlappingKeys,
  markdownFence, outputLines, sha256Hex, exportMarkdown, terminalHash, parseTerminalHash} = require("./app.js");

function evt(type, processId, ts, extra = {}) {
  return {type, ts, connection_id: "c", session_id: null, process_id: processId, ...extra};
}
const b64 = (text) => Buffer.from(text).toString("base64");
const allFilters = {status: "all", engagement: "all", searchOutput: true};

processes.clear();
state.notes = {};
consume(evt("start", "fetch", "2026-10-17T12:00:00Z", {argv: ["bash", "tools/run-step", "demo-webapp", "config-01",
  "--target", "http://127.0.0.1:1", "--purpose", "Read the config", "--", "curl", "-sS", "-o",
  "engagements/demo-webapp/evidence/config-01.json", "http://127.0.0.1:1/fetch"], cwd: "/tmp"}));
consume(evt("start_accepted", "fetch", "2026-10-17T12:00:00Z"));
consume(evt("output", "fetch", "2026-10-17T12:00:02Z", {seq: 1, stream: "stdout", chunk_b64: b64("Needle Found\n```fence\n")}));
consume(evt("output", "fetch", "2026-10-17T12:00:03Z", {seq: 2, stream: "stderr", chunk_b64: b64("warn\n")}));
consume(evt("exited", "fetch", "2026-10-17T12:00:04Z", {seq: 3, exit_code: 3}));
consume(evt("closed", "fetch", "2026-10-17T12:00:04Z", {seq: 4}));
consume(evt("start", "plain", "2026-10-17T12:00:03Z", {argv: ["sleep", "100"], cwd: "/tmp"}));
consume(evt("start_accepted", "plain", "2026-10-17T12:00:03Z"));
consume(evt("start", "late", "2026-10-17T12:00:10Z", {argv: ["true"], cwd: "/tmp"}));
consume(evt("exited", "late", "2026-10-17T12:00:11Z", {seq: 1, exit_code: 0}));
consume(evt("closed", "late", "2026-10-17T12:00:11Z", {seq: 2}));

const fetch = processes.get("c:fetch");
const plain = processes.get("c:plain");
const late = processes.get("c:late");
assert.deepEqual([...statusCategories(fetch, false)].sort(), ["closed", "nonzero"]);
assert.deepEqual([...statusCategories(plain, false)], ["running"]);
assert.deepEqual([...statusCategories(plain, true)], ["incomplete"], "stale recorder makes open terminals uncertain");

assert.ok(filterMatch(fetch, {...allFilters, status: "nonzero"}, "", false));
assert.equal(filterMatch(plain, {...allFilters, status: "nonzero"}, "", false), null);
assert.ok(filterMatch(fetch, {...allFilters, engagement: "demo-webapp"}, "", false));
assert.equal(filterMatch(plain, {...allFilters, engagement: "demo-webapp"}, "", false), null);
assert.ok(filterMatch(plain, {...allFilters, engagement: "none"}, "", false));
assert.deepEqual(filterMatch(fetch, allFilters, "config-01", false), {output: false}, "action ID is searchable");
assert.deepEqual(filterMatch(fetch, allFilters, "needle found", false), {output: true}, "output search is case-insensitive");
assert.equal(filterMatch(fetch, {...allFilters, searchOutput: false}, "needle", false), null);

assert.equal(markdownFence("a ``` b"), "````");
assert.equal(markdownFence("plain"), "```");
assert.deepEqual(outputLines(fetch), ["Needle Found", "```fence", "warn"]);

(async () => {
  const digest = await sha256Hex(fetch.outputChunks);
  assert.equal(digest, crypto.createHash("sha256").update("Needle Found\n```fence\nwarn\n").digest("hex"),
    "digest covers raw output bytes in arrival order, excluding stdin");
  const markdown = exportMarkdown(fetch, {fromLine: 2, toLine: 3, outputSha256: digest});
  assert.match(markdown, /### Terminal #1 · GET\n/);
  assert.match(markdown, /Harness --purpose:\*\* Read the config/);
  assert.match(markdown, /exit code 3/);
  assert.match(markdown, new RegExp(digest));
  assert.match(markdown, /lines 2–3 of 3/);
  assert.match(markdown, /````text\n```fence\nwarn\n````/, "fence grows past backticks in output");
  assert.ok(!markdown.includes("Needle Found"), "line range limits the exported output");
  assert.match(markdown, /Body \(-o\) saved to file \(not shown below\)/);
  assert.match(exportMarkdown(plain), /no output recorded/);

  const layout = timelineLayout([late, plain, fetch], Date.parse("2026-10-17T12:00:20Z"), true);
  assert.deepEqual(layout.lanes.map((lane) => lane.key), ["c:fetch", "c:plain", "c:late"], "lanes are chronological");
  assert.equal(layout.lanes[0].leftPct, 0);
  assert.equal(layout.endMs, Date.parse("2026-10-17T12:00:20Z"), "open terminal extends to now while recorder runs");
  assert.ok(layout.lanes[0].ticks.length >= 2, "output events become ticks");
  assert.deepEqual([...overlappingKeys(layout, "c:fetch")], ["c:plain"]);
  const stopped = timelineLayout([plain], Date.parse("2026-10-17T12:00:20Z"), false);
  assert.equal(stopped.lanes[0].end, Date.parse("2026-10-17T12:00:03Z"), "without a live recorder, bars end at the last event");
  const hash = terminalHash("conn one:proc/1", "terminal");
  assert.equal(hash, "#terminal=conn%20one%3Aproc%2F1&view=terminal");
  assert.deepEqual(parseTerminalHash(hash), {key: "conn one:proc/1", view: "terminal"}, "links round-trip the process key");
  assert.deepEqual(parseTerminalHash("#view=bogus"), {key: null, view: null}, "unknown views are ignored");
  console.log("Feature checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
