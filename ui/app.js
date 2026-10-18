"use strict";

const TerminalRendererImpl = typeof module !== "undefined" && module.exports
  ? require("./terminal_render.js").TerminalRenderer : window.TerminalRenderer;
const byId = (id) => document.getElementById(id);
const processes = new Map();
const globalGaps = [];
const state = {
  cursor: 0,
  selected: null,
  renderedCount: 0,
  displayedFrames: 0,
  renderedFilter: "all",
  viewMode: "frames",
  recorderStarted: false,
  recorderStopped: false,
  heartbeatSeen: false,
  lastHeartbeatMs: null,
  lastStale: false,
  busy: false,
  halted: false,
  hidden: new Set(),
  hiddenExpanded: false,
  hiddenAvailable: false,
  hiddenBusy: false,
  hiddenSyncPromise: null,
  lastHiddenPollMs: 0,
  sortOrder: "newest",
  notes: {},
  noteDrafts: {},
  notesAvailable: false,
  notesBusy: false,
  notesRevision: 0,
  lastNotesPollMs: 0,
  noteProcessKey: null,
  copyProcessKey: null,
  renderedPurposeKey: null,
  pendingPurposeText: null,
  pendingPurposeKey: null,
  renderedTerminalKey: null,
  pendingTerminalText: null,
  pendingTerminalKey: null,
  renderedActionKey: null,
  renderedActionSummary: null,
  pendingActionSummary: false,
  relationshipVersion: 0,
  renderedRelationshipKey: null,
  renderedRelationships: null,
  pendingRelationships: false,
  activePointerPanes: new Set(),
  filters: {status: "all", engagement: "all", searchOutput: true},
  filtersExpanded: false,
  exportExpanded: false,
  requestedKey: null,
};
const MAX_SEARCH_CHARS = 2 * 1024 * 1024;
const relationshipCache = {version: -1, count: -1, byKey: new Map()};

function sortedProcesses() {
  const items = Array.from(processes.values());
  items.sort((a, b) => {
    const left = Date.parse(a.startedAt || "");
    const right = Date.parse(b.startedAt || "");
    const byTime = Number.isNaN(left) || Number.isNaN(right) ? 0 : left - right;
    const result = byTime || a.order - b.order;
    return state.sortOrder === "oldest" ? result : -result;
  });
  return items;
}

function visibleProcesses() {
  return sortedProcesses().filter((proc) => !state.hidden.has(proc.key));
}

function setHiddenKeys(keys) {
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
    throw new Error("Invalid hidden-terminal response");
  }
  const next = new Set(keys);
  const changed = next.size !== state.hidden.size || Array.from(next).some((key) => !state.hidden.has(key));
  state.hidden = next;
  if (!state.selected || state.hidden.has(state.selected) || !processes.has(state.selected)) {
    state.selected = visibleProcesses()[0]?.key || null;
    state.renderedCount = 0;
    state.displayedFrames = 0;
  }
  return changed;
}

function visibilityMessage(message, error = false) {
  const status = byId("visibility-status");
  status.textContent = message;
  status.className = "visibility-status" + (error ? " error" : "");
  status.hidden = !message;
}

async function syncHidden(force = false) {
  if (state.hiddenBusy || (!force && Date.now() - state.lastHiddenPollMs < 3000)) return;
  if (state.hiddenSyncPromise) return state.hiddenSyncPromise;
  state.lastHiddenPollMs = Date.now();
  state.hiddenSyncPromise = (async () => {
    try {
      const response = await fetch("/api/hidden", {cache: "no-store"});
      if (!response.ok) throw new Error("HTTP " + response.status);
      const changed = setHiddenKeys((await response.json()).hidden);
      const wasAvailable = state.hiddenAvailable;
      state.hiddenAvailable = true;
      if (byId("visibility-status").classList.contains("error")) visibilityMessage("");
      if (changed || !wasAvailable) render();
      else if (processes.size) byId("hide-selected").disabled = state.hiddenBusy;
      return true;
    } catch (error) {
      state.hiddenAvailable = false;
      visibilityMessage("Could not load display preferences: " + error.message, true);
      render();
      return false;
    } finally {
      state.hiddenSyncPromise = null;
    }
  })();
  return state.hiddenSyncPromise;
}

async function changeHidden(key, hidden) {
  if (!state.hiddenAvailable || state.hiddenBusy) return;
  state.hiddenBusy = true;
  render();
  try {
    if (state.hiddenSyncPromise) await state.hiddenSyncPromise;
    const response = await fetch("/api/hidden", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({key, hidden}),
    });
    const payload = await response.json();
    if (!response.ok) {
      const reason = payload.error === "process_not_found"
        ? "This terminal is not in the capture file or has not been committed yet."
        : payload.error || "HTTP " + response.status;
      throw new Error(reason);
    }
    setHiddenKeys(payload.hidden);
    if (!hidden && processes.has(key)) state.selected = key;
    if (hidden) state.hiddenExpanded = true;
    visibilityMessage(hidden
      ? "Terminal removed from the list. Process and raw capture were preserved. Restore it under Hidden terminals."
      : "Terminal restored to the list.");
    render();
    byId(hidden ? "show-hidden" : "hide-selected").focus();
  } catch (error) {
    visibilityMessage("Could not change the display: " + error.message, true);
  } finally {
    state.hiddenBusy = false;
    render();
  }
}

async function clearAllVisible() {
  const keys = visibleKeySnapshot();
  const count = keys.length;
  if (!count || !state.hiddenAvailable || state.hiddenBusy) return;
  if (!confirmClearAll(count, window.confirm.bind(window))) return;
  state.hiddenBusy = true;
  render();
  try {
    if (state.hiddenSyncPromise) await state.hiddenSyncPromise;
    await hideKeyBatches(keys, async (batch) => {
      const response = await fetch("/api/hidden/bulk", {
        method: "POST", headers: {"Content-Type": "application/json"}, body: bulkHideBody(batch),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "HTTP " + response.status);
      return payload;
    }, (payload) => {
      setHiddenKeys(payload.hidden);
      render();
    });
    state.hiddenExpanded = true;
    visibilityMessage(`All ${count} terminals visible when you confirmed were removed from the list. Raw capture and running processes were preserved.`);
    render();
    byId("show-hidden").focus();
  } catch (error) {
    let currentHidden = null;
    try {
      const response = await fetch("/api/hidden", {cache: "no-store"});
      if (!response.ok) throw new Error("HTTP " + response.status);
      setHiddenKeys((await response.json()).hidden);
      currentHidden = keys.filter((key) => state.hidden.has(key)).length;
    } catch (_) { /* Report confirmed batches if current state cannot be fetched. */ }
    state.hiddenExpanded = true;
    visibilityMessage(currentHidden === null
      ? `Hide all stopped. At least ${error.confirmed || 0} of ${count} terminals were hidden; current visibility could not be refreshed. ${error.message}`
      : `Hide all stopped. ${currentHidden} of ${count} confirmed terminals are currently hidden; ${count - currentHidden} remain visible. ${error.message}`, true);
  } finally {
    state.hiddenBusy = false;
    render();
  }
}

function keyBatches(keys, batchSize = 1000) {
  const batches = [];
  for (let i = 0; i < keys.length; i += batchSize) batches.push(keys.slice(i, i + batchSize));
  return batches;
}

async function hideKeyBatches(keys, sendBatch, onBatch = () => {}) {
  let confirmed = 0;
  for (const batch of keyBatches(keys)) {
    try {
      const payload = await sendBatch(batch);
      onBatch(payload);
      confirmed += batch.length;
    } catch (error) {
      error.confirmed = confirmed;
      throw error;
    }
  }
  return confirmed;
}

function visibleKeySnapshot() {
  return visibleProcesses().map((proc) => proc.key);
}

function bulkHideBody(keys) {
  return JSON.stringify({keys});
}

function confirmClearAll(count, confirmFn) {
  return confirmFn(`Remove all ${count} visible terminal${count === 1 ? "" : "s"} from the list?\n\nThis does not stop running processes or delete the raw capture. You can restore terminals under Hidden terminals.`);
}

function setNotes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Object.entries(value).every(([key, note]) => typeof key === "string" && typeof note === "string")) {
    throw new Error("Invalid notes response");
  }
  const changed = JSON.stringify(value) !== JSON.stringify(state.notes);
  state.notes = value;
  return changed;
}

function applyNotesSnapshot(notes, revision) {
  if (revision !== state.notesRevision) return false;
  return setNotes(notes);
}

async function syncNotes(force = false) {
  if (state.notesBusy || (!force && Date.now() - state.lastNotesPollMs < 3000)) return;
  state.lastNotesPollMs = Date.now();
  const revision = state.notesRevision;
  try {
    const response = await fetch("/api/notes", {cache: "no-store"});
    if (!response.ok) throw new Error("HTTP " + response.status);
    const changed = applyNotesSnapshot((await response.json()).notes, revision);
    if (revision !== state.notesRevision) return;
    state.notesAvailable = true;
    if (changed) { renderTabs(); renderDetail(); }
    else updateNoteButton();
  } catch (_) {
    if (revision !== state.notesRevision) return;
    state.notesAvailable = false;
    updateNoteButton();
    byId("note-status").textContent = "Notes unavailable";
  }
}

function updateNoteButton() {
  const proc = processes.get(state.selected);
  byId("save-note").disabled = !proc || !state.notesAvailable || state.notesBusy ||
    byId("human-note").value === (state.notes[proc.key] || "");
}

