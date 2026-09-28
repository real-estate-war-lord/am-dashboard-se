# `tests/ui_v2_1` — the v2.1 acceptance spec

One Playwright spec for the whole v2.1 "Sweden fit" release. Every acceptance
item in `docs/v2_1/phases/P*.md` becomes one registered check, tagged with the
phase that delivered it, so the spec is runnable from the first commit of the
release rather than only at the end.

## Running it

```bash
python3 -m http.server 8081 --directory dist &     # serve the build
python3 tests/ui_v2_1/spec.py --url http://localhost:8081/ --upto P1
```

Or, the way the wrapper does it — `make validate`, `make build`, `make test`,
the v2.0 spec and then this one, with screenshots:

```bash
./overnight.sh gate P1
```

| flag | meaning |
|---|---|
| `--url` | where `dist/` is being served. Port **8081**, not 8080: the listings gateway's CORS allowlist permits both and 8081 is the one that is free. |
| `--upto P3` | run the checks registered for P1, P2 and P3. Default: every phase. |
| `--out DIR` | `report.json` is always written here; `--shots` writes the PNGs here too. |
| `--shots` | capture the review set at 1440×900, 1366×768 and 390×844. |

Exit status is 1 if any check failed, and every failure is repeated at the end of
the run. `report.json` holds one row per check (`phase`, `check`, `ok`, `detail`)
so a wrapper can diff two runs.

## Why this exists beside `tests/ui_v2/spec.py`

v2.0's 169 checks were green while three real bugs shipped. Both differences are
deliberate:

**1. Content, not presence.** v2.0 asserted that a Services section existed. It
did exist — and it said "Grocery 0" for a pin with 31 groceries within a
kilometre. So every check here reads what the page *says*, and where the number
can be recomputed it is recomputed: `services_within()` walks
`dist/services/*.json` with the same haversine the page uses and compares the
count cell against it. If the page and the files disagree, the spec says by how
much.

**2. The gateway can fail.** v2.0 answered every listings request with a success
fixture, so a retry storm — ~90 requests in 14 s against a donated service — was
invisible. `install_gateway(page, status=500)` is the error mode, and the handler
counts requests, which is how "at most two in ten seconds" is checked at all.

The real gateway is never called. A test that depended on a third-party service
would fail for reasons that have nothing to do with this repository.

## Writing a check

```python
@check("pin-schools-rows", "P1", "Schools lists the nearest six", needs="fresh")
def _pin_schools(r, page, errs, calls):
    hop(page, f"#property?p={STHLM}:Test&show=schools", 900)
    settle(page)
    n = table_rows(page, "schools-near")
    r.ok("six schools in the table", n == 6, f"{n} rows")
```

* `needs="page"` reuses one warm page (fast, and right for most checks);
  `needs="fresh"` gets a new one, which is what a **cold open** has to have;
  `needs="error"` gets a fresh page whose gateway answers HTTP 500.
* **Call `settle(page)` before reading content.** It waits until nothing on the
  page still says "Loading" (8 s cap). Asserting before the lazy files land reads
  the placeholder, which is exactly how v2.0 passed while three sections never
  finished loading.
* `r.ok(name, condition, detail)` — the detail is what a reader sees when it
  fails, so put the observed value in it, not a restatement of the name.
* An exception inside a check is caught and recorded as a failure; it never stops
  the run.

## Relationship to the v2.0 spec

`tests/ui_v2/spec.py` keeps running and keeps passing. Where a v2.1 change
legitimately supersedes a v2.0 check, that check is **updated**, never deleted,
and the change is logged in `docs/v2_1/DECISIONS.md`.
