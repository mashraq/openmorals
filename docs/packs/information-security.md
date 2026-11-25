# The `information-security` pack (0.26.0)

**Not a certification, an audit or legal advice.** This pack asks before a few command and file-edit shapes associated with some [OWASP Top 10:2025](https://top10.owasp.org/2025/0x00_2025-Introduction) and [NIST SSDF](https://csrc.nist.gov/pubs/sp/800/218/final) categories, and names the openmorals guards that check some others. It does not test your code for vulnerabilities and does not show conformity with OWASP, the SSDF or any other standard or law. That no rule fired means none of these shapes was attempted, not that the work is secure.

Off unless you choose it. Rules only add asks; it calls no model and costs no tokens unless a rule asks (then the agent reads the rule's one-line reason, 55 to 105 characters). With `--unattended` an ask becomes a deny, as everywhere.

## Using it

- A new project: `openmorals init --pack information-security` writes it as the project's `openmorals.yaml`. A project file can only make your user-level settings stricter ([ADR 0010](../adr/0010-the-user-file-is-a-floor.md)).
- For every project: copy `packs/information-security.yaml` (`openmorals packs information-security` prints it) to `bylaws.yaml` in your openmorals config folder.
- With another pack: copy its `rules:` and `principles:` entries into your file. A principle that names a guard needs that guard listed under the same file's `guards:`.
- `openmorals packs show information-security` prints the principles, split into checked and advice only, and the disclaimer.

## Rules

| rule | asks when |
|---|---|
| `sec-tls-verify-off` | `curl -k` / `--insecure` (also inside a cluster such as `-sSk`), `wget --no-check-certificate`, `http.sslVerify false` (git config or `-c`), `NODE_TLS_REJECT_UNAUTHORIZED=0`, `PYTHONHTTPSVERIFY=0`, `GIT_SSL_NO_VERIFY=1`, `npm config set strict-ssl false` |
| `sec-world-writable` | `chmod` with an octal mode whose last digit lets everyone write (`777`, `0777`, `666`, `1777`), or a symbolic mode giving others write (`a+w`, `o+w`, `go+w`, `o=rwx`) |
| `sec-registry-override` | npm, pnpm, yarn, bun, npx, pip, pipx, uv or poetry with `--registry`, `--index-url`, `--extra-index-url`, `--trusted-host`, `--index` or `--default-index`; `npm config set registry`; `pip config set ... index-url` or `trusted-host` |
| `sec-install-from-url` | an install (`install`, `add`, `i`) whose package is `git+...`, `http(s)://...` or `github:...` (a URL that is the value of a registry option is the rule above); `cargo install --git` |
| `sec-pipe-to-shell` | a `curl`, `wget` or `Invoke-WebRequest` download piped into `sh`, `bash`, `zsh`, `dash`, `ksh` or `iex`; `sh -c "$(curl ...)"`; `bash <(curl ...)` |
| `sec-ci-pipeline-write` | a file-edit tool writes `.github/workflows/`, `.github/actions/`, `.gitlab-ci.yml`, `Jenkinsfile`, `azure-pipelines.yml`, `.circleci/`, `bitbucket-pipelines.yml`, `.buildkite/` or `.travis.yml` |
| `sec-ci-pipeline-remove` | `rm`, `mv`, `unlink`, `del`, `erase`, `Remove-Item` or `Move-Item` (so `git rm`, `git mv`) names one of those pipeline paths |

File-edit tools are the same list as the `test-lock` pack's ([extras.md](../extras.md#the-test-lock-pack-090)). Reading a pipeline file is never asked about.

`curl ... | sh` already asks without the pack (the engine's parser cannot see what the piped script does: `parser.opaque`), as do `wget ... | sudo bash` and `iwr ... | iex`. The rule adds the forms that were allowed before: `| bash -s`, `sh -c "$(curl ...)"`, `bash <(curl ...)`.

## Guards it sets

`secrets` (read ask, write ask, send deny, hard), `self-protect` (ask), `taint` (ask), `inbound` (on, ask), `outbound` (credential ask, look-alike ask, a credential to a look-alike deny, a relayed code deny). These are the built-in defaults, so for someone on the defaults they change nothing. Laid over a user-level file that set one of them looser, as a project file, they raise it back to these settings: the principles below name these guards, and a claim must not rest on a guard that is off.

## Principles

Checked (each only as far as the named rules or guards reach):

| principle | checked by | drawn from |
|---|---|---|
| `transport-verified` | `sec-tls-verify-off` | OWASP A04:2025 Cryptographic Failures |
| `no-world-writable-files` | `sec-world-writable` | OWASP A02:2025 Security Misconfiguration |
| `dependencies-from-known-sources` | `sec-registry-override`, `sec-install-from-url` | OWASP A03:2025 Software Supply Chain Failures |
| `no-unread-code-run` | `sec-pipe-to-shell` | OWASP A08:2025 Software or Data Integrity Failures |
| `build-pipeline-protected` | `sec-ci-pipeline-write`, `sec-ci-pipeline-remove` | NIST SP 800-218 (SSDF) |
| `credential-files-guarded` | guard `secrets` | OWASP A07:2025 Authentication Failures |
| `guard-settings-and-log-protected` | guard `self-protect` | OWASP A09:2025 Security Logging and Alerting Failures |
| `private-data-not-sent-after-untrusted-input` | guard `taint` | OWASP Top 10 for Agentic Applications 2026 |
| `injected-instructions-flagged` | guard `inbound` | OWASP Top 10 for Agentic Applications 2026 |
| `passwords-only-to-known-sites` | guard `outbound` | OWASP A07:2025 Authentication Failures |

Advice only, not checked (text for you; the agent is not held to it): certificate checks switched off inside code; keys or tokens written into source; CI actions and dependencies not pinned; injection flaws (A05); access-control logic (A01); insecure design (A06); the software's own security logging (A09); handling of errors and unexpected conditions (A10).

"Drawn from" names where a principle comes from. It is not a claim that the pack meets that document.

## What it does not cover

- Anything inside a file the agent writes: `rejectUnauthorized: false`, `verify=False`, a key pasted into source, an unpinned `uses: owner/action@main`. A rule with `match.content` or the `secret-token` detector in your own file can ask about some of these ([extras.md](../extras.md)).
- A script or program the agent writes and then runs. It can do every one of the above unseen; the OS sandbox (`openmorals sandbox`) is the place for that.
- A shell redirect, `sed -i` or a copy into a pipeline file (only the file-edit tools, and `rm`/`mv` on one).
- Whether the code is secure. It sees command lines and paths, not what the code does.

## Known false alarms

- `curl -K file` (read options from a file) asks: rule patterns ignore case, so `-K` reads as `-k`.
- `curl -k` against your own development server with a self-signed certificate asks; approve it, or give the server a certificate.
- `chmod 777` on a throwaway folder asks.
- `--registry` for your company's own registry asks every time.
- A repository whose work is its CI pipeline will be asked about every pipeline edit.

## Measured

- Case table `cases/information-security.cases.yaml`, 79 rows: 72 judged under the pack (44 that must ask, 28 benign), 7 judged with the pack off (every one allows). `openmorals eval`: caught 44/44, false alarms 0/28, every row matched; the pack's own line is printed under the table.
- Removal test (`test/packs-wave1.test.ts`): deleting any one rule makes exactly its own catching rows (3 to 10 per rule) fail as missed.
- Cost for an ordinary session: with the pack laid over each benign row of the other case files as a project file, it asks or refuses on 2 of the 308 benign rows: `secrets.cases.yaml` row 49 (`cat .env` where that row's user file sets `secrets.read: allow`; the pack raises it back to ask) and `self-protect.cases.yaml` row 18 (`sed -i ... openmorals.yaml` where that row's user file sets self-protect to allow). Under the default user settings it adds no ask to any existing benign row; its own new asks are the 44 rows above. How often it asks in real sessions is not measured.