async function saveNote() {
  const key = state.selected;
  if (!key || !state.notesAvailable || state.notesBusy) return;
  const note = byId("human-note").value;
  state.notesBusy = true;
  state.notesRevision += 1;
  updateNoteButton();
  byId("note-status").textContent = "Saving…";
  try {
    const response = await fetch("/api/notes", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({key, note}),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "HTTP " + response.status);
    setNotes(payload.notes);
    if (state.noteDrafts[key] === note) delete state.noteDrafts[key];
    renderTabs(); renderDetail();
    if (state.selected === key) byId("note-status").textContent = note ? "Note saved" : "Note cleared";
  } catch (error) {
    byId("note-status").textContent = "Could not save note: " + error.message;
  } finally {
    state.notesBusy = false;
    updateNoteButton();
  }
}

function shortTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString("en-GB");
}

function tabTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit", second: "2-digit"});
}

function shellQuote(value) {
  const item = escapeControls(String(value));
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(item) ? item : "'" + item.replaceAll("'", "'\\''") + "'";
}

function commandText(proc) {
  return proc.argv.length ? proc.argv.map(shellQuote).join(" ") : "Command not recorded";
}

function setTextIfChanged(element, value) {
  if (element.textContent === value) return false;
  element.textContent = value;
  return true;
}

function shellWords(script) {
  const words = [];
  let word = "";
  let started = false;
  let quote = null;
  const push = () => { if (started) { words.push(word); word = ""; started = false; } };
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < script.length && /[$`"\\\n]/.test(script[i + 1])) word += script[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === "\\") {
      if (i + 1 >= script.length) return null;
      word += script[++i]; started = true; continue;
    }
    if (/\s/.test(ch)) { push(); continue; }
    if (/[;|&<>()]/.test(ch)) { push(); words.push("\u0000"); continue; }
    word += ch; started = true;
  }
  if (quote) return null;
  push();
  return words;
}

function purposeFromArgv(argv) {
  if (!Array.isArray(argv) || !argv.length) return null;
  const basename = (value) => String(value).split(/[/\\]/).pop();
  let args = argv.map(String);
  let source = "Harness --purpose";
  const shell = basename(args[0]);
  if (/^(?:sh|bash|zsh|dash)$/.test(shell) && args.length >= 3 && /^-[a-z]*c[a-z]*$/i.test(args[1])) {
    args = shellWords(args[2]);
    source = "Parsed --purpose (shell command)";
    if (!args) return null;
  }
  const helper = (value) => ["run-step", "run-service", "report-step"].includes(value);
  let helperIndex = -1;
  if (helper(basename(args[0]))) helperIndex = 0;
  else if (args.length > 1 && /^(?:bash|python|python3)(?:\.exe)?$/.test(basename(args[0])) && helper(basename(args[1]))) helperIndex = 1;
  if (helperIndex < 0) return null;
  if (basename(args[helperIndex]) === "report-step") source = "Reported step purpose";
  for (let i = helperIndex + 1; i < args.length; i += 1) {
    const part = args[i];
    if (part === "--" || part === "\u0000") break;
    if (part === "--purpose" && i + 1 < args.length && args[i + 1] !== "\u0000") {
      return args[i + 1].trim() ? {value: args[i + 1], source} : null;
    }
    if (part.startsWith("--purpose=") && part.length > "--purpose=".length) {
      return {value: part.slice("--purpose=".length), source};
    }
  }
  return null;
}

function simpleCommandWords(argv) {
  if (!Array.isArray(argv) || !argv.length) return null;
  let args = argv.map(String);
  const shell = String(args[0]).split(/[/\\]/).pop();
  if (/^(?:sh|bash|zsh|dash)$/.test(shell) && args.length >= 3 && /^-[a-z]*c[a-z]*$/i.test(args[1])) {
    args = shellWords(args[2]);
  }
  return args && !args.includes("\u0000") ? args : null;
}

function curlDetails(argv) {
  if (!argv.length || String(argv[0]).split(/[/\\]/).pop() !== "curl") return null;
  const urls = [];
  let headerFile = null;
  let bodyFile = null;
  let method = "GET";
  let safeGet = true;
  const noValue = new Set(["-s", "-S", "-sS", "-Ss", "--silent", "--show-error", "-L", "--location", "-f", "--fail", "-k", "--insecure", "--compressed", "-i", "--include", "-v", "--verbose"]);
  const withValue = new Set(["--connect-timeout", "--max-time", "--retry", "--retry-delay", "--retry-max-time", "--user-agent", "-A", "--header", "-H", "--resolve", "--cacert", "--proxy"]);
  for (let i = 1; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "-D" || part === "--dump-header") { headerFile = argv[++i] || null; continue; }
    if (part.startsWith("--dump-header=")) { headerFile = part.slice(14); continue; }
    if (part.startsWith("-D") && part.length > 2) { headerFile = part.slice(2); continue; }
    if (part === "-o" || part === "--output") { bodyFile = argv[++i] || null; continue; }
    if (part.startsWith("--output=")) { bodyFile = part.slice(9); continue; }
    if (part.startsWith("-o") && part.length > 2) { bodyFile = part.slice(2); continue; }
    if (part === "--url") { urls.push(argv[++i] || ""); continue; }
    if (part.startsWith("--url=")) { urls.push(part.slice(6)); continue; }
    if (part === "-X" || part === "--request") { method = (argv[++i] || "").toUpperCase(); continue; }
    if (part === "-I" || part === "--head") { method = "HEAD"; continue; }
    if (/^(?:--data(?:-raw|-binary|-urlencode)?|--json|--form|--upload-file|-d|-F|-T)$/.test(part)) { safeGet = false; i += 1; continue; }
    if (/^(?:--data|--json|--form|--upload-file)=/.test(part)) { safeGet = false; continue; }
    if (noValue.has(part)) continue;
    if (withValue.has(part)) { i += 1; continue; }
    if (Array.from(withValue).some((flag) => part.startsWith(flag + "="))) continue;
    if (/^https?:\/\//i.test(part)) { urls.push(part); continue; }
    if (part === "--") continue;
    if (part.startsWith("-")) safeGet = false;
  }
  return {
    url: urls.length === 1 && /^https?:\/\//i.test(urls[0]) ? urls[0] : null,
    method: safeGet && method === "GET" ? "GET" : null,
    headerFile, bodyFile,
  };
}

function actionFromArgv(argv) {
  const args = simpleCommandWords(argv);
  if (!args) return null;
  const basename = (value) => String(value).split(/[/\\]/).pop();
  let index = 0;
  if (/^(?:bash|python|python3)(?:\.exe)?$/.test(basename(args[0])) && args.length > 1) index = 1;
  const kind = basename(args[index]);
  if (kind !== "run-step" && kind !== "report-step") return null;
  const engagement = args[index + 1];
  const actionId = args[index + 2];
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(engagement || "") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(actionId || "")) return null;
  if (kind === "report-step") {
    const excerptFiles = [];
    const excerptActions = [];
    for (let i = index + 3; i < args.length; i += 1) {
      const part = args[i];
      if (part === "--") break;
      let excerpt = null;
      if (part === "--excerpt" && i + 1 < args.length) excerpt = args[++i];
      else if (part.startsWith("--excerpt=")) excerpt = part.slice("--excerpt=".length);
      if (!excerpt) continue;
      const reference = excerpt.replace(/@\d+(?::\d+)?$/, "");
      if (reference.startsWith("action=")) {
        const referencedId = reference.slice("action=".length);
        if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(referencedId)) excerptActions.push(referencedId);
      } else {
        const file = normalizeEvidencePath(reference, engagement);
        if (file) excerptFiles.push(file);
      }
    }
    return {kind, engagement, actionId,
      excerptFiles: [...new Set(excerptFiles)], excerptActions: [...new Set(excerptActions)]};
  }
  const separator = args.indexOf("--", index + 3);
  if (separator < 0 || separator === args.length - 1) return {kind, engagement, actionId};
  const artifacts = [];
  let offline = false;
  for (let i = index + 3; i < separator; i += 1) {
    if (args[i] === "--artifact" && i + 1 < separator) artifacts.push(args[++i]);
    else if (args[i].startsWith("--artifact=")) artifacts.push(args[i].slice("--artifact=".length));
    else if (args[i] === "--offline") offline = true;
  }
  const innerArgv = args.slice(separator + 1);
  return {kind, engagement, actionId, innerArgv, innerCommand: innerArgv.map(shellQuote).join(" "),
    curl: curlDetails(innerArgv), artifacts, offline,
    artifactFiles: [...new Set(artifacts.map((file) => normalizeEvidencePath(file, engagement)).filter(Boolean))],
    readFiles: offline ? readEvidenceFiles(innerArgv, engagement) : []};
}

function normalizeEvidencePath(path, engagement) {
  if (typeof path !== "string" || !engagement) return null;
  let value = path.replace(/^\.\//, "");
  if (value.startsWith("evidence/")) value = `engagements/${engagement}/` + value;
  const prefix = `engagements/${engagement}/evidence/`;
  if (!value.startsWith(prefix)) return null;
  const parts = value.slice(prefix.length).split("/");
  return parts.length && parts.every((part) => part && part !== "." && part !== "..") ? value : null;
}

function readEvidenceFiles(argv, engagement) {
  const reader = String(argv[0] || "").split(/[/\\]/).pop();
  let index = 1;
  if (reader === "sed") {
    if (argv[index] === "-n") index += 1;
    if (!/^\d+(?:,\d+)?p$/.test(argv[index] || "")) return [];
    index += 1;
  } else if (reader === "nl") {
    if (argv[index] === "-ba") index += 1;
    if (argv.length - index !== 1) return [];
  } else if (reader === "head" || reader === "tail") {
    if (argv[index] === "-n" || argv[index] === "-c") {
      if (!/^\d+$/.test(argv[index + 1] || "")) return [];
      index += 2;
    }
  } else if (reader === "wc") {
    while (["-l", "-c", "-w", "-m"].includes(argv[index])) index += 1;
  } else if (reader !== "cat") return [];
  if (argv[index] === "--") index += 1;
  const operands = argv.slice(index);
  if (!operands.length || operands.some((arg) => !arg || arg.startsWith("-"))) return [];
  return [...new Set(operands.map((arg) => normalizeEvidencePath(arg, engagement)).filter(Boolean))];
}

function terminalTitle(proc) {
  return `Terminal #${proc.order + 1}`;
}

function recordedPurpose(proc) {
  if (!proc.reason) {
    const note = state.notes[proc.key];
    return note ? "Your note (not in capture): " + escapeControls(note) : "Purpose not recorded";
  }
  const prefix = proc.reasonSource === "Reported step purpose" ? "Reported purpose: "
    : proc.reasonSource === "Captured event reason" ? "Recorded reason: " : "";
  return prefix + escapeControls(proc.reason);
}

function processPresentation(proc) {
  const action = proc.actionInfo;
  const kind = action?.kind === "report-step" ? "Report"
    : action?.curl?.method && action.curl.url ? action.curl.method
    : action?.kind === "run-step" ? "Run step" : "Command";
  return {title: terminalTitle(proc), subtitle: recordedPurpose(proc), kind};
}

function relatedProcesses(proc) {
  if (relationshipCache.version !== state.relationshipVersion || relationshipCache.count !== processes.size) {
    const byKey = new Map();
    const add = (from, to, reason) => {
      if (!byKey.has(from.key)) byKey.set(from.key, new Map());
      const links = byKey.get(from.key);
      if (!links.has(to.key)) links.set(to.key, new Set());
      links.get(to.key).add(reason);
    };
    const link = (a, b, reasonA, reasonB) => { add(a, b, reasonA); add(b, a, reasonB); };
    const items = Array.from(processes.values()).filter((item) => item.actionInfo);
    for (let i = 0; i < items.length; i += 1) {
      const a = items[i];
      const aa = a.actionInfo;
      for (let j = i + 1; j < items.length; j += 1) {
        const b = items[j];
        const ba = b.actionInfo;
        if (aa.engagement !== ba.engagement) continue;
        const pair = [[a, aa, b, ba], [b, ba, a, aa]];
        for (const [producer, source, consumer, use] of pair) {
          if (producer.order >= consumer.order || source.kind !== "run-step") continue;
          if (use.kind === "report-step" && source.actionId === use.actionId) {
            link(producer, consumer,
              `Reports this captured action ID: ${source.actionId}`,
              `Reviews captured action ID: ${source.actionId}`);
          }
          if (use.kind === "report-step" && use.excerptActions?.includes(source.actionId)) {
            link(producer, consumer,
              `Report cites this action's output: ${source.actionId}`,
              `Cites output of action ID: ${source.actionId}`);
          }
          for (const file of source.artifactFiles || []) {
            if (use.readFiles?.includes(file)) {
              link(producer, consumer,
                `Explicit local read of this terminal's declared artifact: ${file}`,
                `Explicitly reads declared artifact from ${terminalTitle(producer)}: ${file}`);
            }
            if (use.excerptFiles?.includes(file)) {
              link(producer, consumer,
                `Report cites this terminal's declared artifact: ${file}`,
                `Cites declared artifact from ${terminalTitle(producer)}: ${file}`);
            }
          }
        }
        const aRefs = [...(aa.readFiles || []), ...(aa.excerptFiles || [])];
        const bRefs = new Set([...(ba.readFiles || []), ...(ba.excerptFiles || [])]);
        for (const file of new Set(aRefs)) {
          if (bRefs.has(file)) link(a, b,
            `Both terminals explicitly reference evidence file: ${file}`,
            `Both terminals explicitly reference evidence file: ${file}`);
        }
      }
    }
    relationshipCache.version = state.relationshipVersion;
    relationshipCache.count = processes.size;
    relationshipCache.byKey = byKey;
  }
  return Array.from(relationshipCache.byKey.get(proc.key) || []).map(([key, reasons]) =>
    ({related: processes.get(key), reasons: Array.from(reasons), hidden: state.hidden.has(key)}))
    .filter((link) => link.related)
    .sort((a, b) => a.related.order - b.related.order);
}

function responseFileDestinations(action) {
  return [["Headers (-D)", action.curl?.headerFile], ["Body (-o)", action.curl?.bodyFile]]
    .filter(([, file]) => file && file !== "-" && file !== "/dev/null")
    .map(([label, file]) => ({label, file, declared: Boolean(action.artifacts?.includes(file))}));
}

function keyFor(event) {
  if (event.process_id === null || event.process_id === undefined) return null;
  const conn = event.connection_id;
  if (conn === null || conn === undefined) return null;
  return String(conn) + ":" + String(event.process_id);
}

function createProcess(event, key) {
  const proc = {
    key,
    connectionId: event.connection_id,
    sessionId: event.session_id,
    processId: event.process_id,
    argv: [], cwd: null, reason: null, reasonSource: null, actionInfo: null, order: processes.size,
    startedAt: event.ts || null, endedAt: null,
    tty: null, pipeStdin: null, accepted: false, failed: false,
    exited: false, closed: false, exitCode: null, failureReason: null,
    hasStart: false, events: [], inputEvents: [], gaps: [], lastSeq: null,
    bytes: 0, decoders: new Map(), terminal: new TerminalRendererImpl(),
    lastEventAt: event.ts || null, outputChunks: [], outputBytes: 0,
    searchText: "", searchTruncated: false,
  };
  processes.set(key, proc);
  state.relationshipVersion += 1;
  return proc;
}

function addGap(proc, reason) {
  const detail = String(reason || "Unknown recording gap");
  if (proc) {
    if (!proc.gaps.includes(detail)) proc.gaps.push(detail);
  } else if (!globalGaps.includes(detail)) globalGaps.push(detail);
}

function appendSearchText(proc, text) {
  if (proc.searchTruncated) return;
  const room = MAX_SEARCH_CHARS - proc.searchText.length;
  if (text.length > room) proc.searchTruncated = true;
  proc.searchText += text.slice(0, Math.max(0, room)).toLocaleLowerCase("en-US");
}

function decodeChunk(proc, event, stream) {
  try {
    const binary = atob(String(event.chunk_b64 || ""));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    proc.bytes += bytes.byteLength;
    if (stream !== "stdin") {
      // Same bytes, in the same order, as the /api/raw "output" download.
      proc.outputChunks.push(bytes);
      proc.outputBytes += bytes.byteLength;
    }
    if (!proc.decoders.has(stream)) proc.decoders.set(stream, new TextDecoder("utf-8", {fatal: false}));
    return proc.decoders.get(stream).decode(bytes, {stream: true});
  } catch (_) {
    addGap(proc, "Invalid base64 input/output chunk");
    return "[UNDECODABLE RAW BYTES — inspect the capture file]";
  }
}

function escapeControls(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === "\n" || ch === "\t") { out += ch; continue; }
    if (code < 32 || (code >= 127 && code <= 159) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069) || code === 0x200e || code === 0x200f) {
      out += code <= 255 ? "\\x" + code.toString(16).padStart(2, "0") : "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out;
}

