#!/usr/bin/env bash
# Add the example step wrappers to a project.
#
#   examples/step-wrappers/install.sh PROJECT_DIR [ENGAGEMENT]
#
# Copies run-step, run-service and report-step into PROJECT_DIR/tools, creates
# PROJECT_DIR/engagements/ENGAGEMENT/evidence, and appends instructions for
# Codex to PROJECT_DIR/AGENTS.md. Existing files are never overwritten; running
# it again changes nothing.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

[[ $# -ge 1 && $# -le 2 ]] || fail "usage: install.sh PROJECT_DIR [ENGAGEMENT]"
project="$1"
engagement="${2:-$(basename -- "$(cd -- "$project" 2>/dev/null && pwd -P)" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')}"
[[ -d "$project" ]] || fail "not a directory: $project"
project="$(cd -- "$project" && pwd -P)"
engagement="${engagement#-}"
[[ "$engagement" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "choose an engagement name of lowercase letters, digits, - or _"

mkdir -p -- "$project/tools" "$project/engagements/$engagement/evidence"
for name in run-step run-service report-step; do
    target="$project/tools/$name"
    if [[ -e "$target" ]]; then
        if cmp -s -- "$here/tools/$name" "$target"; then
            printf 'unchanged  tools/%s\n' "$name"
        else
            printf 'kept       tools/%s (a different file already exists)\n' "$name"
        fi
        continue
    fi
    cp -- "$here/tools/$name" "$target"
    chmod 755 -- "$target"
    printf 'added      tools/%s\n' "$name"
done
printf 'ready      engagements/%s/evidence/\n' "$engagement"

agents="$project/AGENTS.md"
if [[ -f "$agents" ]] && grep -Fq '<!-- terminal-recorder step wrappers -->' "$agents"; then
    printf 'unchanged  AGENTS.md (instructions already present)\n'
else
    [[ ! -s "$agents" ]] || printf '\n' >> "$agents"
    sed "s/ENGAGEMENT_NAME/$engagement/g" "$here/AGENTS.md" >> "$agents"
    printf 'updated    AGENTS.md (step wrapper instructions for engagement "%s")\n' "$engagement"
fi
cat <<MSG

Done. Start a recorded session from $project, for example:
  cd $project && $(dirname -- "$(dirname -- "$here")")/start-recorded-codex
Saved evidence and reports may contain sensitive data; consider adding
engagements/ to the project's .gitignore.
MSG
