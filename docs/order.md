# Say what "done" means before the work starts: `openmorals order`

Added in 0.27.0. A work order is a short YAML file you write (or have an agent draft) **before** the work: what it is (`kind`), the files it starts from (each with its SHA-256), the files it must produce, and a few conditions from a fixed list that code can check. You approve it yourself. Then `openmorals order check` checks the finished work against it, every time, the same way, with no model call.

- `openmorals order new` prints the start of an order with the input hashes filled in. It writes nothing.
- `openmorals order approve <order.yaml>` is yours: it shows the conditions and, for an order approved before, every edit since, and stores the order's hash. An agent running it is asked (refused when no one is there to ask).
- `openmorals order check [<order.yaml>]` exits non-zero on any failure, writes the result to the audit log with the run id, and prints beside every pass what that pass does not show.

It calls no model and spends no tokens. Nothing reaches the agent unless the agent runs `order check` itself; then it reads the printed result. Measured on 0.27.0: the worked code order below prints 1,419 characters when it passes and 1,194 with one condition failing; a 13-condition office order, 3,960 and 3,512 (with three failing). Roughly 300 characters per condition.

**Nothing changes for anyone who never writes an order.** The hook does not read orders. The only hook-side change is an optional field: when `OPENMORALS_ORDER` is set in the hook's own environment, each audit record carries that path (`order`), and no decision reads it.

## What a pass shows, and what it does not

A pass says: the order is approved and unchanged since, every input still has the SHA-256 the order states, every output exists and is not empty, and every listed condition held. That is all.

It does **not** show that the work is right. It does not read what a document says under its headings, whether a figure comes from a true source, whether a dropped row was dropped for a good reason, what the named tests check, whether to send the message, or anything else the order does not list. `order check` prints a "Not checked" list beside every pass: one line per passing condition naming what it does not show, the outputs no condition reads, and two lines that are always there:

- Only the conditions above were checked. Whether this is the right work, whether a source is true, tone, and whether to send or submit are yours.
- A pass adds nothing to and removes nothing from any other guard's decision.

That last line is a rule, not a hope: a passing order never lowers an ask or a refusal anywhere else (ADR 0013, ADR 0014).

## The format

```yaml
version: 1                 # required, 1
kind: document             # required: code, document, spreadsheet, data, email or other
title: Quarterly summary   # optional
template: board-report     # optional: a user-level template (below)
inputs:                    # optional: files the work starts from, each with its SHA-256
  - path: data/q3.csv
    sha256: 0f1e...        # 64 lower-case hex characters; `order new --input FILE` prints it
outputs:                   # optional: files the work must produce (each must exist, not empty)
  - out/q3-clean.csv
conditions:                # at least one, here or in the template
  - exists: { file: out/q3-clean.csv, type: csv }
```

Paths are read from the folder the order file is in (or are absolute). Any key not listed here, or any condition not in the list below, is refused with the allowed list printed; so is a duplicate key, a YAML alias, an input without a SHA-256, an order with no condition, and a condition repeated (two conditions on the same file and column are the same condition).

## The conditions

Each is a mapping with one key, the condition's name. A file that cannot be read fails its condition; it never passes.

