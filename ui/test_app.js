"use strict";

const assert = require("node:assert/strict");
if (typeof global.atob !== "function") global.atob = (value) => Buffer.from(value, "base64").toString("binary");
const {consume, lifecycle, recorderStale, processes, state, keyFor, setHiddenKeys, visibleProcesses,
  sortedProcesses, purposeFromArgv, shellWords, setNotes, applyNotesSnapshot,
  confirmClearAll, visibleKeySnapshot, bulkHideBody, keyBatches, hideKeyBatches,
  simpleCommandWords, curlDetails, actionFromArgv, normalizeEvidencePath, readEvidenceFiles,
  terminalTitle, recordedPurpose, processPresentation, relatedProcesses,
  responseFileDestinations, relationshipDetailsText, renderActionSummary, renderRelationships,
  shouldScopeSelectAll, selectAllInPane, selectAllInAvailablePane,
  copyText, setTextIfChanged, shouldDeferPanelRender, updatePurposeText, flushPendingPurposeText,
  updateTerminalText, flushPendingTerminalText} = require("./app.js");

function reset() {
  processes.clear();
  state.recorderStarted = false;
  state.recorderStopped = false;
  state.heartbeatSeen = false;
  state.lastHeartbeatMs = null;
  state.hidden.clear();
  state.selected = null;
  state.sortOrder = "newest";
  state.notes = {};
  state.notesRevision = 0;
}

function evt(type, processId, extra = {}) {
  return {type, ts: "2026-10-17T12:00:00Z", connection_id: "conn-one",
    session_id: null, process_id: processId, ...extra};
}

reset();
consume(evt("start", "one", {argv: ["printf", "ok"], cwd: "/tmp"}));
consume(evt("output", "one", {session_id: "session-later", seq: 1, stream: "stdout",
  chunk_b64: Buffer.from("one\n").toString("base64")}));
consume(evt("exited", "one", {session_id: "session-later", seq: 2, exit_code: 0}));
consume(evt("closed", "one", {session_id: "session-later", seq: 3}));
assert.equal(processes.size, 1, "session ID change must not split a tab");
const closed = processes.get("conn-one:one");
assert.equal(lifecycle(closed), "Closed");
assert.equal(closed.gaps.length, 0);
assert.equal(closed.terminal.toString(), "one\n", "terminal view keeps output text");
consume(evt("start", "two", {argv: ["listener"], cwd: "/tmp"}));
assert.equal(processes.size, 2, "closed tab must remain after another process starts");
assert.equal(lifecycle(processes.get("conn-one:one")), "Closed");
consume(evt("connection_closed", null, {status: "peer_closed"}));
assert.equal(closed.gaps.length, 0, "closed process should not gain a false gap");
assert.ok(processes.get("conn-one:two").gaps.length > 0, "unclosed process must be incomplete");

reset();
consume(evt("start", "gap", {argv: ["printf"], cwd: "/tmp"}));
consume(evt("output", "gap", {seq: 1, stream: "stdout", chunk_b64: "YQ=="}));
consume(evt("output", "gap", {seq: 3, stream: "stdout", chunk_b64: "Yg=="}));
assert.match(processes.get("conn-one:gap").gaps.join(" "), /Expected sequence/);

reset();
consume(evt("recorder_start", null));
consume(evt("start", "quiet", {argv: ["listener"], cwd: "/tmp"}));
assert.equal(recorderStale(), false, "no heartbeat contract seen yet");
consume(evt("recorder_heartbeat", null, {ts: new Date(Date.now() - 11000).toISOString()}));
assert.equal(recorderStale(), true, "quiet process with dead recorder must be uncertain");
consume(evt("recorder_heartbeat", null, {ts: new Date().toISOString()}));
assert.equal(recorderStale(), false, "new heartbeat must clear transient warning");
consume(evt("recorder_stop", null));
assert.equal(recorderStale(), false, "orderly stop has its own lifecycle state");
assert.ok(processes.get(keyFor(evt("output", "quiet"))).gaps.length > 0,
  "orderly recorder stop without process close is incomplete");