function acceptSequence(proc, event) {
  if (!Number.isInteger(event.seq)) return;
  if (proc.lastSeq !== null && event.seq !== proc.lastSeq + 1) {
    addGap(proc, `Expected sequence ${proc.lastSeq + 1}, received ${event.seq}`);
  }
  proc.lastSeq = event.seq;
}

function recorderStale() {
  return state.heartbeatSeen && !state.recorderStopped &&
    state.lastHeartbeatMs !== null && Date.now() - state.lastHeartbeatMs > 10000;
}

function consume(event) {
  const type = event.type;
  if (type === "recorder_start") {
    state.recorderStarted = true; state.recorderStopped = false;
    state.heartbeatSeen = false; state.lastHeartbeatMs = null;
    return;
  }
  if (type === "recorder_heartbeat") {
    state.heartbeatSeen = true;
    const parsed = Date.parse(event.ts || "");
    state.lastHeartbeatMs = Number.isNaN(parsed) ? Date.now() : parsed;
    return;
  }
  if (type === "recorder_stop") {
    state.recorderStopped = true;
    for (const proc of processes.values()) if (!proc.closed && !proc.failed) addGap(proc, "Recorder stopped without process closure event");
    return;
  }
  if (type === "connection_closed") {
    for (const proc of processes.values()) {
      if (proc.connectionId === event.connection_id && !proc.closed && !proc.failed) {
        addGap(proc, "Connection closed without process closure event");
      }
    }
    return;
  }
  const key = keyFor(event);
  if (type === "gap" && !key) { addGap(null, event.reason || "Unknown recording gap"); return; }
  if (!key) return;
  let proc = processes.get(key);
  if (!proc) proc = createProcess(event, key);
  if (type !== "start" && !proc.hasStart && type !== "gap") addGap(proc, "Missing process start event");
  if (event.session_id) proc.sessionId = event.session_id;
  if (event.ts) proc.lastEventAt = event.ts;

  switch (type) {
    case "start":
      proc.hasStart = true;
      proc.startedAt = event.ts || proc.startedAt;
      proc.argv = Array.isArray(event.argv) ? event.argv.map(String) : [];
      proc.actionInfo = actionFromArgv(proc.argv);
      state.relationshipVersion += 1;
      proc.cwd = event.cwd || null;
      proc.tty = event.tty;
      proc.pipeStdin = event.pipe_stdin;
      if (typeof event.reason === "string" && event.reason.trim()) {
        proc.reason = event.reason.trim();
        proc.reasonSource = "Captured event reason";
      } else {
        const purpose = purposeFromArgv(proc.argv);
        proc.reason = purpose?.value || null;
        proc.reasonSource = purpose?.source || null;
      }
      break;
    case "start_accepted":
      proc.accepted = true;
      break;
    case "start_failed":
      proc.failed = true;
      proc.endedAt = event.ts || proc.endedAt;
      proc.failureReason = event.reason || event.error || "Process failed to launch";
      break;
    case "stdin":
    case "output": {
      if (type === "output") acceptSequence(proc, event);
      const stream = type === "stdin" ? "stdin" : String(event.stream || "stdout");
      const decoded = decodeChunk(proc, event, stream);
      proc.events.push({stream, text: escapeControls(decoded), ts: event.ts || null,
        note: type === "stdin" ? "send request" : null});
      if (type === "output") {
        proc.terminal.write(decoded);
        appendSearchText(proc, decoded);
      } else proc.inputEvents.push({kind: "stdin", text: escapeControls(decoded), ts: event.ts || null});
      break;
    }
    case "stdin_ack":
      proc.events.push({stream: "control", text: event.status === "error" ? "stdin delivery rejected" : "stdin delivery acknowledged", ts: event.ts || null});
      proc.inputEvents.push({kind: "ack", text: event.status === "error" ? "Delivery rejected" : "Delivery acknowledged", ts: event.ts || null});
      break;
    case "terminate_requested":
      proc.events.push({stream: "control", text: "Process termination requested", ts: event.ts || null});
      break;
    case "exited":
      acceptSequence(proc, event);
      proc.exited = true;
      proc.exitCode = event.exit_code ?? null;
      proc.endedAt = event.ts || proc.endedAt;
      break;
    case "closed":
      acceptSequence(proc, event);
      proc.closed = true;
      proc.endedAt = event.ts || proc.endedAt;
      break;
    case "gap":
      addGap(proc, event.reason || "Unknown recording gap");
      break;
  }
}

