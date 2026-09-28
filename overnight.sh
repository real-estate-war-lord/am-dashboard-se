#!/usr/bin/env bash
# overnight.sh — Sweden edition v2.1 "Sweden fit" as sequential, unattended Claude Code phases.
#
#   ./overnight.sh preflight        # before bed: checks, Playwright, branch v2.1-sweden, plan commit, test call
#   ./overnight.sh run [P1 P2 …]    # the night (default P1…P6); AUTO_RELEASE=1 publishes if everything is green
#   ./overnight.sh watch            # live progress in another Terminal tab (Ctrl-C to stop watching)
#   ./overnight.sh status           # the report so far
#   ./overnight.sh gate P3          # the self-check (used by the agent and by this wrapper)
#   ./overnight.sh release          # morning: merge v2.1-sweden → main, tag v2.1, push (GitHub Pages deploys)
#
# Ported from the Danish edition's v3.0 runner. Never pushes except in `release` (or AUTO_RELEASE=1 after an
# all-green night). Logs and the report live in logs/ (git-excluded), so the working tree stays clean.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"; cd "$REPO" || exit 1
BRANCH="v2.1-sweden"; VERSION="${VERSION:-v2.1}"
ALL_PHASES=(P1 P2 P3 P4 P5 P6)
PHASE_TIMEOUT="${PHASE_TIMEOUT:-9000}"     # seconds per claude call (150 min)
LIMIT_WAIT="${LIMIT_WAIT:-1200}"           # seconds to sleep when a usage limit is hit
LIMIT_MAX_WAITS="${LIMIT_MAX_WAITS:-15}"   # up to 5 h of waiting in total
PORT="${PORT:-8081}"
MODEL_ARGS=(); [ -n "${MODEL:-}" ] && MODEL_ARGS=(--model "$MODEL")
ALLOWED_TOOLS="Read,Edit,Write,Glob,Grep,\
Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git add:*),Bash(git commit:*),Bash(git mv:*),Bash(git rm:*),Bash(git checkout -- :*),Bash(git restore:*),\
Bash(./overnight.sh gate:*),Bash(make validate:*),Bash(make build:*),Bash(make test:*),Bash(make test-js:*),\
Bash(python3 scripts/build_:*),Bash(python3 scripts/import_bra.py:*),Bash(python3 tests/:*),Bash(.venv-ui/bin/python3 tests/:*),\
Bash(node --test:*),Bash(node --check:*),Bash(node tests/:*),Bash(ls:*),Bash(wc:*),Bash(grep:*),Bash(head:*),Bash(tail:*),Bash(mkdir:*),Bash(du:*)"
DENIED_TOOLS="Bash(git push:*),Bash(git reset:*),Bash(git branch:*),Bash(git merge:*),Bash(git tag:*),Bash(curl:*),Bash(pip:*),Bash(npm:*),Bash(make fetch:*),WebFetch,WebSearch"
CLAUDE_PERMS=(--permission-mode acceptEdits --allowedTools "$ALLOWED_TOOLS" --disallowedTools "$DENIED_TOOLS")
PY="$REPO/.venv-ui/bin/python3"; [ -x "$PY" ] || PY=python3
RUN_ID="${RUN_ID:-$(date +%Y%m%d)}"
LOGS="$REPO/logs/overnight-$RUN_ID"; mkdir -p "$LOGS"
REPORT="$LOGS/OVERNIGHT_REPORT.md"
PH_DIR="$REPO/docs/v2_1/phases"
FORBIDDEN='^(\.github/|config/|gateway/|scripts/fetch_|data/raw/|data/geo/raw/)'