reset();
consume(evt("start", "failed", {argv: ["missing-command"], cwd: "/tmp"}));
consume(evt("start_failed", "failed", {status: "error"}));
assert.equal(lifecycle(processes.get("conn-one:failed")), "Launch failed");
assert.equal(processes.get("conn-one:failed").gaps.length, 0,
  "fully observed start failure is not a capture gap");

reset();
consume(evt("start", "interactive", {argv: ["sh"], cwd: "/tmp", tty: true}));
consume(evt("output", "interactive", {seq: 1, stream: "pty",
  chunk_b64: Buffer.from("ready\r").toString("base64")}));
consume(evt("output", "interactive", {seq: 2, stream: "pty",
  chunk_b64: Buffer.from("\nnext\r\n").toString("base64")}));
consume(evt("stdin", "interactive", {chunk_b64: Buffer.from("quit\n").toString("base64")}));
consume(evt("stdin_ack", "interactive", {status: "accepted"}));
const interactive = processes.get("conn-one:interactive");
assert.equal(interactive.terminal.toString(), "ready\nnext\n", "CRLF split across events renders as terminal lines");
assert.deepEqual(interactive.inputEvents.map((item) => item.kind), ["stdin", "ack"],
  "requested input stays separate from observed terminal output");

reset();
consume(evt("start", "active", {argv: ["sleep", "30"], cwd: "/tmp"}));
consume(evt("start", "finished", {argv: ["pwd"], cwd: "/tmp"}));
consume(evt("closed", "finished", {seq: 1}));
state.selected = "conn-one:active";
assert.equal(setHiddenKeys(["conn-one:active"]), true);
assert.equal(state.selected, "conn-one:finished", "hiding an active selection moves to a visible process");
assert.deepEqual(visibleProcesses().map((proc) => proc.key), ["conn-one:finished"]);
assert.equal(processes.size, 2, "hiding keeps the underlying process record");
assert.equal(setHiddenKeys(["conn-one:active", "conn-one:finished"]), true);
assert.equal(state.selected, null, "all-hidden captures have no selected visible terminal");
assert.equal(setHiddenKeys(["conn-one:active", "conn-one:finished"]), false,
  "unchanged server state does not trigger a redraw");
assert.equal(setHiddenKeys(["conn-one:finished"]), true);
assert.equal(state.selected, "conn-one:active", "restoring a running terminal makes it selectable again");
assert.equal(lifecycle(processes.get("conn-one:finished")), "Closed",
  "hidden status does not alter recorded process lifecycle");
assert.throws(() => setHiddenKeys({hidden: []}), /Invalid/);

reset();
consume(evt("output", "startless", {seq: 1, stream: "stdout", chunk_b64: "YQ=="}));
assert.equal(processes.get("conn-one:startless").hasStart, false);
setHiddenKeys(["conn-one:startless"]);
assert.equal(visibleProcesses().length, 0, "a startless incomplete tab can still be hidden");
setHiddenKeys([]);
assert.equal(visibleProcesses().length, 1, "the startless tab remains restorable");

reset();
consume(evt("start", "early", {ts: "2026-10-17T10:00:00Z", argv: ["echo", "early"]}));
consume(evt("start", "late", {ts: "2026-10-17T12:00:00Z", argv: ["echo", "late"]}));
assert.equal(terminalTitle(processes.get("conn-one:early")), "Terminal #1");
assert.equal(terminalTitle(processes.get("conn-one:late")), "Terminal #2");
assert.deepEqual(visibleProcesses().map((proc) => proc.processId), ["late", "early"], "newest first is default");
state.sortOrder = "oldest";
assert.deepEqual(visibleProcesses().map((proc) => proc.processId), ["early", "late"], "oldest first is selectable");
assert.deepEqual(sortedProcesses().map((proc) => proc.processId), ["early", "late"]);
assert.equal(terminalTitle(processes.get("conn-one:late")), "Terminal #2", "sorting never changes the stable number");
const confirmedKeys = visibleKeySnapshot();
consume(evt("start", "later", {ts: "2026-10-17T13:00:00Z", argv: ["echo", "later"]}));
assert.equal(terminalTitle(processes.get("conn-one:later")), "Terminal #3");
setHiddenKeys(["conn-one:early"]);
assert.equal(terminalTitle(processes.get("conn-one:early")), "Terminal #1", "hiding never renumbers terminals");
assert.deepEqual(JSON.parse(bulkHideBody(confirmedKeys)), {keys: ["conn-one:early", "conn-one:late"]},
  "clear all must send only the process keys visible before confirmation, not a later arrival");

