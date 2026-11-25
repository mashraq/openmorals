# Guards and rule ids

Every check openmorals makes, the rule id it reports, what it catches, its default decision, how many test cases it has and what is known to get past it. Status: everything on this page is **Built** as of 0.5.0 unless marked **Planned** (the document guard as of 0.18.0). 0.5.0 added inbound scanning, the taint rule `taint.injected-content` and four self-protect cases.

The rule id is what appears in square brackets in a hook answer (`openmorals ask [destructive.git-force-push]: ...`), in `openmorals check` output and in the audit log.

## How to count the cases yourself

Counts go stale. These commands give the current number, run from the repository root. The figures in brackets were measured on 24 Nov 2026 at version 0.3.1.

| Case table | Command | Count (0.3.1) |
|---|---|---|
| destructive | `grep -c '^ *- {' cases/destructive.cases.yaml` | 121 |
| online-delete | `grep -c '^ *- {' cases/online-delete.cases.yaml` | 46 |
| secrets | `grep -c '^ *- {' cases/secrets.cases.yaml` | 43 |
| self-protect | `grep -c '^ *- {' cases/self-protect.cases.yaml` | 50 (54 at 0.5.0, 105 at 0.6.2) |
| budget | `grep -c '^ *- {' cases/budget.cases.yaml` | 19 |
| loop detector | `grep -cE "^\s*\{ name: '" test/extras/loop.test.ts` | 29 |
| taint judge | `grep -cE "^\s*\{ name: '" test/extras/taint.test.ts` | 35 |
| install scanner | after `npm run build`: `node -e "import('./dist/test/scanner/cases.js').then(m=>console.log(m.CASES.length))"` | 84 (42 must be flagged, 42 benign look-alikes) |
| reviewer | same, `dist/test/reviewer/cases.js`, export `REVIEW_CASES` | 36 |
| sandbox planner | same, `dist/test/sandbox/cases.js`, export `PLAN_CASES` | 46 |
| trash (undo) | same, `dist/test/extras/undo.cases.js`, export `TRASH_CASES` | 35 |
| Codex adapter | same, `dist/test/adapters/codex/cases.js`, export `CODEX_CASES` | 25 |
| Gemini CLI adapter | same, `dist/test/adapters/gemini-cli/cases.js`, export `GEMINI_CASES` | 26 |
| opencode adapter | same, `dist/test/adapters/opencode/cases.js`, export `OPENCODE_CASES` | 25 |
| inbound scanning (0.5.0) | `grep -c '^ *- {' cases/inbound.table.yaml` | 52 at 0.5.0 (24 flagged, 28 benign look-alikes) |
| document (0.18.0) | `grep -c '^ *- {' cases/document.cases.yaml` | 50 at 0.18.0 (31 ask, 19 allow) |

`openmorals eval` (0.7.0) prints the row counts per guard together with the catch rate, the false-alarm rate and the time per decision ([eval.md](../eval.md)).

Each YAML case names a command (or a tool call), the decision expected and often the rule. `npm test` runs every table. A test in `test/engine.test.ts` also removes each built-in guard in turn and checks that every one of its ask and deny cases then fails, so a guard cannot pass its own table by accident.

To count cases for one rule id: `grep -c 'rule: destructive.sql-drop' cases/*.yaml`. Many cases give only the expected decision and leave the rule to the guard prefix, so this undercounts.

## The six built-in guards