log()    { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOGS/run.log"; }
report() { printf '%s\n' "$*" >> "$REPORT"; }
notify() { command -v osascript >/dev/null && osascript -e "display notification \"$1\" with title \"SE v2.1 overnight\"" >/dev/null 2>&1; true; }
with_timeout() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$s" "$@"; }

exclude_local() {
  grep -qxF '.venv-ui/' .git/info/exclude 2>/dev/null || echo '.venv-ui/' >> .git/info/exclude
  grep -qxF 'logs/' .git/info/exclude 2>/dev/null || echo 'logs/' >> .git/info/exclude
}

serve() {
  if ! curl -s -o /dev/null "http://localhost:$PORT/"; then
    (cd dist && nohup python3 -m http.server "$PORT" >"$LOGS/http.log" 2>&1 &)
    sleep 1
  fi
}

gate() {   # $1 = phase id. Exit 0 = green.
  local ph="${1:-adhoc}" out="$LOGS/${1:-adhoc}.gate.log"
  (
    echo "== validate";  make validate || exit 1
    echo "== build";     make build || exit 1
    echo "== test";      make test || exit 1
    serve
    echo "== v2.0 spec"; "$PY" tests/ui_v2/spec.py --url "http://localhost:$PORT/" --upto P11 --out "$LOGS/v20/$ph" || exit 1
    if [ -f tests/ui_v2_1/spec.py ]; then
      echo "== v2.1 spec up to $ph"
      "$PY" tests/ui_v2_1/spec.py --url "http://localhost:$PORT/" --upto "$ph" --out "$LOGS/shots/$ph" --shots || exit 1
    elif [ "$ph" != "adhoc" ]; then echo "tests/ui_v2_1/spec.py missing — P1 must create it"; exit 1; fi
    echo "GATE GREEN"
  ) >"$out" 2>&1
  local rc=$?
  echo "gate $ph: $([ $rc -eq 0 ] && echo GREEN || echo RED) — log: $out  shots: $LOGS/shots/$ph"
  return $rc
}

check_commit() {
  local ph="$1"
  [ "$(git rev-list --count "v21-$ph-start..HEAD")" -ge 1 ] || { echo "no commit made"; return 1; }
  [ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; git status --porcelain | head; return 1; }
  local bad; bad=$(git diff --name-only "v21-$ph-start..HEAD" | grep -E "$FORBIDDEN")
  [ -z "$bad" ] || { echo "forbidden paths changed: $bad"; return 1; }
  [ ! -f "$PH_DIR/$ph.FAILED.md" ] || { echo "agent reported failure ($ph.FAILED.md)"; return 1; }
}

hit_limit() { grep -qiE "usage limit|rate.?limit|limit (reached|exceeded)|resets at|overloaded" "$1"; }

run_claude() {
  local waits=0
  while :; do
    with_timeout "$PHASE_TIMEOUT" claude -p "${CLAUDE_PERMS[@]}" --output-format text \
        ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} < "$1" > "$2" 2>&1
    local rc=$?
    if [ $rc -ne 0 ] && hit_limit "$2" && [ $waits -lt "$LIMIT_MAX_WAITS" ]; then
      waits=$((waits + 1)); log "usage/rate limit — sleeping $LIMIT_WAIT s ($waits/$LIMIT_MAX_WAITS)"
      cp "$2" "$2.limit$waits"; sleep "$LIMIT_WAIT"; continue
    fi
    return $rc
  done
}

run_phase() {
  local ph="$1" att="$2" prev="${3:-}" t0=$SECONDS
  local prompt="$LOGS/$ph.attempt$att.prompt.md"
  {
    cat "$PH_DIR/_COMMON.md"; echo; echo "---"; echo
    echo "# YOUR PHASE: $ph  (replace <PHASE> with $ph everywhere above)"; echo
    cat "$PH_DIR/$ph.md"
    if [ -n "$prev" ] && [ -f "$prev" ]; then
      echo; echo "## RETRY — the previous attempt of this phase was rolled back. Its gate/commit output:"
      echo '```'; tail -n 150 "$prev"; echo '```'
      echo "Start from the clean state, avoid what failed, keep the scope tight."
    fi
  } > "$prompt"
  log "$ph attempt $att: claude running (timeout ${PHASE_TIMEOUT}s) — follow with: tail -f $LOGS/$ph.attempt$att.log"
  run_claude "$prompt" "$LOGS/$ph.attempt$att.log"
  log "$ph attempt $att: claude exited $? after $(( (SECONDS - t0) / 60 )) min"
  local why; why=$(check_commit "$ph") || { log "$ph: $why"; echo "$why" > "$LOGS/$ph.gate.log"; return 1; }
  gate "$ph" >/dev/null || { log "$ph: gate RED ($LOGS/$ph.gate.log)"; return 1; }
  log "$ph: GREEN at $(git rev-parse --short HEAD)"
}