assert.deepEqual(purposeFromArgv(["python3", "tools/report-step", "x", "--purpose", "Classify the service"]),
  {value: "Classify the service", source: "Reported step purpose"});
assert.deepEqual(purposeFromArgv(["tools/run-step", "--purpose", "Read local headers", "--", "curl"]),
  {value: "Read local headers", source: "Harness --purpose"});
const reportCommand = "python3 tools/report-step api-check --target http://127.0.0.1:8080/ --purpose 'Identify the application role on observed port 8080' --excerpt 'HTTP 200 OK' --decision 'Proposed next step: GET /api/config; do not execute it'";
assert.deepEqual(purposeFromArgv(["/usr/bin/zsh", "-lc", reportCommand]),
  {value: "Identify the application role on observed port 8080", source: "Reported step purpose"},
  "purpose inside a zsh -lc wrapper must be displayed");
assert.equal(purposeFromArgv(["/usr/bin/zsh", "-lc", "echo '--purpose forged'"]), null,
  "do not treat unrelated command text as a reason");
assert.equal(purposeFromArgv(["python3", "tools/report-step", "--", "--purpose", "forged"]), null);
assert.equal(shellWords("python3 tools/report-step --purpose 'unterminated"), null);
reset();
consume(evt("start", "report", {argv: ["/usr/bin/zsh", "-lc", reportCommand]}));
assert.equal(processes.get("conn-one:report").reason, "Identify the application role on observed port 8080");
assert.equal(processes.get("conn-one:report").reasonSource, "Reported step purpose");
consume(evt("start", "explicit", {argv: ["echo", "hi"], reason: "Explain before run"}));
assert.equal(processes.get("conn-one:explicit").reasonSource, "Captured event reason");
assert.equal(recordedPurpose(processes.get("conn-one:explicit")), "Recorded reason: Explain before run");
assert.equal(recordedPurpose(processes.get("conn-one:report")), "Reported purpose: Identify the application role on observed port 8080");
assert.equal(recordedPurpose({reason: null}), "Purpose not recorded", "missing purpose must not be replaced with the raw command");
assert.equal(setNotes({"conn-one:report": "Human context"}), true);
assert.equal(setNotes({"conn-one:report": "Human context"}), false);
assert.equal(recordedPurpose(processes.get("conn-one:report")), "Reported purpose: Identify the application role on observed port 8080",
  "captured purpose takes priority over a human note");
state.notes["conn-one:unexplained"] = "Investigate wrapper";
assert.equal(recordedPurpose({key: "conn-one:unexplained", reason: null}),
  "Your note (not in capture): Investigate wrapper", "a saved human note fills a missing purpose with clear provenance");
assert.throws(() => setNotes({"conn-one:report": 12}), /Invalid/);
const oldGetRevision = state.notesRevision;
state.notesRevision += 1;
setNotes({"conn-one:report": "Just saved"});
assert.equal(applyNotesSnapshot({"conn-one:report": "Stale GET"}, oldGetRevision), false,
  "a GET that began before a note save cannot overwrite the saved response");
assert.equal(state.notes["conn-one:report"], "Just saved");
let confirmationText = "";
assert.equal(confirmClearAll(2, (message) => { confirmationText = message; return false; }), false,
  "cancelling the confirmation prevents clear all");
assert.match(confirmationText, /all 2 visible terminals/);
assert.match(confirmationText, /does not stop running processes or delete the raw capture/);
assert.equal(confirmClearAll(1, () => true), true, "explicit confirmation permits clear all");

