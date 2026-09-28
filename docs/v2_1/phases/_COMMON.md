# Common rules for every v2.1 overnight phase (read before your phase file)

You are one of six sequential, unattended Claude Code sessions building **Sweden edition v2.1 "Sweden fit"**
on branch `v2.1-sweden` (from main = live v2.0 @ 9ab4ca2). Nobody is awake. When something is ambiguous,
choose what best fits this file and your phase file, append one line to `docs/v2_1/DECISIONS.md`
(prefixed with your phase id) and carry on. Never stop to ask.

## Read first
1. Your phase file (below). 2. `docs/v2_1/PROGRESS.md` — what earlier phases did; append to it at the end.
3. `CLAUDE.md` (traps section) and `CHANGELOG.md` v2.0. 4. Navigate `src/app.js` with
   `grep -n "^function \|^const [A-Z_]* = " src/app.js` and targeted reads — don't read it end to end.

## Hard principles (never violate)
- Hard data only: official figures or plain arithmetic on them. No scores, weights, models, verdicts.
- Suppressed ≠ 0. Not covered = "Not covered yet". A number that has not loaded yet is never shown as 0.
- Every figure keeps source, period, fetch date and verify link. Projections never look like actuals.
- Zooming never changes the selection. Old links keep working (`src/route_core.js` owns the hash).
- English UI with Swedish tenure terms (hyresrätt, bostadsrätt, äganderätt, allmännytta).
- Listings rules unchanged (`docs/LISTINGS.md`): no third-party listing data committed; the gateway is not changed.
- Evolve the existing look (dark green sidebar, paper background, mono labels, green ramps) — don't replace it.

## Allowed / forbidden
- Allowed: `src/**`, `tests/**`, `docs/**`, `dist/**` (build output), `Makefile`, `README.md`, `CHANGELOG.md`,
  `CLAUDE.md`, `scripts/build_*.py`, `scripts/import_bra.py`, `data/processed/**`, `data/external/*.csv`.
- **Forbidden** (the wrapper rolls the phase back if touched): `.github/`, `config/`, `gateway/`,
  `scripts/fetch_*`, `data/raw/`, `data/geo/raw/`.
- No network: never run `make fetch/links/verify/external/bra/polisen/schools/climate/services`, `scripts/fetch_*`,
  pip/npm installs. Everything you need is on disk.
- Never push, merge, tag or switch branch.
- New JS files: an IIFE exposing one `window.X` (see `src/route_core.js`), inlined by `scripts/build_dashboard.py`
  (all inlined files share one global scope — a colliding top-level const blanks the page).

## Tests — CONTENT, not presence
v2.0's 169 checks missed three real bugs because they asserted that elements exist and answered the gateway
only with success. Every test you add must assert what the page SAYS after lazy loads settle.
- `tests/ui_v2_1/spec.py` (created in P1): Playwright spec for v2.1, `--url --upto P1..P6 --out --shots`,
  one check per acceptance item, each registered with the phase that delivered it. Serve on port 8081.
  Gateway answered from `tests/fixtures/listings_stockholm.json`, plus explicit error-path checks (HTTP 500).
- `tests/ui_v2/spec.py` (v2.0) keeps running. If a v2.1 change legitimately supersedes a v2.0 check
  (e.g. the map-first layout), update that check and log it in DECISIONS.md — never delete one silently.

## Self-check (the wrapper re-runs it and does not trust your word)
```bash
./overnight.sh gate <PHASE>   # make validate + make build + make test + v2.0 spec + v2.1 spec up to <PHASE>
```
Iterate until green. Then look at the screenshots it writes (`logs/<run>/shots/<PHASE>/`) with your image
tool at 1440×900, 1366×768 and 390×844 for the views you changed, and fix anything broken, clipped,
overlapping or inconsistent — even when tests pass.

## Finish
1. Gate green. 2. Append a section to `docs/v2_1/PROGRESS.md` (built, deviations + why, known issues,
   what the next phase must know). 3. Exactly one commit:
   `git add -A && git commit -m "v2.1 <PHASE>: <scope>"`, with the trailer `Co-Authored-By: Claude <noreply@anthropic.com>`.
   Working tree clean afterwards.
4. If you cannot get the gate green after serious effort, write `docs/v2_1/phases/<PHASE>.FAILED.md`
   (what you tried, the failing output, your best guess at the fix) and stop. The wrapper saves it and rolls back.

## Tool permissions (anything else is denied automatically — don't retry it)
Read/Edit/Write/Glob/Grep inside the repo. Shell: `git status|diff|log|show|add|commit|mv|rm|restore`,
`git checkout -- <paths>`, `./overnight.sh gate <PHASE>`, `make validate|build|test|test-js`,
`python3 scripts/build_*.py`, `python3 scripts/import_bra.py`, `.venv-ui/bin/python3 tests/…`,
`node --test …`, `node --check …`, `node tests/…`, `ls`, `wc`, `grep`, `head`, `tail`, `mkdir`, `du`.
For a quick experiment, write it as a test under `tests/` and run it through those commands.