Defaults are those of `openmorals init` with no pack. Every decision can be changed in `openmorals.yaml` ([schema](../../API.md#openmoralsyaml-schema-version-1)).

### destructive

Default: **ask**. Source: [`src/guards/destructive.ts`](../../src/guards/destructive.ts). Cases: [`cases/destructive.cases.yaml`](../../cases/destructive.cases.yaml).

| Rule id | Catches |
|---|---|
| `destructive.recursive-delete` | recursive, forced or wildcard deletes: `rm -rf`, `rm -r -f`, `rm -f`, `rm *.log`, `find -delete`, `xargs rm`, `del /s /q`, `rd /s`, PowerShell `Remove-Item -Recurse -Force`, and recursive deletes in inline code such as `python3 -c "shutil.rmtree(...)"` or `node -e "fs.rmSync(..., {recursive: true})"` |
| `destructive.git-force-push` | `git push --force`, `-f`, `+refspec`, `--mirror`, `--prune` |
| `destructive.git-reset-hard` | `git reset --hard` |
| `destructive.git-clean` | `git clean -f` and its forms |
| `destructive.git-branch-delete` | `git branch -D` |
| `destructive.git-discard` | `git checkout -- .` and `git restore` that overwrite uncommitted work |
| `destructive.git-stash-drop` | `git stash drop` and `git stash clear` |
| `destructive.git-rewrite` | history rewrites (`git filter-branch`, `git filter-repo`) and `git update-ref -d` |
| `destructive.sql-drop` | `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, `DELETE` without `WHERE`, Redis `FLUSHALL`/`FLUSHDB` |
| `destructive.truncate` | the `truncate` command |
| `destructive.disk-format` | formatting or repartitioning a disk (`mkfs*`, `newfs`, `format`, `diskutil erase...`, partition-table tools) |
| `destructive.disk-write` | `dd` onto a device, output redirected onto a device |
| `destructive.shred` | `shred` |
| `destructive.rsync-delete` | `rsync --delete` |
| `destructive.docker-prune` | `docker system prune`, other prunes, `docker volume rm`, `docker compose down -v` |

`allow_targets` lists plain relative names (for example `dist`, `node_modules`) that may be deleted without asking. It is empty by default, so `rm -rf node_modules` asks unless a pack or the user adds it. When the guard stops a delete, the reason names `openmorals trash <path>` as the recoverable alternative.

Known evasions (each measured with `openmorals check` on 0.3.1, all answered **allow**):

- `mv ~/projects /tmp/gone` (a move is not a delete; since 0.18.0 moving a document out of the project folder asks, see [document](#document-0180));
- `chmod -R 000 ~`;
- `> important.txt` and `cp /dev/null ~/.bashrc` (emptying a file; since 0.18.0 the [document guard](#document-0180) asks when the file exists and is not empty);
- `npm run clean`, `make clean`, `bash cleanup.sh` (openmorals reads the command line, never the script it starts);
- functions or aliases defined in an earlier tool call; text built by a program at run time; PowerShell script-block strings.

Known false positives (on the safe side): `grep "DROP TABLE" src` asks.

### online-delete

Default: **ask**. Source: [`src/guards/online-delete.ts`](../../src/guards/online-delete.ts). Cases: [`cases/online-delete.cases.yaml`](../../cases/online-delete.cases.yaml).

| Rule id | Catches |
|---|---|
| `online-delete.cloud-delete` | `gh repo delete` and other `gh ... delete`; `aws s3 rm`/`rb` and `aws ... delete-*`/`terminate-*`; `gcloud ... delete`; `az ... delete`; `kubectl delete`; `helm uninstall` |
| `online-delete.infra-destroy` | `terraform destroy`, `pulumi destroy` |
| `online-delete.package-unpublish` | `npm unpublish`, `cargo yank` |
| `online-delete.http-delete` | an HTTP DELETE through `curl`, `wget`, httpie, `Invoke-RestMethod`, `gh api -X DELETE` |
| `online-delete.git-remote-delete` | `git push --delete` and `git push origin :branch` |

Known gaps: commands that change but do not delete (`gh pr close`, `kubectl apply`, `terraform apply`) are allowed; an API call made from a script or SDK is not seen; an MCP tool is judged only by the adapters' name heuristic (`adapter.mcp-delete`, below; on Claude Code since 0.8.1, before that not at all). The `production-ops` pack adds asks for apply-type commands.

### secrets

Defaults: read **ask**, write **ask**, send **deny**, `hard: true` (an error inside this guard denies rather than asks). Source: [`src/guards/secrets.ts`](../../src/guards/secrets.ts). Cases: [`cases/secrets.cases.yaml`](../../cases/secrets.cases.yaml).

| Rule id | Catches |
|---|---|
| `secrets.read` | reading `.env*` (not `.env.example`), `~/.ssh` (not `*.pub`), cloud credential files, `.netrc`, `.npmrc`, `.pypirc`, key and certificate files |
| `secrets.write` | writing to those files |
| `secrets.send` | one command line that reads one of those, a `*_TOKEN`/`*_SECRET`-style variable or the whole environment, **and** reaches the network (curl, wget, `git push`, `npm publish`, `docker push`, cloud CLIs; one shared list in [`src/network.ts`](../../src/network.ts)) |

Known evasions: a script that reads a secret and posts it (`node upload.js`); a credential path assembled from pieces at run time; a read and a send split across two tool calls (the taint judge covers part of this after untrusted input). Known false positive: any command line that mentions `.env` and also calls `curl` is denied, even when the two are unrelated.

### self-protect

Default: **ask**. Source: [`src/guards/self-protect.ts`](../../src/guards/self-protect.ts). Cases: [`cases/self-protect.cases.yaml`](../../cases/self-protect.cases.yaml).

| Rule id | Catches |
|---|---|
| `self-protect.write` | a write, an output redirect, `sed -i`, `mv`, `rm` or similar onto `openmorals.yaml`, `.claude/settings*.json`, the Codex, Gemini CLI and opencode hook and plugin files (`.codex/hooks.json`, `.codex/config.toml`, `.gemini/settings.json`, `.opencode/plugins/`, `opencode.json` and user-level forms), the audit log, the session files, the `.openmorals/` trash and undo log; and `openmorals init` or `openmorals purge` run by the agent. Since 0.6.2: anything in the real config directory (from `configDir()`, so `OPENMORALS_HOME` counts whatever the folder is called); that directory or any folder above it given to a command that moves, removes, links, changes permissions, extracts or syncs onto it, or copied onto so that something lands on it; a protected path inside any argument (an interpreter one-liner's code); a path reached through a symbolic link |

This stops an agent from quietly switching the guard off or emptying the trash. Reading and listing stay allowed (`cat`, `tail`, `ls`, `du`, `find` without `-delete`/`-exec`, `cd`, `openmorals audit`).

How 0.6.2 reads a path: as written; with `~`, `$HOME`, `$XDG_CONFIG_HOME`, `$OPENMORALS_HOME`, `%APPDATA%`, `$env:APPDATA` and similar expanded; made absolute from the working directory (a bare word such as `test` only when that file exists); and resolved through symbolic links (a path that does not exist yet is resolved from its deepest existing folder; a link whose target is missing is read). A relative link target given to `ln`, `mklink` or `New-Item` is read from the link's own folder. This costs about 50 microseconds per decision on the machine it was measured on.

Known gaps: a program the agent starts can still edit these files, because openmorals does not read scripts (a script it writes and runs, a `package.json` script run through `npm test`); a path assembled at run time inside code; a folder mounted into a container. The answer to these is the OS sandbox: `sandbox run` keeps them read-only for the command it runs ([threat model](threat-model.md)). Known false alarms: a protected file name inside a text argument (`gh pr create --title "Tighten openmorals.yaml"`), and code that names a folder above the config directory (`python3 -c "print(os.path.expanduser('~/.config'))"`).

### budget

Defaults: tool calls soft **400** (ask, then again every 100), hard **1500** (deny); tokens soft 2,000,000, hard 5,000,000, step 500,000. A limit of 0 switches that check off. Source: [`src/guards/budget.ts`](../../src/guards/budget.ts). Cases: [`cases/budget.cases.yaml`](../../cases/budget.cases.yaml).

| Rule id | Catches |
|---|---|
| `budget.tool_calls.soft` / `budget.tool_calls.hard` | tool calls in this session |
| `budget.tokens.soft` / `budget.tokens.hard` | tokens in this session, only when the host reports them |

Known gaps: the Claude Code hook input carries no token counts, so with Claude Code only tool calls are counted (token budgets are Planned there). Parallel tool calls can race on the session file, so a count may come out a little low.

### document (0.18.0)

Default: **ask**; `allow` switches it off. Source: [`src/guards/document.ts`](../../src/guards/document.ts). Cases: [`cases/document.cases.yaml`](../../cases/document.cases.yaml) (50 rows) and [`test/document.test.ts`](../../test/document.test.ts) (the other four hosts' write tools, the fail-closed branches, the settings).

It asks before an agent removes what a document holds. A **document** is a file whose name extension is in `guards.document.extensions` (by default prose and office formats: `md`, `markdown`, `mdx`, `txt`, `text`, `rst`, `adoc`, `asciidoc`, `org`, `tex`, `rtf`, `doc`, `docx`, `odt`, `pages`, `pdf`, `xls`, `xlsx`, `ods`, `numbers`, `ppt`, `pptx`, `odp`, `key`) and that no `guards.document.exclude` glob covers (by default the folders `node_modules`, `vendor`, `dist`, `build`, `target`, `coverage`, `.git`, `.venv` at any depth). Source code, lockfiles and generated output are not documents: only emptying them counts.

| Rule id | Catches |
|---|---|
| `document.delete` | `rm`, `unlink`, `del`, `erase`, `Remove-Item` or `git rm` (not `--cached`) of an existing document; a patch's `Delete File` of one; `mv` of a document to a place outside the project folder |
| `document.empty` | a write, edit, patch or command that leaves any existing non-empty file empty (a whole-file write of nothing or only whitespace; `> file`, `: > file`, `echo > file`, `cp /dev/null file`, `Clear-Content`) |
| `document.shrink` | a write that leaves a document smaller by more than `shrink_percent` of its size (default 25) and by at least `min_removed_bytes` (default 512, so a small file rewritten is not asked about) |
| `document.heading` | a write that leaves a document with fewer headings: Markdown `#` and underlined headings outside code fences and front matter, reStructuredText underlines, AsciiDoc, Org and LaTeX section commands (renaming a heading is not removing it) |
| `document.unknown` | a write onto an existing document that openmorals cannot judge: the tool gives no new content or does not say which text it replaces; the text was over the 262,144-byte cap; the document is over the 262,144 bytes openmorals reads where it needs the text; a shell redirect (`>`, a heredoc), `cp` or `mv` replaces it with output it cannot see |
| `document.unreadable` | the file exists but cannot be read (no permission), so the write or delete cannot be judged |

How it measures: one `stat` of each path, for the size in bytes before the write; the size after comes from what the host sends (the whole new text; or each edit's old and new text, counted as many times as it occurs when the edit replaces every occurrence; or a patch's removed and added lines). The file's text is read, at most 262,144 bytes and only in memory, where the heading count or the replace-all count needs it; the edits are then applied to that text in memory so headings are counted on the whole file. Nothing of the file or the write is stored: the session history and the audit line keep the tool and the path only. A new file and a folder are never asked about; an append (`>>`, or a write that only adds) is never asked about.

Which guard asks: a command the destructive guard already flags (`rm -f`, `rm -r`, wildcards, `find -delete`, `git clean`, `truncate`, `shred`, `mv` onto the null device, `git checkout -- .`, `git restore`) is left to it, so one action is asked about once; with `destructive: allow` the document guard still asks on a document delete. An MCP tool with a delete word in its name stays with `adapter.mcp-delete`.

What each host's write tool gives it ([docs/adapters.md](../adapters.md#document-guard-what-each-hosts-write-tools-give-it-0180)): the whole new text or the replaced and replacing text on Claude Code (`Write`, `Edit`, `MultiEdit` when its items carry `old_string`/`new_string`), Gemini CLI (`write_file`, `replace`), opencode (`write`, `edit`) and OpenClaw (`write`); the removed and added lines of a patch on Codex, opencode and OpenClaw (`apply_patch`, `patch`). Only the file name on OpenClaw `edit`, Claude Code `NotebookEdit`, an opencode V2 `permission.evaluate` `edit`, a patch's `Move to` target and an MCP tool's path argument: there an existing document asks (`document.unknown`).

**Guaranteed**, on a host that calls openmorals before the tool runs and honours its answer: the ask happens before the write, delete or command runs. **Not seen**: files changed by a program the agent runs (a script, `sed -i`, `perl -i`, a build step, `npm run clean`), a delete or overwrite whose path is built at run time, `git rm -r` of a folder, a document outside the extension list, and every host with no check point. On opencode V2, where the ask is raised by `permission.evaluate`, every edit of an existing document asks, because that event names the file only. Nothing here has been run against a live agent.

Settings: `guards.document.decision`, `shrink_percent`, `min_removed_bytes`, `extensions`, `exclude` ([schema](../../API.md#openmoralsyaml-schema-version-1)). A project file may raise the decision, lower the share and the byte floor, add extensions and drop exclusions, and can never loosen your own file ([ADR 0010](../adr/0010-the-user-file-is-a-floor.md)).

## Session checks (need the session's history)

### loop

Default: **ask**; `allow` switches it off. Source: [`src/loop/detect.ts`](../../src/loop/detect.ts). Cases: the `LOOP_CASES` table in [`test/extras/loop.test.ts`](../../test/extras/loop.test.ts).

| Rule id | Catches |
|---|---|
| `loop.repeat` | the same command, read or fetch for the 4th time with no file written in between |
| `loop.polling` | 6 polling steps (`sleep`, `tail`, `ps`, `Start-Sleep`, cmd `timeout /t`, `gh run view`, `kubectl get` and similar) with no write in between |
| `loop.near-repeat` | 5 steps that differ only in numbers, hashes or quoted text |
| `loop.repeated-failure` | the same command failed 3 times with the same error |

Known gaps: heuristics over command text; tool calls with no input (`other`) are not tracked; `loop.repeated-failure` needs the outcome of each call: Claude Code reports it, and since 0.5.0 so do the Codex, Gemini CLI and opencode V2 post-tool hooks (opencode V1 reports no failures, see [docs/adapters.md](../adapters.md)). Thresholds are fixed defaults; setting them in the bylaws is Planned.

### taint

Default: **ask**; `allow` switches it off. Source: [`src/taint/taint.ts`](../../src/taint/taint.ts). Cases: the `TAINT_CASES` table in [`test/extras/taint.test.ts`](../../test/extras/taint.test.ts).

| Rule id | Catches |
|---|---|
| `taint.injected-content` (0.5.0) | a step that reaches the network or touches private data, in a session where the inbound scan found hidden instructions (a strong finding) in a tool result, a fetched page or a prompt, or could not scan one |
| `taint.rule-of-two` | a step that reaches the network, in a session where untrusted content has entered (a web fetch to a host not in `trusted_hosts`, a web search, an `mcp__` tool, a network command's output, a Read outside the project, or since 0.5.0 a weak inbound finding) and private data has been touched (a credentials path, an environment dump, a token or keychain command, a secret-shaped value in a prompt the user sent anyway, or since 0.16.0 a file under `private_paths`) |

How it marks the session: by the **shape of the action** before it runs, and since 0.5.0 also by **what came back**, through the inbound scan ([docs/scanner.md](../scanner.md#inbound-scanning-050)). The reason of `taint.injected-content` is the only text the model sees about a finding by default (215 characters for a hidden HTML comment in a fetched page, measured 24 Nov 2026). Known gaps: data passed through a script is not followed; a file read through the shell (`cat /tmp/x`) does not taint; taint does not fade, so once a session is tainted and has touched secrets, every network step asks, harmless ones too.

## Inbound scanning (0.5.0)

Not a guard on actions: it reads content after a tool ran, and a prompt before the model sees it. Default: on, `decision: ask`, `notify: false`, `max_bytes: 262144`. Source: [`src/inbound/`](../../src/inbound/). Cases: [`cases/inbound.table.yaml`](../../cases/inbound.table.yaml) (52; 28 benign look-alikes that must not be flagged) and [`test/inbound.test.ts`](../../test/inbound.test.ts). Details and limits: [docs/scanner.md](../scanner.md#inbound-scanning-050).

| Rule id | Finds | Strength | In a tool result | In a prompt |
|---|---|---|---|---|
| `inbound.hidden-characters` | Unicode tag characters, bidi controls outside balanced right-to-left text, 3+ zero-width characters in a row, stacked variation selectors | strong | taint (`injected`), audit; notice only with `notify` | `guards.inbound.decision` (ask: warn the user; deny: block) |
| `inbound.split-phrase` | an override phrase broken up by hidden characters | strong | as above | as above |
| `inbound.html-comment` | an HTML comment addressed to the agent | strong | as above | marks the session only |
| `inbound.encoded-instruction` | base64 that decodes to instructions or a download-and-run command | strong | as above | marks the session only |
| `inbound.instruction-phrase` | a visible override phrase, not quoted or introduced as an example | weak | taint (`untrusted`), audit | marks the session only |
| `inbound.secret-shape` | a vendor access token or a private key block (prompts only) | strong | not checked | `guards.secrets.send` (deny: the message is not sent) |
| `inbound.error` | the scan failed | | treated as a strong finding | ask (deny unattended) |

A tool result is never blocked. Known evasions: paraphrase, homoglyphs, instructions in plain prose, a phrase wrapped tightly in quotes, a JSON value that is exactly the phrase, the middle of a result longer than `max_bytes`, a payload after the first 64 base64 runs.

## Checks added by the adapters (Codex, Gemini CLI, opencode, OpenClaw; `adapter.mcp-delete` also Claude Code since 0.8.1)

Source: [`src/adapters/codex/pipeline.ts`](../../src/adapters/codex/pipeline.ts). Cases: the three adapter tables above. Details: [docs/adapters.md](../adapters.md).

| Rule id | Catches | Decision |
|---|---|---|
| `adapter.host-config` | a file-write tool aimed at an agent tool's own hook or plugin config | the `self-protect` decision |
| `adapter.mcp-delete` | an MCP tool whose name contains a delete word (`delete`, `destroy`, `drop`, `purge`, `remove`, `wipe`, `truncate`, `terminate`, `unpublish`, `erase`, `rm`) | the `online-delete` decision |

On Windows these adapters read every shell command as PowerShell, as a POSIX shell and as cmd.exe, and keep the strictest answer (0.3.1; see [ADR 0008](../adr/0008-windows-three-dialects-keep-the-strictest.md)). `adapter.mcp-delete` is a guess from the tool's name; openmorals cannot see what an MCP tool really does. Classifying MCP tools in the bylaws is Planned.

## Your own rules

`rules[]` in `openmorals.yaml` adds checks: each has an `id`, a `match` on `tool`, `command` or `path` (regular expressions; since 0.15.0 also `content`, since 0.16.0 also `detector` and `network`), a decision of `ask` or `deny` (never `allow`: a rule can only add a check) and an optional `hard`. They report as `rules.<id>`. Examples ship in the [packs](../../packs/).

Since 0.15.0 `match` also takes `content`: a pattern over what a write puts in a file and over the arguments and agent message a call carries (case-insensitive, `^` and `$` at line ends, matched in linear time; backreferences and lookaround are refused at load). Content over 262,144 bytes is cut, and a search that runs out of its step budget gives up; in both cases a deny rule takes the content as matched and an ask rule asks, with the same `rules.<id>` and a reason that says so. What each host's write carries: [docs/adapters.md](../adapters.md#content-rules-what-content-carries-on-each-host-0150).

### Detectors and `network` (0.16.0)

`match.detector` names one built-in detector or a list of them (the rule matches when any one finds its pattern); `match.network: true` makes a rule match only an action that reaches the network, by the taint guard's own computation (`actionReachesNetwork` in [`src/taint/taint.ts`](../../src/taint/taint.ts): a fetch, a command one of whose parts talks to the network, an `mcp__` tool, web search or web fetch). `network: false` is refused at load: leave the key out to match either way. Every field given must match, so `{ detector: card-number, network: true }` reads "a card number, in an action that reaches the network".

```yaml
rules:
  - id: no-card-numbers-out
    match: { detector: card-number, network: true }
    decision: deny
    reason: A card number must not leave this machine.
  - id: ask-identifiers-written
    match: { tool: "^(Write|Edit)$", detector: [us-ssn, nhs-number] }
    decision: ask
```

Detectors read a write's content, the command line, the URL, and for any other tool its input as it was sent (every key, string and number, one per line, **not redacted**, because the redactor removes exactly the token shapes `secret-token` looks for). That raw text stays in memory for the one decision: the session history drops it, the reason says only `(found by <detector>: <count>)`, and when your bylaws name any detector, the hits of those detectors are replaced by `[<detector>]` in the audit line, the session history and the text the reviewer is sent. With no detector named nothing is masked. Text over 262,144 bytes is cut; if nothing was found in the part kept, a deny rule denies and an ask rule asks, as for content rules. Source: [`src/rules/detectors.ts`](../../src/rules/detectors.ts). Cases: [`cases/detectors.cases.yaml`](../../cases/detectors.cases.yaml) (32 rows) and [`test/detectors.test.ts`](../../test/detectors.test.ts).

These detectors find **likely patterns**: a shape plus a checksum or validity rule. A hit does not show the value is real, issued, or anyone's personal or health data, and a miss says nothing about what else the text holds. Nothing here is a compliance control.

| Detector | Fires on | Does not fire on | Misses |
|---|---|---|---|
| `secret-token` | the vendor token shapes the redactor knows (`TOKEN_PATTERNS`): `sk-...`, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_...`, `github_pat_...`, `xox?-...`, `AKIA`/`ASIA` + 16, `AIza...`, `glpat-...`, `npm_...` | a placeholder such as `<your token>`, a shape not in the list | passwords, private keys (use a content rule), JWTs, other vendors' tokens, anything split, encoded or compressed |
| `card-number` | 13 to 19 digits starting 2 to 6, together or in card groupings (4-4-4-4, 4-4-4-1..4, 4-4-4-4-1..3, 4-6-5, 4-6-4) with one kind of space or dash, passing Luhn | the published test card numbers (Stripe's testing page and the common sandbox numbers), a failing Luhn check, a number inside a longer number or word, after a decimal point or after `+` | other groupings, numbers split over lines or fields, numbers starting 1, 7, 8 or 9, encoded numbers; about 1 in 10 random numbers of that shape passes Luhn, so some ids fire |
| `iban` | a capital country code from the IBAN length table, two check digits, then that country's length, together or in groups of four, passing mod-97 | a wrong length for the country, a failing check, a lower-case country code | countries not in the table, other groupings, account numbers that are not IBANs; the standard documentation examples (GB82 WEST ...) pass and fire |
| `us-ssn` | `AAA-GG-SSSS` or `AAA GG SSSS`, or nine bare digits with `ssn` or `social security` in the 40 characters before; area not 000, 666 or 900-999, group not 00, serial not 0000 | numbers breaking those rules, bare nine digits without the label, the shape inside a longer run (`1-123-45-6789-2`) | unlabelled bare numbers, other formats; it cannot tell issued from unissued, so placeholders such as 123-45-6789 fire |
| `nhs-number` | ten digits as 3-3-4 with one kind of space or dash, or ten bare digits with `nhs` in the 40 characters before, passing modulus 11 | a failing check digit, bare ten digits without the label, the shape inside a longer run | unlabelled bare numbers, other groupings; about 1 in 11 random ten-digit numbers passes, so some 3-3-4 phone numbers fire; no test range is exempted |
| `email` | `local@domain` with a dotted domain and a letter top-level domain, outside the names reserved by RFC 2606 and RFC 6761 (`example.com`/`.net`/`.org`, `.example`, `.test`, `.invalid`, `.localhost`) | reserved names, `user@host:path` (a git or ssh remote), `@scope/package`, a single-label host | obfuscated addresses, quoted local parts, non-ASCII addresses |
| `phone-e164` | `+`, a digit 1-9, 8 to 15 digits in all, together or with single spaces, dashes or dots | numbers without `+`, more than 15 digits, the fictional ranges (North American 555-0100 to 555-0199; UK drama ranges such as 020 7946 0xxx and 07700 900xxx) | national formats, brackets, extensions; it also fires on sums written as `+12345678` |
| `hl7-msh` | an HL7 version 2 header: `MSH` at a line start (or after a quote or space), a field separator, four or five distinct encoding characters, the separator again | `MSH` in running text, other segments alone | HL7 version 3 and CDA documents, messages whose `MSH` segment is not in the text |
| `fhir-patient` | a FHIR Patient resource: `"resourceType": "Patient"` in JSON, or `<Patient ... xmlns="http://hl7.org/fhir">` in XML | other resource types, the word Patient alone | patient data in other resources (Observation, Encounter ...) or formats |

Measured time at the 262,144-byte cap on this project's development machine (node v25.9.0, 28 inputs including adversarial repeats such as 256 K of `@`, `+` or `4111 `): the worst detector took 11.9 ms (`card-number` on `4111 ` repeated); a rule naming all nine runs each once per text, whatever the number of rules. One decision also shares one step budget across all its content patterns (four times the per-rule budget); past it the remaining content rules answer as "too costly" and fail closed.

### `guards.taint.private_paths` (0.16.0)

Globs (the `merge.always_review` grammar: relative to the project root, `*`, `?`, `**`; a glob with no `/` matches a name at any depth) of files that hold private data. Reading one, or a command that names one, marks the session as having touched private data, exactly like reading a credentials file: it never asks by itself, but a later step that reaches the network after untrusted content entered the session gets `taint.rule-of-two`. Outside the project only globs with no folder in them (such as `*.hl7`) match. Absent by default. A project file can add entries and can never remove one of yours ([ADR 0010](../adr/0010-the-user-file-is-a-floor.md)).

## Fail-closed answers

These ids mean openmorals could not judge normally, so it asked (or denied, under `--unattended` or for a `hard` guard or rule). See [ADR 0005](../adr/0005-fail-closed-ask-on-error.md).

| Rule id | When |
|---|---|
| `parser.opaque` | the command's effect cannot be seen: a computed command name, `curl ... \| sh`, `base64 -d \| bash` |
| `parser.error` | the command could not be parsed |
| `<guard>.error` | a guard threw (deny if the guard is `hard`, for example `secrets.error`) |
| `rules.<id>.error` | your rule threw (deny if the rule is `hard`) |
| `rules.<id>` (reason says cut or too costly) | a content or detector rule whose text was cut at 256 KB with nothing found in the part kept, or a content rule that could not be searched within its step budget or the decision's shared one (0.16.0): deny for a deny rule, ask for an ask rule |
| `document.unknown`, `document.unreadable` (0.18.0) | a write onto an existing document that cannot be judged (no new content, text cut at 256 KB, a redirect over it) or a document that cannot be read: ask |
| `bylaws.invalid` | `openmorals.yaml` is invalid; the defaults are used and openmorals asks |
| `engine.error` | an internal error, or the CLI crashed while answering a hook |
| `hook.bad-input` | the hook input on stdin could not be read |
| `hook.unknown-target` | `openmorals hook` was given an unknown host name |
| `budget.unmeasured` | the session counter, history or taint state could not be saved |
| `audit.unwritable` | the audit log could not be written |
| `loop.error`, `taint.error` | a session check threw |
| `inbound.error` | the inbound scan failed; the session is treated as holding hidden instructions |

## The reviewer

The reviewer is not a guard. It never produces its own rule from nothing. When it escalates an ask to a deny (only with `reviewer.on_escalate: deny`), the rule id becomes `<original rule>+reviewer.escalate`. Cases: `REVIEW_CASES` (above). See [ADR 0007](../adr/0007-reviewer-can-only-escalate.md) and [docs/reviewer.md](../reviewer.md).

## The install scanner

`openmorals scan` has its own 35 rules (27 content rules and 8 from the file walk) with severities that map to deny (critical), ask (high, medium) or allow (low). They run on files before install, not on tool calls. The full table, with what each rule detects and the shapes measured to get past it, is in [docs/scanner.md](../scanner.md#the-rules). Count them after a build with `node -e "import('./dist/src/scanner/rules.js').then(m=>console.log(m.SCAN_RULES.length))"`.