const getScript = "bash tools/run-step webapp api-root-06 --target http://127.0.0.1:8080/ --purpose 'Classify observed port' --artifact engagements/webapp/evidence/root.headers --artifact engagements/webapp/evidence/root.body -- curl -sS --connect-timeout 5 --max-time 20 -D engagements/webapp/evidence/root.headers -o engagements/webapp/evidence/root.body http://127.0.0.1:8080/";
const getArgv = ["/usr/bin/zsh", "-lc", getScript];
assert.equal(simpleCommandWords(getArgv)[0], "bash");
const getAction = actionFromArgv(getArgv);
assert.equal(getAction.kind, "run-step");
assert.equal(getAction.actionId, "api-root-06");
assert.equal(getAction.curl.method, "GET");
assert.equal(getAction.curl.url, "http://127.0.0.1:8080/");
assert.equal(getAction.curl.headerFile, "engagements/webapp/evidence/root.headers");
assert.equal(getAction.curl.bodyFile, "engagements/webapp/evidence/root.body");
assert.deepEqual(getAction.artifacts, ["engagements/webapp/evidence/root.headers", "engagements/webapp/evidence/root.body"]);
assert.deepEqual(responseFileDestinations(getAction), [
  {label: "Headers (-D)", file: "engagements/webapp/evidence/root.headers", declared: true},
  {label: "Body (-o)", file: "engagements/webapp/evidence/root.body", declared: true},
]);
assert.deepEqual(responseFileDestinations({curl: {headerFile: "/dev/null", bodyFile: "-"}, artifacts: []}), [],
  "discarded or stdout-directed data must not be described as a saved response file");
assert.match(getAction.innerCommand, /^curl -sS --connect-timeout 5/);
assert.equal(curlDetails(["curl", "-X", "POST", "-o", "body", "http://127.0.0.1:8080/"]).method, null,
  "a non-GET curl command must not be labelled GET");
assert.equal(actionFromArgv(["/usr/bin/zsh", "-lc", getScript + "; curl http://127.0.0.1:8080/next"]), null,
  "compound shell commands are not treated as one captured GET");
const reportArgv = ["/usr/bin/zsh", "-lc", "python3 tools/report-step webapp api-root-06 --purpose 'Classify observed port' --excerpt 'evidence/root.headers@1:5' --excerpt 'evidence/root.body@22:24' --decision 'Propose GET /next only'"];
assert.deepEqual(actionFromArgv(reportArgv), {kind: "report-step", engagement: "webapp", actionId: "api-root-06",
  excerptFiles: ["engagements/webapp/evidence/root.headers", "engagements/webapp/evidence/root.body"], excerptActions: []},
  "a GET in report-step --decision is not an executed request");
assert.equal(normalizeEvidencePath("evidence/root.body", "webapp"), "engagements/webapp/evidence/root.body");
assert.equal(normalizeEvidencePath("evidence/../private", "webapp"), null, "path traversal is not a relation");
assert.equal(normalizeEvidencePath("engagements/another/evidence/root.body", "webapp"), null, "engagements stay isolated");
assert.deepEqual(readEvidenceFiles(["curl", "-o", "engagements/webapp/evidence/root.body"], "webapp"), [],
  "writing a response body does not count as an offline read");
assert.deepEqual(readEvidenceFiles(["sed", "-i", "engagements/webapp/evidence/root.body"], "webapp"), [],
  "in-place edits are not classified as evidence reads");
for (const flag of ["-i.bak", "-ibak", "-ni", "--in-place=.bak"]) {
  assert.deepEqual(readEvidenceFiles(["sed", flag, "engagements/webapp/evidence/root.body"], "webapp"), [],
    `${flag} in-place sed edits are not classified as evidence reads`);
}
for (const flag of ["-e", "-f", "--expression", "--file"]) {
  assert.deepEqual(readEvidenceFiles(["sed", flag, "engagements/webapp/evidence/root.body", "/tmp/other"], "webapp"), [],
    `${flag} expression/script values are not classified as input evidence files`);
}
assert.deepEqual(readEvidenceFiles(["sed", "-n", "1,120p", "engagements/webapp/evidence/root.body"], "webapp"),
  ["engagements/webapp/evidence/root.body"], "the supported sed form still recognizes an explicit input file");
