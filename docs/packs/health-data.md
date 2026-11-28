# The `health-data` pack (0.31.0)

The pack's first line and its disclaimer, word for word:

> Not compliance and not medical safety. This pack notices a few patient-data shapes (some structured identifiers, HL7, FHIR and DICOM files, and folders you declare as clinical) and asks before they are written, committed or sent; it refuses to send a detected identifier over the network. It cannot see names, addresses, dates or free-text notes, cannot tell real data from synthetic data, and misses most of the eighteen HIPAA Safe Harbor identifiers. It does not make software or data compliant with HIPAA, GDPR or any other law or standard, does not de-identify anything, and does not make an agent fit to give medical advice. Whether data is protected health information, whether processing is lawful, and whether software is a medical device are questions for your privacy officer, a lawyer or a regulatory professional.

That is all the pack claims. A test compares both to this text, character for character.

Nothing in this pack or on this page is medical advice, and openmorals never sees what an agent says to a person. For a health question, talk to a doctor or another licensed clinician and act on their advice.

Off unless you choose it. One rule refuses (an identifier sent over the network); every other rule asks. It calls no model and costs no tokens unless a rule asks or refuses (then the agent reads the rule's one-line reason). With `--unattended` an ask becomes a deny.

## Using it

- A new project: `openmorals init --pack health-data` writes it as the project's `openmorals.yaml`. A project file can only make your user-level settings stricter.
- An existing project file: `openmorals packs add health-data` adds it to the nearest `openmorals.yaml`. It can only tighten: it prints each change, keeps a backup, and writes nothing if a setting would be looser or a rule id is already used with other content; `--dry-run` prints the changes only. It refuses over a file that already has `privacy`: the two share principle ids, with other text, and nothing is replaced.
- For every project: copy `packs/health-data.yaml` (`openmorals packs health-data` prints it) to `openmorals.yaml` in your openmorals config folder.
- Declare your clinical folders. The pack ships one example, `clinical-data/` (a folder of that name at any depth). A folder is declared in two places in the file: as a glob under `guards.taint.private_paths` (so a read marks the session) and as a name in the path pattern of the `&clinical` anchor (so writes, commits and sends ask). A test checks that the two agree for the shipped example; when you edit one, edit the other.
- It is not a superset of [`privacy`](privacy.md): card numbers, IBANs, email addresses, phone numbers, database dumps and paste sites are that pack's. To have both, use `privacy` as your user-level file and this pack as the project file.
- `openmorals packs show health-data` prints the principles and the disclaimer.

## What it checks

| rule | decision | when |
|---|---|---|
| `hd-identifier-to-network` | deny | a US social security number or an NHS number (modulus 11) in a command, URL or tool input that reaches the network |
| `hd-record-to-network` | ask | an HL7 v2 message (an `MSH` segment) or a FHIR `Patient` resource in an action that reaches the network |
| `hd-identifier-written` | ask | either identifier, an HL7 message or a FHIR `Patient` resource in what a file-edit tool writes |
| `hd-clinical-write` | ask | a file-edit tool writes a clinical file |
| `hd-clinical-shell-write` | ask | `cp`, `mv`, `tee`, `rsync`, `install`, `ditto`, `dd`, `truncate` or an output redirect in a command that names a clinical file (writing one, or copying one elsewhere) |
| `hd-clinical-commit` | ask | `git add`, `git stage` or `git commit` naming a clinical file |
| `hd-clinical-send` | ask | a command that names a clinical file and reaches the network (`curl -F file=@...`, `curl -T`, `scp`) |
| `hd-dicom-send` | ask | a DICOM network tool: `storescu`, `dcmsend`, `movescu`, `getscu`, `findscu`, `echoscu`, `dcmqrscp`, `storescp` |

Clinical files: `.hl7`, `.dcm`, `.dicom`, `.ccda`, `.ccd`, files named `*.fhir.json`, `*.fhir.xml` or `*.fhir.ndjson`, and the folders you declare. An argument that is a URL is not taken for a local file.

Reading a clinical file is never asked about. It marks the session as holding private data (`guards.taint.private_paths`), so the taint guard asks before a later step that reaches the network once untrusted content (a web page, an MCP tool's output, a file from outside the project) has also entered the session. Without untrusted content in the session, a read followed by a send asks only if a rule above matches the send.

The identifiers and record shapes come from the built-in detectors ([details](../architecture/guards.md#detectors-and-network-0160)); their hits are masked in the audit log and session history.

## Guards it sets

`taint` (ask, the built-in default) with the clinical `private_paths` above. Everything else is at the defaults.

## Principles

Checked (each only as far as the named rules or guards reach): `identifiers-not-sent-over-the-network` (`hd-identifier-to-network`), `patient-records-sent-only-when-confirmed` (`hd-record-to-network`, `hd-clinical-send`, `hd-dicom-send`), `patient-data-written-only-when-confirmed` (`hd-identifier-written`, `hd-clinical-write`, `hd-clinical-shell-write`), `clinical-files-committed-only-when-confirmed` (`hd-clinical-commit`), `clinical-reads-marked-as-private-data` (guard `taint`).

Advice only, not checked: the identifiers it cannot see (names, addresses, dates, ages, medical record and health plan numbers, free text, images, anything encoded); whether data is real or synthetic; it removes no identifiers from any data; whether data is protected health information, lawful processing, consent, the minimum necessary and the agreements your organisation needs (your privacy officer or a lawyer); whether software is a medical device (a regulatory professional, and see [`regulated-software`](regulated-software.md)); medical advice (never seen; talk to a licensed clinician); data sent by a program the agent writes and runs, and clinical files swept in by `git add .`.

## What it does not cover

- Names, addresses, dates, ages, free-text notes, medical record numbers, health plan numbers and most other identifiers, and anything inside an image, a PDF, an archive or an encoding. DICOM files are recognised by name only; their contents are not read.
- A file written or sent by a script or a program the agent writes and runs, or by a shell command other than those listed.
- `git add .`, `git add -A` or `git commit -a` that sweep a clinical file in: only a clinical file named on the command line.
- An MCP tool or web call that uploads a clinical file by path: such a call carries no path the rules can match (its content is still read by the detectors).
- A removal (`rm`) of a clinical file: the delete and destructive guards decide those, as without the pack.

## Known false alarms

- Synthetic patients in test fixtures ask when written and are refused when an identifier among them is sent; the pack cannot tell them from real ones.
- A command that names a clinical file and redirects its output anywhere (`grep ... clinical-data/a.csv > out.txt`) asks.
- An NHS-number-shaped value with an `nhs` label, or a formatted social-security-shaped value, inside other data asks or is refused.

## Measured

- Case table `cases/health-data.cases.yaml`, 63 rows: 55 judged under the pack (31 that must ask or refuse, 24 benign, including three reads of clinical files), 8 with the pack off (every one allows). `openmorals eval`: caught 31/31, false alarms 0/24, every row matched.
- Removal test (`test/packs-wave2.test.ts`): deleting any one rule makes exactly its own catching rows (3 to 5 per rule) fail as missed. Changing one character of the disclaimer or of the first line fails the fixed-text comparison.
- Cost for an ordinary session: with the pack laid over each benign row of the other case files as a project file, it asks or refuses on 3 of the 504 benign rows: `detectors.cases.yaml` row 31 (a FHIR `Patient` resource written to a fixture: asked) and `privacy.cases.yaml` rows 9 and 28 (a social security number sent with curl: refused; written to a fixture: asked). How often it asks in real sessions is not measured.
