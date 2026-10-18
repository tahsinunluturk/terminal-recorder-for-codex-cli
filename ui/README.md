# Local terminal viewer

Browser view for the recorder's `events.jsonl`. It does not connect to a
running Codex CLI or start any command.

```bash
python3 ui/server.py --capture-dir /private/capture --port 8765
```

Open `http://127.0.0.1:8765/` locally. The server binds only `127.0.0.1`,
serves no remote assets, and never changes the capture file. Use `--demo` to
label a synthetic fixture prominently. Closing or refreshing the browser has no
effect on the recorder or the CLI.

## Terminals and status

Each `(connection_id, process_id)` gets its own entry, titled **Terminal #N** in
first-seen order. Sorting, hiding, restoring and reloading never change that
number. The list can be sorted newest or oldest first; the browser remembers the
choice when local storage is available.

`process/closed` produces **Closed**, and the terminal stays in the list. A
sequence gap, or a connection or recorder ending before process closure,
produces **Incomplete recording**. `start_failed` is shown as **Launch failed**.
If heartbeats have been seen and then stop for more than 10 seconds, open
processes temporarily show **Recorder unverified**; a new heartbeat clears it.

## Purpose and notes

The line under the title shows a `reason` recorded in the start event, or the
`--purpose` argument of a recognised step wrapper (see below), including one
inside a simple `sh -c`/`bash -lc` command. A `report-step` purpose is labelled
**Reported purpose**, because it describes the step being reported. Without
either, the terminal shows **Purpose not recorded**; the viewer never guesses a
purpose from the command. **Your note** lets you add context; it is stored in a
separate sidecar file, labelled **Your note (not in capture)**, searchable, and never
written into the journal. A recorded reason takes priority over a note.

## Views

The selected terminal shows its title, purpose, one-line command, exit code,
times and byte count above four tabs:

- **Event stream**: stdout, stderr, PTY and requested stdin in arrival order,
  with control characters shown visibly. A stdin acknowledgment is listed
  separately, because the request alone does not prove delivery.
- **Raw terminal**: a continuous terminal-like view. The first `$ ...` line is
  reconstructed from the recorded `argv`. The renderer handles CR/LF,
  backspace, tabs, basic line erase and SGR colours; other controls appear as
  visible annotations. It is not a full terminal emulator, so screen
  applications and wrapping may differ.
- **Details**: full command, reason, your note, working directory, process ID,
  times, exit code and byte count, plus the step summary and related terminals
  for step wrappers.
- **Timeline**: every listed terminal as a bar from its first to its last
  recorded event, with a tick per output or stdin event. Time overlaps with the
  selected terminal are highlighted. An open terminal extends to the current
  time only while the recorder is running.

On screens wider than 800 px the page fits the browser window, and the list and
the selected terminal scroll independently.

## Search and filters

Search matches the command, purpose, note, action ID and engagement, and by
default also the decoded output (up to 2 MiB of text per terminal). A terminal found only through its
output gets an **Output match** badge. **Filters** opens a status filter
(running, closed, incomplete, launch failed, non-zero exit), an engagement
filter for step wrappers, and the option to leave output out of the search.
Filters change only the list and timeline.

## Copy, export and download

- **Copy command** copies the reconstructed shell command without the `$`
  prompt. **Copy purpose** copies the displayed purpose with its label.
- **Export Markdown** copies or downloads the selected terminal as Markdown:
  purpose, engagement and action ID, working directory, times, status, recording
  gaps, curl response-file destinations (not their contents), the command and an
  optional range of output lines, plus the SHA-256 of the raw output bytes
  (stdout, stderr and PTY in arrival order).
- **Download raw output** gives the exact output bytes; a stream filter gives
  the bytes of one stream. **Capture JSONL** downloads the whole journal, which
  keeps stream boundaries, timestamps, sequence numbers and lifecycle events.

Click or tab into the purpose, command, event stream or raw terminal pane and
press Ctrl+A (Cmd+A on macOS) to select only that pane. While text is selected,
live updates to that pane wait until the selection clears.

## Step wrappers

For `run-step`, `run-service` and `report-step` commands (described in the
[examples/step-wrappers](../examples/step-wrappers/README.md)), the viewer also shows:

- A summary with the action ID and inner command. For `curl` it shows the URL,
  a **GET** badge when the request is a plain GET, and the files that `-D` and
  `-o` wrote to, marked when they were declared with `--artifact`. It does not
  read those files or present them as output.
- **Related terminals**, linking a `run-step` and the `report-step` with the
  same engagement and action ID, a declared artifact and a later `--offline`
  step that reads it with `cat`, `nl`, `sed -n`, `head`, `tail` or `wc`, a
  report `--excerpt` that cites an artifact or `action=ID`, and two terminals
  that read the same file. Each link says why it exists, and a hidden terminal
  can be restored from it. Similar URLs, file names or text in `--decision`
  never create links, and a link does not show that a command succeeded.
- **Copy inner command**, **Copy path** and **Copy relationship details**.

## Hiding terminals

**Remove from list** hides the selected terminal, including a running one,
without stopping it or erasing anything. **Hidden terminals** lists hidden
entries with **Restore to list**. **Hide all** asks for confirmation and hides
exactly the terminals visible when the dialog opened. These choices live in a private `.terminal-viewer-hidden.json` sidecar,
so they survive reloads and are shared by browser tabs viewing the same
capture.

## Links

Terminals in the list and timeline bars are real links
(`#terminal=<process key>&view=<tab>`). A normal click selects in place; a
middle-click, Ctrl/Cmd+click or **Open in new tab** opens another browser tab.
The address bar always reflects the selected terminal.