function lifecycle(proc) {
  if (proc.failed) return "Launch failed";
  if (proc.closed) return "Closed";
  if (proc.exited) return "Exited · awaiting closure";
  if (proc.accepted) return "Running";
  return "Starting";
}

function setBadge(element, text, className) {
  element.textContent = text;
  element.className = "badge" + (className ? " " + className : "");
}

function renderTop() {
  const visible = visibleProcesses();
  let closed = 0;
  let incomplete = 0;
  const stale = recorderStale();
  for (const proc of visible) { if (proc.closed) closed += 1; if (proc.gaps.length || (stale && !proc.closed && !proc.failed)) incomplete += 1; }
  byId("count").textContent = String(visible.length);
  byId("summary").textContent = `${closed} closed · ${incomplete} incomplete`;
  byId("record-state").textContent = state.recorderStopped ? "Recorder stopped" : stale ? "Recorder unresponsive" : state.recorderStarted ? "Recorder running · watching file" : "Waiting for recording";
  byId("clear-all").disabled = !visible.length || !state.hiddenAvailable || state.hiddenBusy;
  const alert = byId("alert");
  if (globalGaps.length) { alert.textContent = "Global recording gap: " + globalGaps.join(" · "); alert.hidden = false; }
  else alert.hidden = true;
}

function statusCategories(proc, stale = recorderStale()) {
  const staleOpen = stale && !proc.closed && !proc.failed;
  const categories = new Set();
  if (proc.failed) categories.add("failed");
  else if (proc.closed) categories.add("closed");
  else if (!proc.gaps.length && !staleOpen) categories.add("running");
  if (proc.gaps.length || staleOpen) categories.add("incomplete");
  if (proc.exitCode !== null && proc.exitCode !== undefined && proc.exitCode !== 0) categories.add("nonzero");
  return categories;
}

function engagementOf(proc) {
  return proc.actionInfo?.engagement || null;
}

// Returns null when the terminal is filtered out, otherwise how the search matched.
function filterMatch(proc, filters, query, stale = recorderStale()) {
  if (filters.status !== "all" && !statusCategories(proc, stale).has(filters.status)) return null;
  if (filters.engagement === "none" ? engagementOf(proc) !== null
    : filters.engagement !== "all" && engagementOf(proc) !== filters.engagement) return null;
  if (!query) return {output: false};
  const presentation = processPresentation(proc);
  const haystack = [commandText(proc), presentation.title, presentation.subtitle, presentation.kind,
    proc.processId, proc.reason || "", state.notes[proc.key] || "",
    proc.actionInfo?.actionId || "", engagementOf(proc) || ""].join(" ").toLocaleLowerCase("en-US");
  if (haystack.includes(query)) return {output: false};
  return filters.searchOutput && proc.searchText.includes(query) ? {output: true} : null;
}

function listedProcesses() {
  const query = byId("search").value.trim().toLocaleLowerCase("en-US");
  const stale = recorderStale();
  const listed = [];
  for (const proc of visibleProcesses()) {
    const match = filterMatch(proc, state.filters, query, stale);
    if (match) listed.push({proc, match});
  }
  return listed;
}

function filtersActive() {
  return state.filters.status !== "all" || state.filters.engagement !== "all" ||
    Boolean(byId("search").value.trim());
}

function renderFilterToggle() {
  const changed = (state.filters.status !== "all") + (state.filters.engagement !== "all") +
    (!state.filters.searchOutput);
  const toggle = byId("toggle-filters");
  toggle.textContent = changed ? `Filters · ${changed}` : "Filters";
  toggle.classList.toggle("active", state.filtersExpanded || changed > 0);
  toggle.setAttribute("aria-expanded", state.filtersExpanded ? "true" : "false");
  byId("filter-panel").hidden = !state.filtersExpanded;
}

function renderEngagementOptions() {
  const select = byId("engagement-filter");
  const engagements = [...new Set(Array.from(processes.values()).map(engagementOf).filter(Boolean))].sort();
  const wanted = ["all", ...engagements, "none"];
  const current = Array.from(select.options).map((option) => option.value);
  if (JSON.stringify(current) === JSON.stringify(wanted)) return;
  select.replaceChildren(...wanted.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "all" ? "All engagements" : value === "none" ? "No engagement" : value;
    return option;
  }));
  if (!wanted.includes(state.filters.engagement)) state.filters.engagement = "all";
  select.value = state.filters.engagement;
}

function renderTabs() {
  const list = byId("process-list");
  list.replaceChildren();
  renderEngagementOptions();
  const fragment = document.createDocumentFragment();
  const stale = recorderStale();
  const listed = listedProcesses();
  byId("filter-row").hidden = !filtersActive();
  renderFilterToggle();
  byId("filter-status").textContent = `Showing ${listed.length} of ${visibleProcesses().length} terminals`;
  for (const {proc, match} of listed) {
    const presentation = processPresentation(proc);
    const button = terminalLink(proc.key);
    button.className = "process-tab" + (state.selected === proc.key ? " selected" : "");
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", state.selected === proc.key ? "true" : "false");
    const top = document.createElement("div"); top.className = "tab-top";
    const title = document.createElement("span"); title.className = "tab-title"; title.textContent = presentation.title;
    const time = document.createElement("span"); time.className = "tab-time"; time.textContent = tabTime(proc.startedAt);
    top.append(title, time);
    const sub = document.createElement("div"); sub.className = "tab-sub"; sub.textContent = presentation.subtitle;
    const bottom = document.createElement("div"); bottom.className = "tab-bottom";
    const life = document.createElement("span"); life.className = "tiny-badge" + (proc.closed ? " closed" : proc.failed ? " failed" : ""); life.textContent = lifecycle(proc);
    bottom.append(life);
    if (proc.actionInfo) {
      const kind = document.createElement("span"); kind.className = "tiny-badge type"; kind.textContent = presentation.kind;
      bottom.append(kind);
    }
    const relatedCount = relatedProcesses(proc).length;
    if (relatedCount) {
      const related = document.createElement("span"); related.className = "tiny-badge related";
      related.textContent = `Related ${relatedCount}`;
      bottom.append(related);
    }
    if (proc.gaps.length || (stale && !proc.closed && !proc.failed)) { const gap = document.createElement("span"); gap.className = "tiny-badge incomplete"; gap.textContent = proc.gaps.length ? "Incomplete" : "Recorder unverified"; bottom.append(gap); }
    if (proc.exitCode !== null && proc.exitCode !== 0) { const code = document.createElement("span"); code.className = "tiny-badge failed"; code.textContent = `Exit ${proc.exitCode}`; bottom.append(code); }
    if (match.output) { const hit = document.createElement("span"); hit.className = "tiny-badge match"; hit.textContent = "Output match"; bottom.append(hit); }
    button.append(top, sub, bottom);

    fragment.append(button);
  }
  list.append(fragment);
  renderTimeline(listed.map((item) => item.proc));
}

// Terminals are real links (#terminal=KEY&view=MODE). A plain click selects in
// place; middle-click, Ctrl/Cmd-click or "Open in new tab" open another tab.
function terminalHash(key, view = state.viewMode) {
  return `#terminal=${encodeURIComponent(key)}&view=${encodeURIComponent(view)}`;
}

function parseTerminalHash(hash) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const view = params.get("view");
  return {key: params.get("terminal") || null,
    view: ["frames", "terminal", "details", "timeline"].includes(view) ? view : null};
}

function terminalLink(key) {
  const link = document.createElement("a");
  link.href = terminalHash(key);
  // Cached panels may outlive a view change; refresh the target before use.
  const refresh = () => { link.href = terminalHash(key); };
  for (const type of ["pointerdown", "focus", "contextmenu"]) link.addEventListener(type, refresh);
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    selectProcess(key);
  });
  return link;
}

function updateLocationHash() {
  if (typeof window === "undefined" || !window.history?.replaceState || !state.selected) return;
  const hash = terminalHash(state.selected);
  if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
}

function selectProcess(key) {
  state.requestedKey = null;
  state.selected = key;
  state.renderedCount = 0;
  state.displayedFrames = 0;
  renderTabs();
  renderDetail(true);
  updateLocationHash();
}

