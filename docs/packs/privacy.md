# The `privacy` pack (0.31.0)

**Not a certification, an audit or legal advice.** This pack notices the shapes of a few personal-data identifiers in commands, file writes and tool calls, and asks before whole data sets are dumped, committed or shared; it refuses to send a detected card number, IBAN, US social security number or NHS number over the network. It cannot see names, addresses or free text, cannot tell real data from test data, and does not show that your processing of personal data is lawful under any law. Whether it is, is a question for your data protection officer or a lawyer. That no rule fired means none of these shapes was seen, not that personal data was handled well.

Off unless you choose it. One rule refuses (an identifier sent over the network); every other rule asks. It calls no model and costs no tokens unless a rule asks or refuses (then the agent reads the rule's one-line reason). With `--unattended` an ask becomes a deny.

## Using it

- A new project: `openmorals init --pack privacy` writes it as the project's `openmorals.yaml`. A project file can only make your user-level settings stricter.
- For every project: copy `packs/privacy.yaml` (`openmorals packs privacy` prints it) to `openmorals.yaml` in your openmorals config folder.
- With patient data: use this pack as your user-level file and [`health-data`](health-data.md) as the project file; each keeps the other's rules.
- `openmorals packs show privacy` prints the principles and the disclaimer.

## Rules

| rule | decision | when |
|---|---|---|
| `priv-identifier-to-network` | deny | a card number (Luhn, not a published test number), IBAN (mod-97), US social security number or NHS number (modulus 11) in a command, URL or tool input that reaches the network |
| `priv-contact-to-network` | ask | an email address (outside reserved domains) or a phone number in international form in an action that reaches the network |
| `priv-identifier-written` | ask | one of the four identifiers in what a file-edit tool writes (`Write`, `Edit`, `MultiEdit`, `NotebookEdit` and the other hosts' write and patch tools) |
| `priv-db-dump` | ask | `pg_dump`, `pg_dumpall`, `mysqldump`, `mariadb-dump`, `mongodump`, `mongoexport`, `bcp ... out`, `sqlite3 ... .dump` |
| `priv-data-file-into-git` | ask | `git add` or `git stage` naming a `.csv`, `.tsv`, `.xls(x)`, `.parquet`, `.sqlite(3)`, `.db`, `.sql`, `.bak` or `.dump` file |
| `priv-paste-or-share` | ask | `gh gist create`; a command naming pastebin.com, paste.ee, dpaste, hastebin.com, transfer.sh, 0x0.st, file.io, termbin.com or ix.io |
| `priv-personal-field-logged` | ask | a file write that adds a logging call (`console.log`, `print`, `logger.*`, `logging.*` and similar) naming a field such as `ssn`, `date_of_birth`, `dob`, `passport_no`, `national_id`, `diagnosis`, `card_number` or `iban` |

The identifiers come from the built-in detectors (shape and checksum, [details](../architecture/guards.md#detectors-and-network-0160)). A detector's hits are masked in the audit log and session history, and the reason names only the detector and a count.

## Guards it sets

`taint` (ask), the built-in default: for someone on the defaults it changes nothing; over a looser user-level file, as a project file, it raises it back.

## Principles

Checked (each only as far as the named rules or guards reach): `identifiers-not-sent-over-the-network` (`priv-identifier-to-network`), `contact-details-sent-only-when-confirmed` (`priv-contact-to-network`), `identifiers-written-only-when-confirmed` (`priv-identifier-written`), `whole-data-sets-not-copied-unseen` (`priv-db-dump`, `priv-data-file-into-git`), `not-shared-on-public-paste-sites` (`priv-paste-or-share`), `personal-fields-not-logged` (`priv-personal-field-logged`), `private-data-not-sent-after-untrusted-input` (guard `taint`).

Advice only, not checked: names, addresses and free text; whether data is real or made up for tests; lawful basis, consent and purpose; retention and accuracy; transfers to other countries, requests from the people the data is about, impact assessments; data a program the agent writes and runs sends; and that no rule firing does not mean personal data was handled well or lawfully. The principles link to the articles of the EU data protection regulation they come from; the pack does not show conformity with it or with any other law.

## What it does not cover

- Names, street addresses, dates of birth, free-text notes, and anything encoded, compressed or in an image or PDF.
- A file written by a shell command (`echo ... > file`, a heredoc) or by a script: only the file-edit tools carry what they write.
- `git add .` or `git add -A` that sweeps a data file in; a data file with another extension.
- Data a program the agent writes and runs sends or stores; uploads through an SDK or a cloud console.
- Whether the data is about real people.

## Known false alarms

- Any email address or international phone number sent through an MCP tool or a command that reaches the network asks, including your own.
- A card number that passes the Luhn check by chance, inside an id or a test fixture, is refused when sent and asked about when written.
- `pg_dump` for a routine backup asks.
- CSV fixtures under `test/` ask when added to git.

## Measured

- Case table `cases/privacy.cases.yaml`, 63 rows: 56 judged under the pack (34 that must ask or refuse, 22 benign), 7 with the pack off (every one allows). `openmorals eval`: caught 34/34, false alarms 0/22, every row matched.
- Removal test (`test/packs-wave2.test.ts`): deleting any one rule makes exactly its own catching rows (4 to 6 per rule) fail as missed.
- Cost for an ordinary session: with the pack laid over each benign row of the other case files as a project file, it asks or refuses on 6 of the 446 benign rows: `health-data.cases.yaml` rows 6 and 7 (a card number and an NHS number sent with curl: refused) and 20 (a card number written to a fixture: asked), and 50 (`git add clinical-data/visits.csv`: a data file into git); `outbound.cases.yaml` row 65 (a web form filled with an email address and a phone number: asked) and 67 (a card number typed into a checkout form: refused). Each is a new ask or refusal from the pack's own rules. How often it asks in real sessions is not measured.