reset();
consume(evt("start", "get", {argv: getArgv}));
const reviewArgv = ["/usr/bin/zsh", "-lc", "bash tools/run-step webapp api-root-review-07 --offline --purpose 'Review the saved response locally' -- sed -n '1,120p' engagements/webapp/evidence/root.headers engagements/webapp/evidence/root.body"];
const linesArgv = ["/usr/bin/zsh", "-lc", "bash tools/run-step webapp api-lines-08 --offline --purpose 'Locate relevant body lines' -- nl -ba engagements/webapp/evidence/root.body"];
consume(evt("start", "review", {ts: "2026-10-17T12:00:10Z", argv: reviewArgv}));
consume(evt("start", "lines", {ts: "2026-10-17T12:00:20Z", argv: linesArgv}));
consume(evt("start", "report", {ts: "2026-10-17T12:01:00Z", argv: reportArgv}));
const getProc = processes.get("conn-one:get");
const reportProc = processes.get("conn-one:report");
assert.deepEqual(processPresentation(getProc), {title: "Terminal #1", subtitle: "Classify observed port", kind: "GET"});
assert.deepEqual(processPresentation(reportProc), {title: "Terminal #4", subtitle: "Reported purpose: Classify observed port", kind: "Report"});
assert.deepEqual(getProc.actionInfo.artifactFiles, ["engagements/webapp/evidence/root.headers", "engagements/webapp/evidence/root.body"]);
assert.deepEqual(processes.get("conn-one:review").actionInfo.readFiles, getProc.actionInfo.artifactFiles,
  "offline sed command explicitly reads both declared artifacts");
assert.deepEqual(processes.get("conn-one:lines").actionInfo.readFiles, ["engagements/webapp/evidence/root.body"]);
assert.deepEqual(relatedProcesses(getProc).map((link) => link.related.processId), ["review", "lines", "report"],
  "GET action exposes all exact-path readers and its later report, not just the first match");
assert.match(relationshipDetailsText(getProc), /Terminal #2 · Run step\nPurpose: Review the saved response locally/,
  "copyable relationship details name the linked terminal and its recorded purpose");
assert.match(relationshipDetailsText(getProc), /engagements\/webapp\/evidence\/root\.headers/,
  "copyable relationship details preserve exact evidence paths");
assert.deepEqual(relatedProcesses(reportProc).map((link) => link.related.processId), ["get", "review", "lines"],
  "report links backward to action and explicitly shared evidence readers");
assert.match(relatedProcesses(reportProc)[0].reasons.join(" "), /Reviews captured action ID/);
assert.match(relatedProcesses(processes.get("conn-one:review"))[0].reasons.join(" "), /reads declared artifact/);
state.hidden.add(getProc.key);
assert.equal(relatedProcesses(reportProc)[0].hidden, true, "a hidden GET remains linked and can be restored");
state.hidden.delete(getProc.key);
const projection = ["/usr/bin/zsh", "-lc", "bash tools/run-step webapp config-summary --offline --purpose 'Summarize saved config' -- cat engagements/webapp/evidence/root.body"];
const projectionReport = ["/usr/bin/zsh", "-lc", "python3 tools/report-step webapp distinct-report --excerpt 'action=config-summary@1:8' --decision 'Propose GET http://127.0.0.1:8080/next'"];
consume(evt("start", "projection", {ts: "2026-10-17T12:02:00Z", argv: projection}));
consume(evt("start", "projection-report", {ts: "2026-10-17T12:03:00Z", argv: projectionReport}));
assert.equal(actionFromArgv(projectionReport).excerptActions[0], "config-summary");
assert.ok(relatedProcesses(processes.get("conn-one:projection-report")).some((link) =>
  link.related.processId === "projection" && link.reasons.some((reason) => reason.includes("Cites output of action ID"))),
"action= references explicitly link the offline projection to its report");
const proposedOnly = ["/usr/bin/zsh", "-lc", "python3 tools/report-step webapp different-action --purpose 'Review a different step' --decision 'Consider api-root-06 and GET http://127.0.0.1:8080/next'"];
consume(evt("start", "proposed-only", {argv: proposedOnly}));
assert.deepEqual(relatedProcesses(processes.get("conn-one:proposed-only")), [],
  "action IDs and GETs in --decision are proposals, not recorded links");
consume(evt("start", "other-engagement", {argv: ["/usr/bin/zsh", "-lc",
  "python3 tools/report-step other api-root-06 --excerpt 'evidence/root.body@1:5'"]}));
assert.deepEqual(relatedProcesses(processes.get("conn-one:other-engagement")), [],
  "identical action IDs and evidence basenames across engagements are not related");
