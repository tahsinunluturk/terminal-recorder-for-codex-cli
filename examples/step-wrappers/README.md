# Step wrappers

Small scripts that run a command as a named step with a stated purpose. When
Codex runs commands through them, the viewer shows:

- the purpose of each command under its title
- a summary with the step ID, the real command and, for `curl`, the URL and the
  files the response was saved to
- **Related terminals**: a step, a later step that reads its saved file, and
  the report that cites them are linked to each other
- an **Engagement** filter and search by step ID

The viewer only reads the command line, so these scripts are one way to do it;
any script with the same names and arguments works.

| Path | What it is |
| --- | --- |
| `install.sh` | Adds everything below to a project in one step |
| `tools/run-step` | Runs one command as a named step and logs it |
| `tools/run-service` | Runs a server or other long-lived command in the foreground |
| `tools/report-step` | Records what a step showed, quoting saved evidence |
| `AGENTS.md` | Instructions for Codex, appended to your project's `AGENTS.md` |
| `example-engagement/` | What the files look like after three real steps |

## Install into a project

```bash
examples/step-wrappers/install.sh ~/my-project            # engagement name taken from the folder name
examples/step-wrappers/install.sh ~/my-project webapp     # or choose one
```

This creates:

```
my-project/
├── AGENTS.md                    # instructions appended (created if missing)
├── tools/
│   ├── run-step
│   ├── run-service
│   └── report-step
└── engagements/
    └── webapp/
        ├── evidence/            # saved responses and other files go here
        ├── activity.md          # one line per step, written by run-step/run-service
        └── report.md            # written by report-step
```

`activity.md` and `report.md` appear after the first step. The installer never
overwrites an existing file, and running it again changes nothing. Then start a
recorded session from the project folder:

```bash
cd ~/my-project
/path/to/terminal-recorder-for-codex-cli/start-recorded-codex
```

## Arguments

```bash
run-step    ENGAGEMENT ACTION_ID --purpose "why" [--artifact FILE]... [--offline] -- COMMAND...
run-service ENGAGEMENT SERVICE_ID --purpose "why" -- COMMAND...
report-step ENGAGEMENT ACTION_ID --purpose "why" --observed "what" [--excerpt FILE@FROM:TO]... [--excerpt action=ID@FROM:TO]...
```

- `ENGAGEMENT` groups the work, for example `webapp`. `ACTION_ID` names one
  step, for example `health-01`.
- `--artifact` declares a file the command saves. Keep saved files under
  `engagements/ENGAGEMENT/evidence/`; only those are linked.
- `--offline` marks a step that only reads saved files with `cat`, `nl -ba`,
  `sed -n 'N,Mp'`, `head`, `tail` or `wc`.
- `report-step` uses the same `ACTION_ID` as the step it reports on.
  `evidence/NAME` is short for `engagements/ENGAGEMENT/evidence/NAME`.

Links come only from exact step IDs and file paths. A link shows that two
commands are connected, not that they succeeded.

## Using the wrappers by hand

They work without Codex too, from the project folder:

```bash
bash tools/run-step webapp health-01 --purpose "Save the health endpoint response" \
  --artifact engagements/webapp/evidence/health-01.json \
  -- curl -sS -o engagements/webapp/evidence/health-01.json http://127.0.0.1:8080/health
bash tools/run-step webapp health-01-read --offline --purpose "Show the saved response" \
  -- nl -ba engagements/webapp/evidence/health-01.json
python3 tools/report-step webapp health-01 --purpose "Check the service is up" \
  --observed "The health endpoint returned status ok." \
  --excerpt evidence/health-01.json@1:4 --excerpt action=health-01-read@1:4
```

`run-step` returns the command's own exit status. Each script prints its usage
when called with missing arguments; `report-step --help` lists every option.

Evidence and reports can contain sensitive data. Add `engagements/` to your
project's `.gitignore` unless you mean to share them.