| Condition | Keys | Fails when |
|---|---|---|
| `exists` | `file`, `type` (optional: `csv`, `tsv`, `json`, `md`, `txt`, `html`, `docx`, `xlsx`, `pptx`, `pdf`, `eml`) | the file is missing or empty, or does not read as its type (a `.docx` that is really a workbook, a `.pdf` without `%PDF-`, JSON that does not parse) |
| `headings` | `file` (`.md`, `.markdown`, `.docx`), `include` (list), `in_order` (default false) | a listed heading is missing (compared without case and extra spaces), or out of order. Markdown: `#` headings and underlined ones, not inside code fences. Word: paragraphs styled "heading N" or "Title", styles based on them, or with an outline level |
| `no_placeholders` | `file` (any UTF-8 text file, or `.docx`; `.pdf`, `.xlsx`, `.pptx` and other containers are refused as not built), `also` (your own literal strings) | `TODO`, `TBD`, `FIXME`, `XXX`, `lorem ipsum`, `[name]`-style blanks (`[insert ...]`, `[client ...]`, `[date]` and the like), `{{field}}`, `<insert ...>`, `???`, or one of yours, is found; up to ten places are listed |
| `recipients` | `file` (`.eml`), `to`, `cc`, `bcc` (lists of addresses) | an address in the draft is not in the order, or one in the order is not in the draft (per field; display names and case ignored) |
| `attachments` | `file` (`.eml`), `files` (list of `{name, sha256}`; empty means none) | an attachment is missing, extra, renamed, or its decoded content has another SHA-256 |
| `rows` | `input`, `kept`, `dropped` (optional), `reason_column` (default `reason`), `filters` (the allowed reasons), `key` (optional column) | rows in ≠ rows kept + rows dropped; a dropped row has no reason or one that is not a listed filter; with `key`: a key of the input is neither kept nor dropped, or a kept or dropped key is not in the input (or appears more often) |
| `unique` | `file`, `columns` | the combination of the columns repeats (each repeat's line is listed) |
| `not_null` | `file`, `columns` | a cell in one of the columns is empty or only spaces |
| `accepted_values` | `file`, `column`, `values` | a value is not one of the listed values (exact match) |
| `relationships` | `file`, `column`, `to: {file, column}` | a non-empty value is not found in the other file's column (empty cells are not checked) |
| `freshness` | `file`, `column`, `max_age_days` | the newest date (ISO `YYYY-MM-DD`, optionally with a time; no zone means UTC) is older than allowed, a non-empty value is not a date, or there is no date |
| `total` | `file`, `column`, one of `equals` (a stated control total) or `equals_sum: {file, column}` (a source file's column), `tolerance` (default 0) | the column's sum differs from the control total by more than the tolerance, or a cell is not an amount. Amounts: digits, optional sign or brackets for a negative, an optional `$ £ € ¥`, thousands commas; summed exactly (no floating point), up to 12 decimals |
| `tests` | `before`, `after` (two test reports), `ids` (the change's acceptance tests), `format`, `before_root`, `after_root` (optional, as in `tests compare`) | a named test is not in the after report, matches two tests, or did not fail (or was absent) before and pass after; or no test name is in both reports. Read by [`tests compare`](tests-compare.md), the same reader and comparison |

CSV conditions read `.csv` and `.tsv` files with a header row (RFC 4180 quoting); a row with a different number of fields fails the condition, and blank lines are not rows. A file type a reader is not built for is refused when the order is read, by name ("reading headings from a .pdf file is not built yet; built for: .md, .markdown, .docx"), never checked as a pass. Not built in 0.27.0: headings and placeholders in `.pdf`, `.pptx` and `.xlsx`; column checks in `.xlsx`; mail drafts other than `.eml`.

The named acceptance tests also feed [`tests fail-first`](tests-fail-first.md): `openmorals tests fail-first --base REV --order order.yaml` adds the `ids` of the order's `tests` conditions to `--expect-red`, but only when the order is approved as it reads now; otherwise it judges nothing (exit 2). So the list of tests that must go from red to green is the one you approved, not the agent's.

## Approving, and edits after approval

`openmorals order approve order.yaml` reads and checks the order, refuses it when an input does not match its stated SHA-256 (write the current one in if that is the input you mean), prints every condition and output, and asks you to type `yes`. Outside a terminal nothing is stored without `--yes`. It appends a line to `orders/approvals.jsonl` in the config directory with the order's real path, its SHA-256 (over the order's text and its template's text) and both texts, and writes an `order.approve` record to the audit log.

An agent cannot approve its own order: `openmorals order approve` (and `order baseline`, reserved) is on the self-protect guard's person-only list, like `approve` for held actions and `purge`, so the hook asks you (and refuses unattended). The approvals file and the templates folder are in the config directory, which the self-protect guard already protects; an edit to them through the agent's tools asks.

**Any edit after approval fails the check**, even a comment. The check shows the edit condition by condition, as

- a **loosening**: a condition, input or output removed; a tolerance raised; an accepted value or a filter reason added; `in_order` switched off; a key column dropped;
- a **tightening**: a condition, input or output added; a tolerance lowered; a heading, a not-null column or a test id added;
- a **change**: other files, other recipients or attachments, another control total, another kind or template. A change openmorals cannot show to be stricter is read as a loosening.

Approve again to accept the edit; `approve` shows the same list before it asks.

## Templates: a condition set that only grows

A template is a user-level file `order-templates/<name>.yaml` in the config directory (never read from a project, as with every setting that could loosen a check, ADR 0010):

```yaml
version: 1
conditions:
  - no_placeholders: { file: report.docx }
  - headings: { file: report.docx, include: [Summary, Risks] }
```

An order naming `template: <name>` carries every condition of the template first, then its own. An order cannot repeat or change a template's condition; it can only add. A template's conditions only grow: once an order using it has been approved, a check or an approval of any order using that template fails while the template lacks a condition it held then (the message names it and the approval date). Adding a condition to a template is an edit after approval for each order using it, shown as a tightening, until you approve each again.

## The check, its exit codes and the record

`openmorals order check [order.yaml] [--run ID] [--json]` (the file defaults to `OPENMORALS_ORDER`).

| Exit | Meaning |
|---|---|
| 0 | The order is approved and unchanged since, every input matches, every output exists, every condition passed |
| 1 | Anything failed, or the order is missing, invalid, not approved, edited after approval, or its template lost a condition, or the approval store cannot be read. A missing or unapproved order is a failure, never a pass |
| 2 | The result could not be written to the audit log; read it as not passed |
| 64 | Usage error |

A check still runs every condition when the order is not approved, so you see where the work stands; the result is FAIL until you approve the order.

Each check appends one chained record to the audit log (session `order`, tool `order check`, rule `order.check.pass` or `order.check.fail`, decision `allow` or `ask`), with `run` from `--run` or `OPENMORALS_RUN`, `order` (the order's path), and an `order_check` object: `result`, `path`, `sha256`, `approval` (`approved`, `unapproved`, `edited` or `unknown`) and `approved` (when), `problems`, `inputs`, `outputs`, `conditions` (key, outcome, detail) and `not_checked`. `openmorals audit --run ID` lists a run's checks under "order checks" and the orders its records name under "work orders named"; checks are not counted as denies or asks, so the merge verdict's record facts (`diff-class --summary`) are unchanged.

## Worked example: a code change

The order names the acceptance tests, the file the change must add, and no leftover markers in it:

```yaml
version: 1
kind: code
title: Clamp values to the allowed range
outputs:
  - src/clamp.mjs
conditions:
  - exists: { file: src/clamp.mjs }
  - no_placeholders: { file: src/clamp.mjs }
  - tests: { before: reports/base.xml, after: reports/head.xml, ids: [clamps high, clamps low] }
```

Your gate makes the two reports (for example `tests fail-first --base "$(git merge-base main HEAD)" --order order.yaml --reports reports/`, or your own test command on the base and on the head) and then runs `openmorals order check order.yaml`. It fails if a named test passed before (it shows nothing), still fails after, or is missing, and if `TODO` or `FIXME` is left in the file. It does not show what the tests check, or any other test's fate: `tests compare` does that.

## Worked example: office work (a document and a CSV)

```yaml
version: 1
kind: document
title: Q3 summary for the board
inputs:
  - path: data/q3-transactions.csv
    sha256: 3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b
outputs:
  - out/q3-summary.docx
  - out/q3-clean.csv
conditions:
  - exists: { file: out/q3-summary.docx, type: docx }
  - headings: { file: out/q3-summary.docx, include: [Summary, Figures, Risks], in_order: true }
  - no_placeholders: { file: out/q3-summary.docx }
  - rows: { input: data/q3-transactions.csv, kept: out/q3-clean.csv, dropped: out/q3-dropped.csv, filters: [duplicate, outside Q3], key: txn_id }
  - unique: { file: out/q3-clean.csv, columns: [txn_id] }
  - not_null: { file: out/q3-clean.csv, columns: [txn_id, amount, date] }
  - accepted_values: { file: out/q3-clean.csv, column: region, values: [north, south, east, west] }
  - freshness: { file: out/q3-clean.csv, column: date, max_age_days: 120 }
  - total: { file: out/q3-clean.csv, column: amount, equals_sum: { file: data/bank-statement-q3.csv, column: amount }, tolerance: 0.01 }
```

A pass says the summary is a Word file with those three headings in that order and no blanks left, every transaction of the input is either in the clean file or in the dropped file with one of the two named reasons, the clean file's ids are unique and filled, its regions are the four named, its newest date is recent, and its amounts add up to the bank statement within a cent. It does not say the summary's text is right, that a duplicate was really a duplicate, or that the bank statement is the right one. Read the "Not checked" list beside the pass.

## Limits

- Word: only the body paragraphs are read (not headers, footers, comments, text boxes or tracked deletions). Zip containers are read with Node's own `zlib`; ZIP64, encrypted and multi-part archives fail their condition.
- Mail: `.eml` (RFC 5322 with MIME). Attachments are hashed after base64 or quoted-printable decoding; an 8-bit attachment with bare line feeds may hash differently from the file.
- `freshness` takes the newest date only, and the check's own clock.
- Files over 64 MB fail their condition.
- An order is only as good as its conditions. A green check over a thin order says little; that is why the "Not checked" list is printed every time.

## Kill criterion

As ruled for this unit: if fewer than 10 orders are written in 4 weeks of real use by the person it was built for, narrow it to the code acceptance link only (the `tests` condition and `tests fail-first --order`).

## What is not built here

- **`order baseline`** (records the last accepted version of an output so the next check reports what was lost: formulas turned into numbers, sections dropped). It is the office before-after unit and is refused today as not built.
- **A hold on the outward step** (send, submit, publish, overwrite) while an order's last check failed, is missing or is stale. When it comes it will read the record this command writes and `OPENMORALS_ORDER`; a passing check will still add nothing and remove nothing.
- A done-check wired into a host's task-completion event.