function renderHidden() {
  const toggle = byId("show-hidden");
  toggle.setAttribute("aria-expanded", state.hiddenExpanded ? "true" : "false");
  byId("hidden-count").textContent = String(state.hidden.size);
  byId("hidden-panel").hidden = !state.hiddenExpanded;
  const list = byId("hidden-list");
  list.replaceChildren();
  const fragment = document.createDocumentFragment();
  let displayed = 0;
  for (const proc of sortedProcesses()) {
    if (!state.hidden.has(proc.key)) continue;
    displayed += 1;
    const row = document.createElement("div"); row.className = "hidden-row"; row.setAttribute("role", "listitem");
    const details = document.createElement("div"); details.className = "hidden-row-details";
    const title = document.createElement("strong");
    const presentation = processPresentation(proc);
    title.textContent = presentation.title;
    const purpose = document.createElement("span"); purpose.textContent = presentation.subtitle;
    details.append(title, purpose);
    const relatedCount = relatedProcesses(proc).length;
    if (relatedCount) {
      const related = document.createElement("span"); related.className = "hidden-related";
      related.textContent = `Related ${relatedCount}`;
      details.append(related);
    }
    const restore = document.createElement("button"); restore.type = "button";
    restore.textContent = "Restore to list";
    restore.setAttribute("aria-label", `Restore ${title.textContent} terminal to list`);
    restore.disabled = !state.hiddenAvailable || state.hiddenBusy;
    restore.addEventListener("click", () => changeHidden(proc.key, false));
    row.append(details, restore);
    fragment.append(row);
  }
  list.append(fragment);
  byId("hidden-empty").hidden = displayed !== 0;
}

function frameNode(item) {
  const frame = document.createElement("div"); frame.className = "frame";
  const head = document.createElement("div"); head.className = "frame-head";
  const stream = document.createElement("span"); stream.className = "stream " + item.stream; stream.textContent = item.stream + (item.note ? " · " + item.note : "");
  const time = document.createElement("span"); time.textContent = tabTime(item.ts);
  head.append(stream, time);
  const content = document.createElement("pre"); content.textContent = item.text;
  frame.append(head, content);
  return frame;
}

function renderFrames(proc, reset) {
  const filter = byId("stream-filter").value;
  const output = byId("output");
  if (reset || state.renderedFilter !== filter) {
    output.replaceChildren();
    state.renderedCount = 0;
    state.displayedFrames = 0;
    state.renderedFilter = filter;
  }
  const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 100;
  const fragment = document.createDocumentFragment();
  for (let i = state.renderedCount; i < proc.events.length; i += 1) {
    const item = proc.events[i];
    if (filter === "all" || item.stream === filter) {
      fragment.append(frameNode(item));
      state.displayedFrames += 1;
    }
  }
  output.append(fragment);
  state.renderedCount = proc.events.length;
  byId("no-output").hidden = state.displayedFrames !== 0;
  if (nearBottom) output.scrollTop = output.scrollHeight;
}

function hasSelectedTextInside(selection, pane) {
  return Boolean(selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode &&
    pane.contains(selection.anchorNode) && pane.contains(selection.focusNode));
}

function shouldDeferPanelRender(key, renderedKey, selection, pane) {
  return key === renderedKey && (hasSelectedTextInside(selection, pane) ||
    Boolean(pane?.id && state.activePointerPanes.has(pane.id)));
}

function updatePurposeText(element, value, key, selection) {
  if (shouldDeferPanelRender(key, state.renderedPurposeKey, selection, element)) {
    state.pendingPurposeText = element.textContent === value ? null : value;
    state.pendingPurposeKey = state.pendingPurposeText === null ? null : key;
    return false;
  }
  state.renderedPurposeKey = key;
  state.pendingPurposeText = null;
  state.pendingPurposeKey = null;
  return setTextIfChanged(element, value);
}

function flushPendingPurposeText(element, selection, selectedKey) {
  if (state.pendingPurposeText === null || hasSelectedTextInside(selection, element)) return false;
  const value = state.pendingPurposeText;
  const key = state.pendingPurposeKey;
  state.pendingPurposeText = null;
  state.pendingPurposeKey = null;
  if (key !== selectedKey) return false;
  state.renderedPurposeKey = key;
  return setTextIfChanged(element, value);
}

function updateTerminalText(output, transcript, key, pane, selection) {
  if (state.renderedTerminalKey === key && hasSelectedTextInside(selection, pane)) {
    state.pendingTerminalText = output.textContent === transcript ? null : transcript;
    state.pendingTerminalKey = state.pendingTerminalText === null ? null : key;
    return false;
  }
  state.renderedTerminalKey = key;
  state.pendingTerminalText = null;
  state.pendingTerminalKey = null;
  return setTextIfChanged(output, transcript);
}

function flushPendingTerminalText(output, pane, selection, selectedKey) {
  if (state.pendingTerminalText === null || hasSelectedTextInside(selection, pane)) return false;
  const text = state.pendingTerminalText;
  const key = state.pendingTerminalKey;
  state.pendingTerminalText = null;
  state.pendingTerminalKey = null;
  if (key !== selectedKey) return false;
  state.renderedTerminalKey = key;
  return setTextIfChanged(output, text);
}

function renderTerminal(proc) {
  const screen = byId("terminal-screen");
  const nearBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 100;
  const transcript = "$ " + commandText(proc) + "\n" + proc.terminal.toString();
  const output = byId("terminal-output");
  updateTerminalText(output, transcript, proc.key, screen, window.getSelection());
  byId("terminal-paused").hidden = state.pendingTerminalText === null;
  if (nearBottom) screen.scrollTop = screen.scrollHeight;
  byId("download-output").href = "/api/raw?key=" + encodeURIComponent(proc.key) + "&stream=output";
  const inputPanel = byId("input-panel");
  inputPanel.hidden = proc.inputEvents.length === 0;
  const inputList = byId("input-list");
  inputList.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const entry of proc.inputEvents) {
    const row = document.createElement("div"); row.className = "input-row";
    const label = document.createElement("span"); label.className = "input-label";
    label.textContent = entry.kind === "stdin" ? "stdin request" : "status";
    const time = document.createElement("span"); time.className = "input-time"; time.textContent = tabTime(entry.ts);
    const value = document.createElement("pre"); value.textContent = entry.text;
    row.append(label, time, value);
    fragment.append(row);
  }
  inputList.append(fragment);
}

function setViewMode(mode) {
  state.viewMode = mode;
  const frames = mode === "frames";
  byId("detail").classList.toggle("terminal-mode", mode === "terminal");
  byId("frames-panel").hidden = !frames;
  byId("terminal-panel").hidden = mode !== "terminal";
  byId("details-panel").hidden = mode !== "details";
  byId("timeline-panel").hidden = mode !== "timeline";
  for (const [id, active] of [["view-frames", frames], ["view-terminal", mode === "terminal"],
    ["view-details", mode === "details"], ["view-timeline", mode === "timeline"]]) {
    const button = byId(id);
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  }
  renderDetail(true);
  if (mode === "timeline") renderTabs();
  updateLocationHash();
}

function renderActionSummary(proc) {
  const panel = byId("action-summary");
  const action = proc.actionInfo;
  if (!action) {
    panel.hidden = true;
    state.renderedActionKey = null;
    state.renderedActionSummary = null;
    state.pendingActionSummary = false;
    return;
  }
  const destinations = responseFileDestinations(action);
  const signature = JSON.stringify([proc.key, action.kind, action.actionId, action.innerCommand,
    action.curl, destinations]);
  if (state.renderedActionSummary === signature) {
    state.pendingActionSummary = false;
    return;
  }
  if (shouldDeferPanelRender(proc.key, state.renderedActionKey, window.getSelection(), panel)) {
    state.pendingActionSummary = true;
    return;
  }
  state.pendingActionSummary = false;
  state.renderedActionKey = proc.key;
  state.renderedActionSummary = signature;
  panel.hidden = false;
  setTextIfChanged(byId("action-id"), action.actionId);
  const artifacts = byId("action-artifacts");
  artifacts.replaceChildren();
  const innerCopy = byId("copy-inner-command");
  innerCopy.hidden = !action.innerCommand;
  if (action.kind === "report-step") {
    setTextIfChanged(byId("action-kind"), "Report step command");
    setTextIfChanged(byId("action-inner"), "This command can record a review of the action with the same ID. Inspect its output below for the actual result.");
    setTextIfChanged(byId("action-caution"), "A request mentioned in --decision is a proposal; this report command did not execute it.");
    artifacts.hidden = true;
    return;
  }
  const curl = action.curl;
  setTextIfChanged(byId("action-kind"), curl?.method && curl?.url ? `${curl.method} command to ${curl.url}` : "Captured run-step action");
  setTextIfChanged(byId("action-inner"), action.innerCommand ? "Inner command: " + action.innerCommand : "Inner command not available in the recorded argv.");
  for (const {label, file, declared} of destinations) {
    const row = document.createElement("div"); row.className = "artifact-row";
    const value = document.createElement("span");
    value.textContent = `${label}: ${file}${declared ? " · declared artifact" : ""}`;
    const button = document.createElement("button"); button.type = "button";
    button.textContent = "Copy path";
    button.setAttribute("aria-label", `Copy ${label} file path`);
    button.addEventListener("click", () => copyDetailValue(file, "Evidence path", proc.key));
    row.append(value, button);
    artifacts.append(row);
  }
  artifacts.hidden = !artifacts.childNodes.length;
  setTextIfChanged(byId("action-caution"), artifacts.hidden
    ? "The raw terminal stream below contains captured output, not a separate response file."
    : "curl directed response data to these files. Their contents are not shown as terminal stdout; inspect the saved evidence separately.");
}