rollback() {
  local ph="$1"
  [ -f "$PH_DIR/$ph.FAILED.md" ] && cp "$PH_DIR/$ph.FAILED.md" "$LOGS/"
  git reset -q --hard "v21-$ph-start"; git clean -qfd -e logs -e .venv-ui
}

preflight() {
  local bad=0
  exclude_local
  echo "· python: $(python3 --version 2>&1)   node: $(node --version 2>&1)   claude: $(claude --version 2>&1 | head -1)"
  command -v node >/dev/null || { echo "✗ node missing"; bad=1; }
  command -v claude >/dev/null || { echo "✗ claude CLI missing"; bad=1; }
  if [ -n "$(git status --porcelain -- . ':!docs/v2_1' ':!overnight.sh')" ]; then
    echo "✗ uncommitted changes outside docs/v2_1 + overnight.sh:"; git status --porcelain | head; exit 1
  fi
  if ! git rev-parse --verify -q "$BRANCH" >/dev/null; then
    git checkout -q main && git pull -q --ff-only origin main || { echo "✗ could not update main from GitHub"; exit 1; }
    echo "· main is at $(git log -1 --format='%h %s')"
    git checkout -q -b "$BRANCH" main
  fi
  git checkout -q "$BRANCH" || { echo "✗ cannot switch to $BRANCH"; exit 1; }
  if [ -n "$(git status --porcelain -- docs/v2_1 overnight.sh)" ]; then
    chmod +x overnight.sh; git add docs/v2_1 overnight.sh
    git commit -q -m "v2.1 P0: phase prompts and the overnight runner" && echo "✓ plan committed on $BRANCH"
  fi
  if ! "$PY" -c "import playwright" 2>/dev/null; then
    echo "· creating .venv-ui with Playwright (one-off, ~150 MB)…"
    python3 -m venv .venv-ui && .venv-ui/bin/pip -q install playwright && .venv-ui/bin/python3 -m playwright install chromium || { echo "✗ Playwright install failed"; bad=1; }
    PY="$REPO/.venv-ui/bin/python3"
  fi
  "$PY" -c "from playwright.sync_api import sync_playwright; print('✓ playwright ok')" || bad=1
  make validate >/dev/null 2>&1 && echo "✓ validate ok" || { echo "✗ make validate failed"; bad=1; }
  make build >"$LOGS/preflight.build.log" 2>&1 && echo "✓ build ok" || { echo "✗ build failed — $LOGS/preflight.build.log"; bad=1; }
  make test >"$LOGS/preflight.test.log" 2>&1 && echo "✓ tests ok" || { echo "✗ make test failed — $LOGS/preflight.test.log"; bad=1; }
  serve
  "$PY" tests/ui_v2/spec.py --url "http://localhost:$PORT/" --upto P11 --out "$LOGS/v20/baseline" >"$LOGS/preflight.spec.log" 2>&1 \
     && echo "✓ v2.0 spec green on the baseline" || echo "· v2.0 spec not fully green on the baseline — see $LOGS/preflight.spec.log (P1 will deal with it)"
  echo "· testing an unattended claude call…"
  if with_timeout 180 claude -p "${CLAUDE_PERMS[@]}" "Run the shell command: ls docs/v2_1 — then reply with exactly: READY" 2>&1 | grep -q READY; then echo "✓ claude -p works unattended"; else echo "✗ claude -p did not answer READY — run 'claude' once interactively to log in"; bad=1; fi
  [ $bad -eq 0 ] && echo "✓ PREFLIGHT OK — start the night with:  ./overnight.sh run" || { echo "✗ PREFLIGHT FAILED"; exit 1; }
}