consume(evt("start", "same-url-only", {argv: ["/usr/bin/zsh", "-lc", "curl http://127.0.0.1:8080/next"]}));
assert.deepEqual(relatedProcesses(processes.get("conn-one:same-url-only")), [],
  "matching a URL or a proposed GET in --decision must never create a relation");

function testScopedSelectAll() {
  const child = {};
  let focused = 0;
  let prevented = 0;
  let selectedNode = null;
  let added = 0;
  const pane = {tagName: "DIV", contains: (node) => node === child, focus: () => { focused += 1; }};
  const selection = {anchorNode: child, focusNode: child, removeAllRanges: () => {}, addRange: () => { added += 1; }};
  const doc = {createRange: () => ({selectNodeContents: (node) => { selectedNode = node; }})};
  const shortcut = {key: "a", ctrlKey: true, metaKey: false, altKey: false, preventDefault: () => { prevented += 1; }};
  assert.equal(selectAllInPane(shortcut, pane, pane, selection, doc), true);
  assert.equal(selectedNode, pane, "Ctrl+A selects the pane, not the document");
  assert.equal(prevented, 1);
  assert.equal(focused, 1);
  assert.equal(added, 1);
  assert.equal(shouldScopeSelectAll({...shortcut, ctrlKey: false, metaKey: true}, pane, {tagName: "BODY"}, selection), true,
    "Cmd+A works when the text selection is in the pane");
  assert.equal(shouldScopeSelectAll(shortcut, pane, {tagName: "BUTTON"}, selection), false,
    "button focus keeps normal Ctrl+A even if an old selection remains in a pane");
  assert.equal(shouldScopeSelectAll(shortcut, pane, {tagName: "TEXTAREA"}, selection), false,
    "text editor keeps normal Ctrl+A");
  assert.equal(shouldScopeSelectAll(shortcut, pane, {}, {anchorNode: {}, focusNode: {}}), false,
    "outside the pane Ctrl+A keeps its normal browser behavior");
  assert.equal(shouldScopeSelectAll({...shortcut, altKey: true}, pane, pane, selection), false);
  assert.equal(shouldScopeSelectAll({...shortcut, shiftKey: true}, pane, pane, selection), false);
  const command = {tagName: "PRE", contains: () => false, focus: () => {}};
  const output = {tagName: "DIV", contains: () => false, focus: () => {}};
  selectedNode = null;
  assert.equal(selectAllInAvailablePane(shortcut, [command, output], command, selection, doc), true);
  assert.equal(selectedNode, command, "focused executed-command pane wins over a stale output selection");
  selectedNode = null;
  assert.equal(selectAllInAvailablePane({...shortcut, ctrlKey: false, metaKey: true}, [command, output], command, selection, doc), true);
  assert.equal(selectedNode, command, "Cmd+A also selects only the focused command pane");
  assert.equal(selectAllInAvailablePane(shortcut, [command, output], {tagName: "BUTTON"}, selection, doc), false);
  const purpose = {tagName: "P", contains: () => false, focus: () => {}};
  const summary = {tagName: "DIV", contains: () => false, focus: () => {}};
  const related = {tagName: "SECTION", contains: () => false, focus: () => {}};
  for (const selectedPane of [purpose, summary, related]) {
    selectedNode = null;
    assert.equal(selectAllInAvailablePane(shortcut, [purpose, summary, related, command], selectedPane, selection, doc), true);
    assert.equal(selectedNode, selectedPane, "Ctrl+A scopes to the focused purpose, summary, or relationship panel");
  }
}
testScopedSelectAll();
let commandReplacements = 0;
let commandValue = "";
const commandElement = {get textContent() { return commandValue; },
  set textContent(value) { commandValue = value; commandReplacements += 1; }};
assert.equal(setTextIfChanged(commandElement, "$ curl example"), true);
assert.equal(setTextIfChanged(commandElement, "$ curl example"), false);
assert.equal(commandReplacements, 1, "polling unchanged command text must not destroy a user's selection");

