# Report: example

## health-01

- Recorded: 2026-10-18T12:37:53Z
- Purpose: Check the service is up

**Observed:** The health endpoint returned status ok.

**Evidence**

- `engagements/example/evidence/health-01.json` lines 1-4, SHA-256 `af74f3e05f0014dfdd38e343791f73c8117c98b740f99925869e18b7b705a85e`

```text
{
  "status": "ok",
  "version": "1.0.0"
}
```

- Output of action `health-01-read`, lines 1-4 (see the recorder capture)

**Next step (proposed, not run):** Check the version endpoint next.