release() {
  git checkout -q "$BRANCH" || exit 1
  [ -z "$(git status --porcelain)" ] || { echo "✗ tree not clean"; exit 1; }
  gate P6 || { echo "✗ gate not green — not releasing"; exit 1; }
  git fetch -q origin
  git checkout -q main && git merge -q --ff-only origin/main 2>/dev/null
  git merge -q --no-ff "$BRANCH" -m "Release $VERSION — Sweden fit" || { echo "✗ merge conflict — resolve by hand"; git merge --abort; git checkout -q "$BRANCH"; exit 1; }
  git tag -f "$VERSION" >/dev/null
  git push -q origin main && git push -q -f origin "$VERSION" && echo "✓ $VERSION pushed — GitHub Pages deploys in a few minutes"
  git checkout -q "$BRANCH"
}

main_run() {
  local phases; if [ $# -gt 0 ]; then phases=("$@"); else phases=("${ALL_PHASES[@]}"); fi
  exclude_local; git checkout -q "$BRANCH" || { echo "run preflight first"; exit 1; }
  [ -f "$REPORT" ] || { report "# Overnight report — SE v2.1 ($(date '+%F %H:%M'))"; report "";
    report "Branch \`$BRANCH\`. Logs \`$LOGS\`. Review server: http://localhost:$PORT/"; report "";
    report "| Phase | Result | Commit | Min | Notes |"; report "|---|---|---|---|---|"; }
  local fails=0 allgreen=1
  notify "Night started: ${phases[*]}"
  for ph in "${phases[@]}"; do
    local t0=$SECONDS; git tag -f "v21-$ph-start" >/dev/null
    if run_phase "$ph" 1 || { rollback "$ph"; run_phase "$ph" 2 "$LOGS/$ph.gate.log"; }; then
      report "| $ph | ✓ green | $(git rev-parse --short HEAD) | $(( (SECONDS - t0) / 60 )) | shots/$ph |"; fails=0
      notify "$ph green ($(( (SECONDS - t0) / 60 )) min)"
    else
      rollback "$ph"; allgreen=0; fails=$((fails + 1))
      report "| $ph | ✗ rolled back | – | $(( (SECONDS - t0) / 60 )) | $ph.attempt2.log, $ph.gate.log |"
      notify "$ph rolled back"
      [ "$ph" = P1 ] && { report ""; report "**Stopped: P1 (harness + bug fixes) failed — nothing else can build on it.**"; break; }
      [ $fails -ge 2 ] && { report ""; report "**Stopped: two phases in a row failed.**"; break; }
    fi
  done
  report ""
  if [ $allgreen -eq 1 ] && [ "${AUTO_RELEASE:-0}" = 1 ] && [ ${#phases[@]} -eq ${#ALL_PHASES[@]} ]; then
    log "all phases green — AUTO_RELEASE=1 → releasing"; release >>"$LOGS/release.log" 2>&1 \
      && report "**Released $VERSION to GitHub Pages automatically.**" || report "**Auto-release failed — see release.log; run ./overnight.sh release by hand.**"
  else
    report "Not released. Review, then publish with: \`./overnight.sh release\`"
  fi
  report ""; report "Morning: read docs/v2_1/RELEASE_NOTES_FI.md, open http://localhost:$PORT/ , screenshots in $LOGS/shots/P6/"
  log "done — $REPORT"; notify "Night finished — ./overnight.sh status"
}

case "${1:-}" in
  preflight) preflight ;;
  gate)      gate "${2:-adhoc}" ;;
  release)   release ;;
  status)    cat "$(ls -td logs/overnight-*/ 2>/dev/null | head -1)OVERNIGHT_REPORT.md" 2>/dev/null; tail -n 5 "$(ls -td logs/overnight-*/ 2>/dev/null | head -1)run.log" 2>/dev/null ;;
  watch)     tail -n 20 -f "$(ls -td logs/overnight-*/ 2>/dev/null | head -1)run.log" ;;
  run)       shift
             if command -v caffeinate >/dev/null && [ -z "${CAFFEINATED:-}" ]; then
               CAFFEINATED=1 RUN_ID="$RUN_ID" exec caffeinate -dimsu "$0" run "$@"; fi
             main_run "$@" ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
