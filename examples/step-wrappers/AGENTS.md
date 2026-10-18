<!-- terminal-recorder step wrappers -->
## Running commands through step wrappers

This project uses step wrappers so that every command's purpose is visible in
the terminal recorder. Use the engagement name `ENGAGEMENT_NAME` for all steps.

- Run each shell command through `run-step`, with a short, unique action ID
  and a one-sentence purpose:

  ```bash
  bash tools/run-step ENGAGEMENT_NAME list-src-01 --purpose "List the source files" -- ls -la src
  ```

- When a command saves output to a file, write it under
  `engagements/ENGAGEMENT_NAME/evidence/` and declare it with `--artifact`:

  ```bash
  bash tools/run-step ENGAGEMENT_NAME health-01 --purpose "Save the health endpoint response" \
    --artifact engagements/ENGAGEMENT_NAME/evidence/health-01.headers \
    --artifact engagements/ENGAGEMENT_NAME/evidence/health-01.json \
    -- curl -sS -D engagements/ENGAGEMENT_NAME/evidence/health-01.headers \
       -o engagements/ENGAGEMENT_NAME/evidence/health-01.json http://127.0.0.1:8080/health
  ```

- To look at a saved file, use a separate `--offline` step with `cat`,
  `nl -ba`, `sed -n 'FROM,TOp'`, `head`, `tail` or `wc`:

  ```bash
  bash tools/run-step ENGAGEMENT_NAME health-01-read --offline --purpose "Show the saved response" \
    -- nl -ba engagements/ENGAGEMENT_NAME/evidence/health-01.json
  ```

- Start servers and other long-running processes with `run-service`:

  ```bash
  bash tools/run-service ENGAGEMENT_NAME dev-server --purpose "Run the app for manual checks" -- npm run dev
  ```

- After a meaningful step, record what it showed with `report-step`, citing
  the evidence lines or the reader step:

  ```bash
  python3 tools/report-step ENGAGEMENT_NAME health-01 --purpose "Check the service is up" \
    --observed "The health endpoint returned status ok." \
    --excerpt evidence/health-01.json@1:3 --excerpt action=health-01-read@1:3 \
    --decision "Check the version endpoint next."
  ```

- Action IDs use letters, digits, `.`, `-` and `_`. Reuse the same ID in
  `report-step` as in the `run-step` it reports on.
- A suggestion in `--decision` is a proposal; run it as its own step if needed.
<!-- /terminal-recorder step wrappers -->