function renderRelationships(proc) {
  const links = relatedProcesses(proc);
  const panel = byId("related-panel");
  const signature = JSON.stringify([proc.key, state.hiddenAvailable, state.hiddenBusy,
    links.map((link) => [link.related.key, link.hidden, link.reasons,
      processPresentation(link.related).subtitle, processPresentation(link.related).kind])]);
  if (state.renderedRelationships === signature) {
    state.pendingRelationships = false;
    return;
  }
  if (shouldDeferPanelRender(proc.key, state.renderedRelationshipKey, window.getSelection(), panel)) {
    state.pendingRelationships = true;
    return;
  }
  state.pendingRelationships = false;
  state.renderedRelationshipKey = proc.key;
  state.renderedRelationships = signature;
  panel.hidden = links.length === 0;
  const list = byId("related-list");
  list.replaceChildren();
  for (const link of links) {
    const row = document.createElement("div"); row.className = "related-row";
    const heading = document.createElement("div"); heading.className = "related-row-head";
    let button;
    if (link.hidden) {
      button = document.createElement("button"); button.type = "button";
      button.textContent = `Restore and open ${terminalTitle(link.related)}`;
      button.disabled = !state.hiddenAvailable || state.hiddenBusy;
      button.addEventListener("click", () => changeHidden(link.related.key, false));
    } else {
      button = terminalLink(link.related.key);
      button.className = "open-link";
      button.textContent = `Open ${terminalTitle(link.related)}`;
    }
    const kind = document.createElement("span"); kind.className = "related-kind";
    kind.textContent = processPresentation(link.related).kind;
    heading.append(button, kind);
    if (link.hidden) {
      const hidden = document.createElement("span"); hidden.className = "related-hidden";
      hidden.textContent = "Hidden from list";
      heading.append(hidden);
    }
    const purpose = document.createElement("p"); purpose.className = "related-purpose";
    purpose.textContent = processPresentation(link.related).subtitle;
    const why = document.createElement("ul"); why.className = "related-reasons";
    for (const reason of link.reasons) {
      const item = document.createElement("li"); item.textContent = escapeControls(reason);
      why.append(item);
    }
    row.append(heading, purpose, why);
    list.append(row);
  }
}

function relationshipDetailsText(proc, links = relatedProcesses(proc)) {
  return [`Related terminals for ${terminalTitle(proc)}`, ...links.map((link) => {
    const presentation = processPresentation(link.related);
    return [`${presentation.title} · ${presentation.kind}${link.hidden ? " · hidden from list" : ""}`,
      `Purpose: ${escapeControls(presentation.subtitle)}`,
      ...link.reasons.map((reason) => `- ${escapeControls(reason)}`)].join("\n");
  })].join("\n\n");
}

function renderDetail(reset = false) {
  const proc = state.hidden.has(state.selected) ? null : processes.get(state.selected);
  byId("empty").hidden = Boolean(proc);
  byId("detail").hidden = !proc;
  if (!proc) {
    byId("empty-title").textContent = state.hidden.size ? "No visible terminals" : "No terminal recordings yet";
    byId("empty-message").textContent = state.hidden.size
      ? "Restore terminals from Hidden terminals on the left."
      : "New processes appear here. This viewer does not control the Codex session.";
    return;
  }
  byId("hide-selected").disabled = !state.hiddenAvailable || state.hiddenBusy;
  byId("copy-command").disabled = proc.argv.length === 0;
  byId("copy-purpose").disabled = !proc.reason && !state.notes[proc.key];
  if (state.copyProcessKey !== proc.key) {
    state.copyProcessKey = proc.key;
    byId("copy-status").textContent = "";
  }
  const presentation = processPresentation(proc);
  setTextIfChanged(byId("process-title"), presentation.title);
  updatePurposeText(byId("process-purpose"), presentation.subtitle, proc.key, window.getSelection());
  const staleOpen = recorderStale() && !proc.closed && !proc.failed;
  setBadge(byId("life-badge"), lifecycle(proc), proc.closed ? "closed" : proc.failed ? "failed" : "");
  setBadge(byId("integrity-badge"), proc.gaps.length ? "Incomplete recording" : staleOpen ? "Recorder unverified" : proc.closed ? "Recording complete" : "Recording in progress", proc.gaps.length || staleOpen ? "incomplete" : "");
  const executedCommand = "$ " + commandText(proc);
  setTextIfChanged(byId("command"), executedCommand);
  setTextIfChanged(byId("command-line"), executedCommand);
  const summary = [proc.exitCode === null ? null : `Exit ${proc.exitCode}`,
    proc.startedAt ? `Started ${tabTime(proc.startedAt)}` : null,
    proc.endedAt ? `Ended ${tabTime(proc.endedAt)}` : null,
    `${proc.bytes.toLocaleString("en-GB")} bytes`].filter(Boolean).join(" · ");
  setTextIfChanged(byId("summary-meta"), summary);
  const relatedCount = relatedProcesses(proc).length;
  setTextIfChanged(byId("view-details"), relatedCount ? `Details · ${relatedCount} related` : "Details");
  renderActionSummary(proc);
  renderRelationships(proc);
  const humanNote = state.notes[proc.key] || "";
  const explanation = proc.reason || humanNote || "No reason recorded. Add your own note below.";
  const provenance = proc.reason ? proc.reasonSource : humanNote ? "Your note · not in capture" : "Reason";
  byId("reason-source").textContent = provenance;
  byId("reason").textContent = escapeControls(explanation);
  byId("terminal-reason-source").textContent = provenance;
  byId("terminal-reason").textContent = byId("reason").textContent;
  const noteInput = byId("human-note");
  const noteDraft = Object.prototype.hasOwnProperty.call(state.noteDrafts, proc.key)
    ? state.noteDrafts[proc.key] : humanNote;
  const switchedNoteProcess = state.noteProcessKey !== proc.key;
  if (switchedNoteProcess || noteInput.value !== noteDraft) {
    noteInput.value = noteDraft;
    state.noteProcessKey = proc.key;
    if (switchedNoteProcess) byId("note-status").textContent = "";
  }
  updateNoteButton();
  byId("started").textContent = shortTime(proc.startedAt);
  byId("ended").textContent = shortTime(proc.endedAt);
  byId("pid").textContent = String(proc.processId);
  byId("cwd").textContent = proc.cwd ? escapeControls(proc.cwd) : "—";
  byId("exit-code").textContent = proc.exitCode === null ? "—" : String(proc.exitCode);
  byId("byte-count").textContent = proc.bytes.toLocaleString("en-GB");
  if (proc.lineCountEvents !== proc.events.length) {
    proc.lineCountEvents = proc.events.length;
    proc.lineCount = proc.outputBytes ? outputLines(proc).length : 0;
  }
  byId("export-total").textContent = `of ${proc.lineCount.toLocaleString("en-GB")} output lines`;
  byId("failure-panel").hidden = !proc.failed;
  byId("failure-reason").textContent = proc.failureReason ? escapeControls(String(proc.failureReason)) : "—";
  const gapPanel = byId("gap-panel");
  gapPanel.hidden = proc.gaps.length === 0 && !staleOpen;
  byId("gap-title").textContent = proc.gaps.length ? "Incomplete recording" : "Recorder unverified";
  const gapList = byId("gap-list"); gapList.replaceChildren();
  for (const reason of proc.gaps) { const li = document.createElement("li"); li.textContent = reason; gapList.append(li); }
  if (staleOpen) { const li = document.createElement("li"); li.textContent = "The recorder's last heartbeat is over 10 seconds old. This warning clears if it reconnects."; gapList.append(li); }
  const stream = byId("stream-filter").value;
  const rawLink = byId("download-raw");
  rawLink.hidden = stream === "all";
  if (stream !== "all") {
    rawLink.href = "/api/raw?key=" + encodeURIComponent(proc.key) + "&stream=" + encodeURIComponent(stream);
    rawLink.textContent = stream + " raw bytes";
  }
  if (state.viewMode === "frames") renderFrames(proc, reset);
  else if (state.viewMode === "terminal") renderTerminal(proc);
}

function timeMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isNaN(parsed) ? null : parsed;
}

// Pure layout: each terminal becomes a bar from its first to its last recorded
// event. A terminal still open while the recorder runs extends to nowMs.
function timelineLayout(procs, nowMs, recorderLive = false, maxTicks = 120) {
  const spans = [];
  for (const proc of procs) {
    const start = timeMs(proc.startedAt);
    if (start === null) continue;
    let end = timeMs(proc.endedAt) ?? timeMs(proc.lastEventAt) ?? start;
    const open = !proc.closed && !proc.failed && !proc.gaps.length;
    if (open && recorderLive) end = Math.max(end, nowMs);
    spans.push({proc, start, end: Math.max(start, end), open});
  }
  if (!spans.length) return {startMs: null, endMs: null, lanes: []};
  const startMs = Math.min(...spans.map((span) => span.start));
  const endMs = Math.max(startMs + 1000, ...spans.map((span) => span.end));
  const pct = (value) => ((value - startMs) / (endMs - startMs)) * 100;
  spans.sort((a, b) => a.start - b.start || a.proc.order - b.proc.order);
  const lanes = spans.map(({proc, start, end, open}) => {
    const ticks = new Set();
    for (const item of proc.events) {
      if (item.stream === "control") continue;
      const at = timeMs(item.ts);
      if (at !== null) ticks.add(Math.round(pct(at) / 100 * maxTicks));
    }
    return {key: proc.key, start, end, open, leftPct: pct(start), widthPct: Math.max(pct(end) - pct(start), 0),
      ticks: Array.from(ticks).sort((a, b) => a - b).map((tick) => tick / maxTicks * 100)};
  });
  return {startMs, endMs, lanes};
}

function overlappingKeys(layout, key) {
  const lane = layout.lanes.find((item) => item.key === key);
  if (!lane) return new Set();
  return new Set(layout.lanes.filter((other) => other.key !== key &&
    other.start <= lane.end && lane.start <= other.end).map((other) => other.key));
}

