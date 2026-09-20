# Tonight's run — the deep raw pull

Four commands. The first three take about ten minutes and you should watch them;
the fourth is the long one you start before going to bed.

## Setup

```bash
mkdir -p ~/Desktop/"Sweden dashboard"/am-dashboard-se
cd ~/Desktop/"Sweden dashboard"/am-dashboard-se
unzip ~/Downloads/am-dashboard-se-fetch.zip -d .
```

Requirements: Python 3.10+ (`python3 --version`). Nothing to install, no API key,
no account — SCB's statistical database is keyless and CC0.

## 1 · Self-test (1 second, no network)

```bash
python3 scripts/selftest.py
```
**Good:** a list of `ok` lines ending in *all offline checks passed*.
**If not:** paste the output; nothing else is worth running until this is green.

## 2 · Boundaries (5–20 minutes)

```bash
python3 scripts/fetch_geo_scb.py
```
**Good:** `3363 features` for RegSO and `6160 features` for DeSO, each followed by
its attribute list. DeSO is a large download — several minutes of silence is normal.
**Worth noting:** if the kommun/län zip 404s, that is expected eventually (its URL
carries a vintage) and does not matter tonight — everything else still works.

## 3 · Table discovery + dry run (3–5 minutes)

```bash
python3 scripts/discover_scb.py
python3 scripts/fetch_scb.py --dry-run
```
The first finds the table ids we only know by their old API paths (unemployment,
mortgage rates, GDP, assessed values). The second fetches every table's metadata
and prints the plan — how many calls and cells each pull needs — without
downloading a single data row.

**Look at the first ten lines of the dry run.** If they show call counts and cell
counts, the night is safe to start. If they all say `FAILED: metadata`, stop and
paste it — something systematic is wrong and the long run would only waste hours.

## 4 · The long run — start this and go to sleep

```bash
caffeinate -i python3 scripts/fetch_scb.py 2>&1 | tee data/raw/_console.txt
```

`caffeinate -i` stops the Mac idling to sleep mid-run. Leave it plugged in, and
don't close the lid — closing it sleeps the machine anyway.

**Expected:** 30–90 minutes, 66 tables, 82 table/level pulls. It prints a line per
pull and a summary at the end.

**It is built to survive the night unattended:**
- one broken table is logged and the run carries on — it can never cost you the night;
- progress is saved continuously, so if it is interrupted, the same command resumes
  where it stopped and never re-downloads what it already has;
- tables that failed *are* retried on the next run, tables that succeeded are not;
- suppressed values stay empty rather than becoming zeros.

## In the morning

Paste me the tail of the log:

```bash
tail -40 data/raw/_fetch_log.txt
ls -la data/raw | head -20
du -sh data/raw data/geo
```

Then we resolve the failures, pin the discovered table ids, and build the
indicator registry against metadata that is by then sitting on your own disk —
no more network in the loop.

---

### What you now have on disk

```
data/raw/scb_<TABLE>_<level>.jsonl        one JSON object per data cell
data/raw/scb_<TABLE>.meta.json            the table's own metadata at fetch time
data/raw/scb_<TABLE>_<level>.state.json   progress + the source's update date
data/raw/_discovery.json                  candidate ids for the unresolved tables
data/raw/_fetch_log.txt                   the run log
data/geo/raw/regso_2025.geojson           3 363 named neighbourhood polygons
data/geo/raw/deso_2025.geojson            6 160 polygons
```

The raw layer is deliberately wider than the dashboard will be: every dimension of
every table is pulled in full, so indicator codes can be resolved later without
re-fetching anything. That is the whole point of doing this in one night.