function testSelectedPanelUpdates() {
  const selectedNode = {};
  const pane = {id: "related-panel", contains: (node) => node === selectedNode};
  const selection = {isCollapsed: false, anchorNode: selectedNode, focusNode: selectedNode};
  assert.equal(shouldDeferPanelRender("terminal:a", "terminal:a", selection, pane), true,
    "a live summary or relationship change waits while its text is selected");
  assert.equal(shouldDeferPanelRender("terminal:b", "terminal:a", selection, pane), false,
    "explicitly opening another terminal updates the panel immediately");
  selection.isCollapsed = true;
  assert.equal(shouldDeferPanelRender("terminal:a", "terminal:a", selection, pane), false);
  state.activePointerPanes.add("related-panel");
  assert.equal(shouldDeferPanelRender("terminal:a", "terminal:a", selection, pane), true,
    "a pending update cannot replace an Open or Copy button between pointerdown and click");
  state.activePointerPanes.delete("related-panel");
  let content = "Original purpose";
  let replacements = 0;
  const purpose = {contains: (node) => node === selectedNode,
    get textContent() { return content; }, set textContent(value) { content = value; replacements += 1; }};
  const key = "terminal:a";
  state.renderedPurposeKey = key;
  selection.isCollapsed = false;
  assert.equal(updatePurposeText(purpose, "Original purpose", key, selection), false);
  assert.equal(updatePurposeText(purpose, "Updated purpose", key, selection), false);
  assert.equal(content, "Original purpose", "a selected purpose remains copyable during a live note update");
  assert.equal(replacements, 0, "unchanged polling does not replace the selected purpose node");
  assert.equal(flushPendingPurposeText(purpose, selection, key), false);
  selection.isCollapsed = true;
  assert.equal(flushPendingPurposeText(purpose, selection, key), true);
  assert.equal(content, "Updated purpose", "the latest purpose appears after the selection clears");
  assert.equal(replacements, 1);
}
testSelectedPanelUpdates();

function testSummaryAndRelationshipDomStability() {
  const priorDocument = global.document;
  const priorWindow = global.window;
  const selectedNode = {};
  const selection = {isCollapsed: true, anchorNode: selectedNode, focusNode: selectedNode};
  const elements = new Map();
  const fakeElement = () => {
    let content = "";
    let children = [];
    return {
      hidden: false, replacementCount: 0, textWrites: 0,
      get textContent() { return content; },
      set textContent(value) { content = value; this.textWrites += 1; },
      get childNodes() { return children; },
      replaceChildren() { children = []; this.replacementCount += 1; },
      append(...nodes) { children.push(...nodes); },
      contains: (node) => node === selectedNode,
      setAttribute: () => {}, addEventListener: () => {},
    };
  };
  global.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    createElement: fakeElement,
  };
  global.window = {getSelection: () => selection};
  const oldHiddenAvailable = state.hiddenAvailable;
  try {
    state.renderedActionKey = null;
    state.renderedActionSummary = null;
    state.pendingActionSummary = false;
    const proc = {...getProc, key: "probe:summary", actionInfo: {...getProc.actionInfo}};
    renderActionSummary(proc);
    const artifactList = elements.get("action-artifacts");
    assert.equal(artifactList.replacementCount, 1);
    const kind = elements.get("action-kind");
    const kindWrites = kind.textWrites;
    renderActionSummary(proc);
    assert.equal(artifactList.replacementCount, 1, "unchanged polling retains evidence path nodes");
    assert.equal(kind.textWrites, kindWrites, "unchanged polling retains selected summary text nodes");
    selection.isCollapsed = false;
    proc.actionInfo.innerCommand += " --new-flag";
    renderActionSummary(proc);
    assert.equal(artifactList.replacementCount, 1, "a changed summary waits while selected");
    assert.equal(state.pendingActionSummary, true);
    selection.isCollapsed = true;
    renderActionSummary(proc);
    assert.equal(artifactList.replacementCount, 2, "the changed summary renders once selection clears");

    state.renderedRelationshipKey = null;
    state.renderedRelationships = null;
    state.pendingRelationships = false;
    renderRelationships(getProc);
    const relatedList = elements.get("related-list");
    assert.equal(relatedList.replacementCount, 1);
    renderRelationships(getProc);
    assert.equal(relatedList.replacementCount, 1, "unchanged polling retains linked rows");
    selection.isCollapsed = false;
    state.hiddenAvailable = !oldHiddenAvailable;
    renderRelationships(getProc);
    assert.equal(relatedList.replacementCount, 1, "a relationship-state change waits while selected");
    assert.equal(state.pendingRelationships, true);
    selection.isCollapsed = true;
    renderRelationships(getProc);
    assert.equal(relatedList.replacementCount, 2, "linked rows refresh after selection clears");
  } finally {
    state.hiddenAvailable = oldHiddenAvailable;
    global.document = priorDocument;
    global.window = priorWindow;
  }
}
testSummaryAndRelationshipDomStability();