function renderTimeline(procs) {
  const panel = byId("timeline-panel");
  panel.hidden = state.viewMode !== "timeline";
  if (panel.hidden) return;
  const live = state.recorderStarted && !state.recorderStopped && !recorderStale();
  const layout = timelineLayout(procs, Date.now(), live);
  const lanesNode = byId("timeline-lanes");
  lanesNode.replaceChildren();
  byId("timeline-empty").hidden = layout.lanes.length !== 0;
  const axis = byId("timeline-axis");
  axis.replaceChildren();
  if (!layout.lanes.length) return;
  for (let i = 0; i <= 4; i += 1) {
    const tick = document.createElement("span");
    tick.textContent = tabTime(new Date(layout.startMs + (layout.endMs - layout.startMs) * i / 4).toISOString());
    tick.style.left = `${i * 25}%`;
    axis.append(tick);
  }
  const related = new Set(relatedProcesses(processes.get(state.selected) || {key: null}).map((link) => link.related.key));
  const overlapping = overlappingKeys(layout, state.selected);
  byId("timeline-summary").textContent = overlapping.size
    ? `${terminalTitle(processes.get(state.selected))} overlaps ${overlapping.size} other terminal${overlapping.size === 1 ? "" : "s"} in time.`
    : "Bars run from each terminal's first to last recorded event. Click one to open it.";
  const fragment = document.createDocumentFragment();
  for (const lane of layout.lanes) {
    const proc = processes.get(lane.key);
    const row = terminalLink(lane.key);
    row.className = "timeline-lane" + (lane.key === state.selected ? " selected" : "") +
      (related.has(lane.key) ? " related" : "") + (overlapping.has(lane.key) ? " overlapping" : "");
    const category = proc.failed ? "failed" : proc.gaps.length ? "incomplete"
      : proc.closed ? (proc.exitCode !== null && proc.exitCode !== 0 ? "nonzero" : "closed") : "running";
    const label = document.createElement("span"); label.className = "timeline-label";
    label.textContent = terminalTitle(proc);
    const kind = document.createElement("small"); kind.textContent = processPresentation(proc).kind;
    label.append(kind);
    const track = document.createElement("span"); track.className = "timeline-track";
    const bar = document.createElement("span"); bar.className = "timeline-bar " + category;
    bar.style.left = `${lane.leftPct}%`;
    bar.style.width = `max(6px, ${lane.widthPct}%)`;
    track.append(bar);
    for (const at of lane.ticks) {
      const mark = document.createElement("span"); mark.className = "timeline-tick";
      mark.style.left = `${at}%`;
      track.append(mark);
    }
    const ended = lane.open ? "still open" : tabTime(new Date(lane.end).toISOString());
    row.title = `${terminalTitle(proc)} · ${lifecycle(proc)} · ${tabTime(new Date(lane.start).toISOString())}–${ended}`;
    row.setAttribute("aria-label", row.title);
    row.append(label, track);

    fragment.append(row);
  }
  lanesNode.append(fragment);
}

