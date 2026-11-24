# Guards and rule ids

Every check openmorals makes, the rule id it reports, what it catches, its default decision, how many test cases it has and what is known to get past it. Status: everything on this page is **Built** as of 0.5.0 unless marked **Planned**. 0.5.0 added inbound scanning, the taint rule `taint.injected-content` and four self-protect cases.

The rule id is what appears in square brackets in a hook answer (`openmorals ask [destructive.git-force-push]: ...`), in `openmorals check` output and in the audit log.

## How to count the cases yourself

Counts go stale. These commands give the current number, run from the repository root. The figures in brackets were measured on 24 Nov 2026 at version 0.3.1.

| Case table | Command | Count (0.3.1) |
|---|---|---|
| destructive | `grep -c '^ *- {' cases/destructive.cases.yaml` | 121 |
| online-delete | `grep -c '^ *- {' cases/online-delete.cases.yaml` | 46 |
| secrets | `grep -c '^ *- {' cases/secrets.cases.yaml` | 43 |
| self-protect | `grep -c '^ *- {' cases/self-protect.cases.yaml` | 50 (54 at 0.5.0) |
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

Each YAML case names a command (or a tool call), the decision expected and often the rule. `npm test` runs every table. A test in `test/engine.test.ts` also removes each built-in guard in turn and checks that every one of its ask and deny cases then fails, so a guard cannot pass its own table by accident.

To count cases for one rule id: `grep -c 'rule: destructive.sql-drop' cases/*.yaml`. Many cases give only the expected decision and leave the rule to the guard prefix, so this undercounts.

## The five built-in guards

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

- `mv ~/projects /tmp/gone` (a move is not a delete);
- `chmod -R 000 ~`;
- `> important.txt` and `cp /dev/null ~/.bashrc` (emptying a file);
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

Known gaps: commands that change but do not delete (`gh pr close`, `kubectl apply`, `terraform apply`) are allowed; an API call made from a script or SDK is not seen; an MCP tool is judged only by the adapters' name heuristic (`adapter.mcp-delete`, below). The `production-ops` pack adds asks for apply-type commands.

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
| `self-protect.write` | a write, an output redirect, `sed -i`, `mv`, `rm` or similar onto `openmorals.yaml`, `.claude/settings*.json`, the Codex, Gemini CLI and opencode hook and plugin files (`.codex/hooks.json`, `.codex/config.toml`, `.gemini/settings.json`, `.opencode/plugins/`, `opencode.json` and user-level forms), the audit log, the `.openmorals/` trash and undo log; and `openmorals init` or `openmorals purge` run by the agent |

This stops an agent from quietly switching the guard off or emptying the trash. Known gap: a program the agent starts can still edit these files, because openmorals does not read scripts. `sandbox run` keeps them read-only for the command it runs.

### budget

Defaults: tool calls soft **400** (ask, then again every 100), hard **1500** (deny); tokens soft 2,000,000, hard 5,000,000, step 500,000. A limit of 0 switches that check off. Source: [`src/guards/budget.ts`](../../src/guards/budget.ts). Cases: [`cases/budget.cases.yaml`](../../cases/budget.cases.yaml).

| Rule id | Catches |
|---|---|
| `budget.tool_calls.soft` / `budget.tool_calls.hard` | tool calls in this session |
| `budget.tokens.soft` / `budget.tokens.hard` | tokens in this session, only when the host reports them |

Known gaps: the Claude Code hook input carries no token counts, so with Claude Code only tool calls are counted (token budgets are Planned there). Parallel tool calls can race on the session file, so a count may come out a little low.

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
| `taint.rule-of-two` | a step that reaches the network, in a session where untrusted content has entered (a web fetch to a host not in `trusted_hosts`, a web search, an `mcp__` tool, a network command's output, a Read outside the project, or since 0.5.0 a weak inbound finding) and private data has been touched (a credentials path, an environment dump, a token or keychain command, or a secret-shaped value in a prompt the user sent anyway) |

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

## Checks added by the Codex, Gemini CLI and opencode adapters

Source: [`src/adapters/codex/pipeline.ts`](../../src/adapters/codex/pipeline.ts). Cases: the three adapter tables above. Details: [docs/adapters.md](../adapters.md).

| Rule id | Catches | Decision |
|---|---|---|
| `adapter.host-config` | a file-write tool aimed at an agent tool's own hook or plugin config | the `self-protect` decision |
| `adapter.mcp-delete` | an MCP tool whose name contains a delete word (`delete`, `destroy`, `drop`, `purge`, `remove`, `wipe`, `truncate`, `terminate`, `unpublish`, `erase`, `rm`) | the `online-delete` decision |

On Windows these adapters read every shell command as PowerShell, as a POSIX shell and as cmd.exe, and keep the strictest answer (0.3.1; see [ADR 0008](../adr/0008-windows-three-dialects-keep-the-strictest.md)). `adapter.mcp-delete` is a guess from the tool's name; openmorals cannot see what an MCP tool really does. Classifying MCP tools in the bylaws is Planned.

## Your own rules

`rules[]` in `openmorals.yaml` adds checks: each has an `id`, a `match` on `tool`, `command` or `path` (regular expressions), a decision of `ask` or `deny` (never `allow`: a rule can only add a check) and an optional `hard`. They report as `rules.<id>`. Examples ship in the [packs](../../packs/).

## Fail-closed answers

These ids mean openmorals could not judge normally, so it asked (or denied, under `--unattended` or for a `hard` guard or rule). See [ADR 0005](../adr/0005-fail-closed-ask-on-error.md).

| Rule id | When |
|---|---|
| `parser.opaque` | the command's effect cannot be seen: a computed command name, `curl ... \| sh`, `base64 -d \| bash` |
| `parser.error` | the command could not be parsed |
| `<guard>.error` | a guard threw (deny if the guard is `hard`, for example `secrets.error`) |
| `rules.<id>.error` | your rule threw (deny if the rule is `hard`) |
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