function testRawSelectionBuffering() {
  const rawTextNode = {};
  const pane = {contains: (node) => node === rawTextNode};
  let rendered = "$ command\nold\n";
  let replacements = 0;
  const output = {get textContent() { return rendered; },
    set textContent(value) { rendered = value; replacements += 1; }};
  const selection = {isCollapsed: false, anchorNode: rawTextNode, focusNode: rawTextNode};
  const key = "conn-one:live";
  state.renderedTerminalKey = key;
  state.pendingTerminalText = null;
  state.pendingTerminalKey = null;
  assert.equal(updateTerminalText(output, "$ command\nold\n", key, pane, selection), false);
  assert.equal(state.pendingTerminalText, null, "a no-change poll does not falsely pause live updates");
  assert.equal(updateTerminalText(output, "$ command\nnew\n", key, pane, selection), false);
  assert.equal(updateTerminalText(output, "$ command\nnewer\n", key, pane, selection), false);
  assert.equal(rendered, "$ command\nold\n", "live updates must preserve a selected raw transcript");
  assert.equal(flushPendingTerminalText(output, pane, selection, key), false);
  selection.isCollapsed = true;
  assert.equal(flushPendingTerminalText(output, pane, selection, key), true);
  assert.equal(rendered, "$ command\nnewer\n", "selection release flushes the most recent transcript");
  assert.equal(replacements, 1);
  assert.equal(state.pendingTerminalText, null);
  assert.equal(updateTerminalText(output, "$ command\nnewer\n", key, pane, selection), false,
    "unchanged raw text must not replace the DOM on a poll");
}
testRawSelectionBuffering();

async function testBulkBatches() {
  const keys = Array.from({length: 2001}, (_, i) => `conn:${i}`);
  assert.deepEqual(keyBatches([]), []);
  assert.deepEqual(keyBatches(keys.slice(0, 1000)).map((batch) => batch.length), [1000]);
  assert.deepEqual(keyBatches(keys).map((batch) => batch.length), [1000, 1000, 1]);
  const sent = [];
  const confirmed = await hideKeyBatches(keys, async (batch) => {
    sent.push(JSON.parse(bulkHideBody(batch)).keys);
    return {hidden: batch};
  });
  assert.equal(confirmed, 2001);
  assert.deepEqual(sent.flat(), keys, "every key from the frozen snapshot is sent exactly once");
  assert.ok(sent.every((batch) => batch.length <= 1000), "every request stays within the API key limit");
  let calls = 0;
  await assert.rejects(hideKeyBatches(keys, async () => {
    calls += 1;
    if (calls === 2) throw new Error("second batch failed");
    return {};
  }), (error) => error.message === "second batch failed" && error.confirmed === 1000,
  "partial failure reports how many hides were confirmed");
  assert.equal(calls, 2, "a failed batch stops later requests");
  let copied = null;
  assert.equal(await copyText("curl 'literal value'", {writeText: async (value) => { copied = value; }}, null, null), true);
  assert.equal(copied, "curl 'literal value'", "copy preserves the reconstructed command text");
  let fallbackSelected = false;
  let restoredFocus = false;
  const input = {style: {}, select: () => { fallbackSelected = true; }, remove: () => {}};
  const doc = {activeElement: {focus: () => { restoredFocus = true; }}, body: {append: () => {}},
    createElement: () => input, execCommand: (name) => name === "copy"};
  const selection = {rangeCount: 0, removeAllRanges: () => {}, addRange: () => {}};
  assert.equal(await copyText("fallback", {writeText: async () => { throw new Error("denied"); }}, doc, selection), true);
  assert.equal(input.value, "fallback");
  assert.equal(fallbackSelected, true);
  assert.equal(restoredFocus, true);
}

testBulkBatches().then(() => console.log("UI state checks passed"), (error) => {
  console.error(error);
  process.exitCode = 1;
});