function markdownFence(text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function outputLines(proc) {
  const lines = proc.terminal.toString().split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function sha256Hex(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", joined);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Builds a report-ready Markdown block from recorded data only. outputSha256 is
// the hash of the raw output bytes (stdout, stderr and PTY in arrival order).
function exportMarkdown(proc, {fromLine = null, toLine = null, outputSha256 = null} = {}) {
  const presentation = processPresentation(proc);
  const lines = outputLines(proc);
  const total = proc.outputBytes ? lines.length : 0;
  const first = Math.min(Math.max(1, fromLine || 1), Math.max(total, 1));
  const last = Math.max(first, Math.min(toLine || total, total));
  const selected = total ? lines.slice(first - 1, last) : [];
  const command = commandText(proc);
  const fence = markdownFence(command);
  const out = [`### ${presentation.title} · ${presentation.kind}`, ""];
  if (proc.reason) out.push(`- **${proc.reasonSource}:** ${escapeControls(proc.reason)}`);
  else if (state.notes[proc.key]) out.push(`- **Your note (not in capture):** ${escapeControls(state.notes[proc.key])}`);
  else out.push("- **Purpose:** not recorded");
  if (proc.actionInfo) out.push(`- **Engagement / action ID:** ${proc.actionInfo.engagement} / ${proc.actionInfo.actionId}`);
  out.push(`- **Working directory:** ${proc.cwd ? escapeControls(proc.cwd) : "not recorded"}`);
  out.push(`- **Started:** ${proc.startedAt || "not recorded"}`);
  out.push(`- **Ended:** ${proc.endedAt || "not recorded"}`);
  out.push(`- **Status:** ${lifecycle(proc)}${proc.exitCode === null ? "" : `, exit code ${proc.exitCode}`}` +
    (proc.gaps.length ? " · incomplete recording" : ""));
  out.push(`- **Raw output:** ${proc.outputBytes} bytes` +
    (outputSha256 ? `, SHA-256 \`${outputSha256}\` (stdout, stderr and PTY bytes in arrival order)` : ""));
  out.push(`- **Capture key:** \`${escapeControls(proc.key)}\``);
  for (const {label, file} of proc.actionInfo ? responseFileDestinations(proc.actionInfo) : []) {
    out.push(`- **${label} saved to file (not shown below):** ${escapeControls(file)}`);
  }
  for (const gap of proc.gaps) out.push(`- **Recording gap:** ${escapeControls(gap)}`);
  out.push("", "**Command**", "", fence + "sh", command, fence, "");
  if (selected.length) {
    const text = selected.join("\n");
    const outputFence = markdownFence(text);
    out.push(`**Output** (terminal view, lines ${first}–${last} of ${total})`, "", outputFence + "text", text, outputFence, "");
  } else out.push("**Output:** no output recorded", "");
  out.push("_Exported by the local terminal viewer from events.jsonl. The output is a readable " +
    "terminal reconstruction; the raw journal and byte download remain the evidence._");
  return out.join("\n") + "\n";
}

function exportRange() {
  const read = (id) => {
    const value = Number.parseInt(byId(id).value, 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  };
  return {fromLine: read("export-from"), toLine: read("export-to")};
}

async function selectedExport() {
  const proc = processes.get(state.selected);
  if (!proc) return null;
  let outputSha256 = null;
  try { outputSha256 = await sha256Hex(proc.outputChunks); } catch (_) { /* Hash needs a secure context. */ }
  return {proc, text: exportMarkdown(proc, {...exportRange(), outputSha256})};
}

async function copySelectedMarkdown() {
  const result = await selectedExport();
  if (result) await copyDetailValue(result.text, "Markdown", result.proc.key);
}

async function downloadSelectedMarkdown() {
  const result = await selectedExport();
  if (!result) return;
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([result.text], {type: "text/markdown;charset=utf-8"}));
  const id = result.proc.actionInfo?.actionId || String(result.proc.processId);
  link.href = url;
  link.download = `terminal-${result.proc.order + 1}-${id.replace(/[^A-Za-z0-9._-]+/g, "_")}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (state.selected === result.proc.key) byId("copy-status").textContent = "Markdown downloaded";
}

function render() {
  // A terminal named in the URL is selected once its events have been read.
  if (state.requestedKey && processes.has(state.requestedKey) && !state.hidden.has(state.requestedKey)) {
    state.selected = state.requestedKey;
    state.requestedKey = null;
    state.renderedCount = 0;
    state.displayedFrames = 0;
  }
  if (!state.selected || state.hidden.has(state.selected) || !processes.has(state.selected)) {
    state.selected = visibleProcesses()[0]?.key || null;
  }
  renderTop(); renderTabs(); renderHidden(); renderDetail();
  if (!state.requestedKey) updateLocationHash();
}

function shouldScopeSelectAll(event, pane, activeElement, selection) {
  if (!pane || String(event.key).toLowerCase() !== "a" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  const tag = String(activeElement?.tagName || "").toLowerCase();
  if (["input", "textarea", "select", "button", "a"].includes(tag) || activeElement?.isContentEditable) return false;
  if (activeElement === pane || (activeElement && pane.contains(activeElement))) return true;
  if (activeElement && !["body", "html"].includes(tag)) return false;
  return Boolean(selection?.anchorNode && selection?.focusNode &&
    pane.contains(selection.anchorNode) && pane.contains(selection.focusNode));
}

function selectAllInPane(event, pane, activeElement, selection, doc) {
  if (!selection || !shouldScopeSelectAll(event, pane, activeElement, selection)) return false;
  event.preventDefault();
  pane.focus({preventScroll: true});
  const range = doc.createRange();
  range.selectNodeContents(pane);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function selectAllInAvailablePane(event, panes, activeElement, selection, doc) {
  for (const pane of panes) {
    if (pane && (activeElement === pane || (activeElement && pane.contains(activeElement))) &&
        selectAllInPane(event, pane, activeElement, selection, doc)) return true;
  }
  for (const pane of panes) {
    if (pane && selectAllInPane(event, pane, activeElement, selection, doc)) return true;
  }
  return false;
}

async function copyText(value, clipboard, doc, selection) {
  if (clipboard?.writeText) {
    try { await clipboard.writeText(value); return true; } catch (_) { /* Fall back to the browser copy command. */ }
  }
  const previousFocus = doc.activeElement;
  const savedRanges = [];
  if (selection) for (let i = 0; i < selection.rangeCount; i += 1) savedRanges.push(selection.getRangeAt(i).cloneRange());
  const input = doc.createElement("textarea");
  input.value = value;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.top = "-9999px";
  doc.body.append(input);
  let copied = false;
  try {
    if (input.focus) input.focus({preventScroll: true});
    input.select();
    copied = Boolean(doc.execCommand("copy"));
  } catch (_) { /* The caller shows manual-copy feedback. */ }
  finally {
    input.remove();
    if (previousFocus?.focus) {
      try { previousFocus.focus({preventScroll: true}); } catch (_) { try { previousFocus.focus(); } catch (_) {} }
    }
    if (selection) {
      try {
        selection.removeAllRanges();
        for (const range of savedRanges) selection.addRange(range);
      } catch (_) { /* A concurrent render may have detached the old range. */ }
    }
  }
  return copied;
}

async function copyDetailValue(value, label, key) {
  const copied = await copyText(value, navigator.clipboard, document, window.getSelection());
  if (state.selected === key) byId("copy-status").textContent = copied
    ? `${label} copied`
    : `Copy failed. Select the ${label.toLowerCase()} text and copy it manually.`;
  return copied;
}

async function copySelectedCommand() {
  const key = state.selected;
  const proc = processes.get(key);
  if (!proc?.argv.length) return;
  await copyDetailValue(commandText(proc), "Command", key);
}

async function copySelectedPurpose() {
  const key = state.selected;
  const proc = processes.get(key);
  if (!proc?.reason && !state.notes[key]) return;
  await copyDetailValue(byId("process-purpose").textContent, "Purpose", key);
}

async function copySelectedInnerCommand() {
  const key = state.selected;
  const innerCommand = processes.get(key)?.actionInfo?.innerCommand;
  if (innerCommand) await copyDetailValue(innerCommand, "Inner command", key);
}

async function copySelectedRelationships() {
  const key = state.selected;
  const proc = processes.get(key);
  if (proc && relatedProcesses(proc).length) {
    await copyDetailValue(relationshipDetailsText(proc), "Relationship details", key);
  }
}

function flushPendingPanels(selection) {
  const proc = state.hidden.has(state.selected) ? null : processes.get(state.selected);
  if (!proc) return;
  if (state.pendingActionSummary && !state.activePointerPanes.has("action-summary") &&
      !hasSelectedTextInside(selection, byId("action-summary"))) {
    renderActionSummary(proc);
  }
  if (state.pendingRelationships && !state.activePointerPanes.has("related-panel") &&
      !hasSelectedTextInside(selection, byId("related-panel"))) {
    renderRelationships(proc);
  }
}

async function poll() {
  if (state.busy || state.halted) return;
  state.busy = true;
  let delay = 650;
  try {
    const response = await fetch("/api/events?cursor=" + state.cursor, {cache: "no-store"});
    if (response.status === 409) {
      addGap(null, "Capture file shrank; earlier events can no longer be verified");
      state.halted = true;
      renderTop();
      throw new Error("Capture file shrank");
    }
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    for (const event of data.events) consume(event);
    state.cursor = data.cursor;
    await syncHidden();
    await syncNotes();
    const nowStale = recorderStale();
    if (data.events.length || nowStale !== state.lastStale) render();
    state.lastStale = nowStale;
    const status = byId("viewer-state"); status.textContent = "Viewer connected"; status.className = "state-dot online";
    delay = data.cursor < data.size ? 20 : 650;
  } catch (error) {
    const status = byId("viewer-state"); status.textContent = "Viewer disconnected"; status.className = "state-dot error";
    const nowStale = recorderStale();
    if (nowStale !== state.lastStale) render();
    state.lastStale = nowStale;
    delay = 1500;
  } finally {
    state.busy = false;
    if (!state.halted) window.setTimeout(poll, delay);
  }
}

async function init() {
  try {
    const response = await fetch("/api/meta", {cache: "no-store"});
    const meta = await response.json();
    byId("demo-banner").hidden = !meta.demo;
  } catch (_) { /* Polling still reports the connection state. */ }
  try {
    const storedOrder = window.localStorage.getItem("terminal-web-sort-order");
    if (storedOrder === "oldest") state.sortOrder = "oldest";
  } catch (_) { /* Private browsing may disable storage. */ }
  byId("sort-order").value = state.sortOrder;
  const fromHash = parseTerminalHash(window.location.hash);
  state.requestedKey = fromHash.key;
  if (fromHash.view) setViewMode(fromHash.view);
  window.addEventListener("hashchange", () => {
    const next = parseTerminalHash(window.location.hash);
    if (next.view && next.view !== state.viewMode) setViewMode(next.view);
    if (next.key && next.key !== state.selected) { state.requestedKey = next.key; render(); }
  });
  byId("search").addEventListener("input", renderTabs);
  byId("status-filter").addEventListener("change", (event) => { state.filters.status = event.target.value; renderTabs(); });
  byId("engagement-filter").addEventListener("change", (event) => { state.filters.engagement = event.target.value; renderTabs(); });
  byId("search-output").addEventListener("change", (event) => { state.filters.searchOutput = event.target.checked; renderTabs(); });
  byId("reset-filters").addEventListener("click", () => {
    state.filters.status = "all"; state.filters.engagement = "all"; state.filters.searchOutput = true;
    byId("search-output").checked = true;
    byId("status-filter").value = "all"; byId("engagement-filter").value = "all"; byId("search").value = "";
    renderTabs();
  });
  byId("toggle-filters").addEventListener("click", () => {
    state.filtersExpanded = !state.filtersExpanded;
    renderFilterToggle();
  });
  byId("toggle-export").addEventListener("click", () => {
    state.exportExpanded = !state.exportExpanded;
    byId("export-panel").hidden = !state.exportExpanded;
    byId("toggle-export").setAttribute("aria-expanded", state.exportExpanded ? "true" : "false");
    byId("toggle-export").classList.toggle("active", state.exportExpanded);
  });
  byId("copy-markdown").addEventListener("click", copySelectedMarkdown);
  byId("download-markdown").addEventListener("click", downloadSelectedMarkdown);
  byId("sort-order").addEventListener("change", (event) => {
    state.sortOrder = event.target.value === "oldest" ? "oldest" : "newest";
    try { window.localStorage.setItem("terminal-web-sort-order", state.sortOrder); } catch (_) { /* Keep in memory. */ }
    render();
  });
  byId("stream-filter").addEventListener("change", () => renderDetail(true));
  byId("view-frames").addEventListener("click", () => setViewMode("frames"));
  byId("view-terminal").addEventListener("click", () => setViewMode("terminal"));
  byId("view-details").addEventListener("click", () => setViewMode("details"));
  byId("view-timeline").addEventListener("click", () => setViewMode("timeline"));
  byId("show-hidden").addEventListener("click", () => {
    state.hiddenExpanded = !state.hiddenExpanded;
    renderHidden();
  });
  byId("hide-selected").addEventListener("click", () => {
    if (state.selected) changeHidden(state.selected, true);
  });
  byId("copy-purpose").addEventListener("click", copySelectedPurpose);
  byId("copy-command").addEventListener("click", copySelectedCommand);
  byId("copy-inner-command").addEventListener("click", copySelectedInnerCommand);
  byId("copy-relationships").addEventListener("click", copySelectedRelationships);
  for (const id of ["process-purpose", "action-summary", "related-panel", "command", "output", "terminal-screen"]) {
    const pane = byId(id);
    pane.addEventListener("pointerdown", (event) => {
      if (["process-purpose", "action-summary", "related-panel"].includes(id)) state.activePointerPanes.add(id);
      if (event.target.closest?.("button, a, input, textarea, select")) return;
      pane.focus({preventScroll: true});
    });
  }
  const releasePointerPanes = () => {
    if (!state.activePointerPanes.size) return;
    window.setTimeout(() => {
      state.activePointerPanes.clear();
      const selection = window.getSelection();
      if (state.pendingPurposeText !== null) {
        flushPendingPurposeText(byId("process-purpose"), selection, state.selected);
      }
      if (state.pendingActionSummary || state.pendingRelationships) flushPendingPanels(selection);
    }, 0);
  };
  document.addEventListener("pointerup", releasePointerPanes);
  document.addEventListener("pointercancel", releasePointerPanes);
  window.addEventListener("blur", releasePointerPanes);
  document.addEventListener("keydown", (event) => {
    const panes = [byId("process-purpose"), byId("action-summary"), byId("related-panel"),
      byId("command"), byId("output"), byId("terminal-screen")];
    selectAllInAvailablePane(event, panes, document.activeElement, window.getSelection(), document);
  });
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (state.pendingPurposeText !== null && !state.activePointerPanes.has("process-purpose")) {
      flushPendingPurposeText(byId("process-purpose"), selection, state.selected);
    }
    if (state.pendingTerminalText !== null) {
      flushPendingTerminalText(byId("terminal-output"), byId("terminal-screen"), selection, state.selected);
      byId("terminal-paused").hidden = state.pendingTerminalText === null;
    }
    if (state.pendingActionSummary || state.pendingRelationships) flushPendingPanels(selection);
  });
  byId("clear-all").addEventListener("click", clearAllVisible);
  byId("human-note").addEventListener("input", () => {
    if (state.selected) {
      const value = byId("human-note").value;
      if (value === (state.notes[state.selected] || "")) delete state.noteDrafts[state.selected];
      else state.noteDrafts[state.selected] = value;
    }
    byId("note-status").textContent = "";
    updateNoteButton();
  });
  byId("save-note").addEventListener("click", saveNote);
  await syncHidden(true);
  await syncNotes(true);
  renderTop();
  poll();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {consume, lifecycle, recorderStale, processes, state, keyFor, setHiddenKeys, visibleProcesses,
    sortedProcesses, purposeFromArgv, shellWords, setNotes, applyNotesSnapshot,
    confirmClearAll, visibleKeySnapshot, bulkHideBody, keyBatches, hideKeyBatches,
    simpleCommandWords, curlDetails, actionFromArgv, normalizeEvidencePath, readEvidenceFiles,
    terminalTitle, recordedPurpose, processPresentation, relatedProcesses,
    responseFileDestinations, relationshipDetailsText, renderActionSummary, renderRelationships,
    shouldScopeSelectAll, selectAllInPane, selectAllInAvailablePane, copyText, setTextIfChanged,
    hasSelectedTextInside, shouldDeferPanelRender, updatePurposeText, flushPendingPurposeText,
    updateTerminalText, flushPendingTerminalText, statusCategories, filterMatch, timelineLayout,
    overlappingKeys, terminalHash, parseTerminalHash, markdownFence, outputLines, sha256Hex, exportMarkdown};
} else {
  init();
}
