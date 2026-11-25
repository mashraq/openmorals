# The `regulated-software` pack (0.31.0)

**Not a certification, an audit or legal advice.** This pack asks before an agent changes files under the paths you declare as regulated, risk and hazard files, and third-party components, and its merge settings send every change under the declared paths to review when you run openmorals diff-class. It does not decide whether software is regulated or is a medical device, produces no verification evidence or design records, and does not show that a change meets your quality process or any standard or law. Whether software is regulated, and what its process requires, are questions for a regulatory or quality professional. That no rule fired means none of these changes was attempted, not that the work is fit for release.

The pack is domain-neutral: the regulated code may be a medical device, clinical decision support, a financial-reporting or trading system, or anything else your organisation controls. It never guesses which code is regulated; you declare it.

Off unless you choose it. Rules only add asks; it calls no model and costs no tokens unless a rule asks. With `--unattended` an ask becomes a deny.

## Using it

- A new project: `openmorals init --pack regulated-software` writes it as the project's `openmorals.yaml`. A project file can only make your user-level settings stricter, and may add `merge.always_review` paths.
- For every project: copy `packs/regulated-software.yaml` (`openmorals packs regulated-software` prints it) to `openmorals.yaml` in your openmorals config folder.
- Declare your regulated folders. The pack ships one example, `regulated/` (a folder of that name at any depth). A folder is declared in two places in the file: as a name in the path pattern of the `&regulated` anchor (so the hook asks before a change) and as a glob under `merge.always_review` (so [`openmorals diff-class`](../merge-verdict.md) sends any change under it to review). When you edit one, edit the other.
- `openmorals packs show regulated-software` prints the principles and the disclaimer.

## Rules

| rule | asks when |
|---|---|
| `reg-path-write` | a file-edit tool changes a file under a declared regulated path |
| `reg-path-shell-write` | `cp`, `mv`, `tee`, `rsync`, `install`, `ditto`, `dd`, `truncate`, `sed -i`, `perl -i` or an output redirect in a command that names a file under a declared path |
| `reg-risk-file-write` | a file-edit tool changes a file whose name holds risk, hazard, FMEA or safety followed by analysis, file, register, case, assessment, log or matrix (`risk-analysis.md`, `hazard_register.xlsx`, `FMEA-matrix.csv`, `safety-case.md`) |
| `reg-soup-change` | a package is added, updated or removed: `npm`/`pnpm`/`yarn`/`bun` `install NAME`, `add`, `update`, `upgrade`, `uninstall`, `remove`; `pip install NAME`, `pip uninstall`; `poetry`, `uv`, `cargo`, `pdm`, `hatch` `add`/`remove`; `cargo update`; `go get`; `bundle add/update/remove`; `gem install`; `dotnet add ... package`; `composer require/remove/update`. Not `npm install` or `npm ci` with no package named, nor `pip install -r requirements.txt` |
| `reg-manifest-write` | a file-edit tool changes a lockfile or dependency manifest (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements*.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock`, `Cargo.toml`, `Cargo.lock`, `go.mod`, `go.sum`, `Gemfile(.lock)`, `composer.json/lock`, `pom.xml`, `build.gradle(.kts)` and others) |

## Merge settings it sets

`merge.always_review: [regulated/]`. When you run `openmorals diff-class` in CI from the base branch, a change under a declared path needs review (class B, reason `exclude.always-review`) whatever else the diff shows, even if it would otherwise be review-free. A test shows a byte-for-byte reproduced change under `regulated/` is review-free with your settings alone and needs review once the pack is the project file. The pack cannot check that the CI job exists, so this principle is listed as advice only.

## Principles

Checked (each only as far as the named rules reach): `declared-regulated-paths-changed-only-when-confirmed` (`reg-path-write`, `reg-path-shell-write`), `risk-files-changed-only-when-confirmed` (`reg-risk-file-write`), `third-party-components-changed-only-when-confirmed` (`reg-soup-change`, `reg-manifest-write`).

Advice only, not checked: that declared paths are reviewed before merge (only where diff-class runs in CI; the hook does not see merges); that each change traces to an approved change request; that its effect on risk was analysed and it was verified at the level your process requires (openmorals produces no verification evidence or design records); whether the software is regulated or a medical device (a regulatory or quality professional decides, then you declare the paths); changes made by scripts or other shell commands; and that no rule firing does not mean the work is fit for release.

## What it does not cover

- A change made by a script or program the agent writes and runs, or by a shell command other than the copy, move, edit-in-place and redirect forms listed.
- Whether a change traces to a change request, whether its risks were analysed, whether it was verified, and whether records were kept: these are your quality process, not a property of one action.
- Third-party code added by copying it in rather than through a package manager.
- Whether openmorals diff-class runs in your CI at all.

## Known false alarms

- Every package install, update or removal asks, including in a scratch folder.
- Any edit to `package.json`, also to its `scripts`, asks.
- A file such as `docs/risk-log.md` asks even if it is not part of your risk management file.

## Measured

- Case table `cases/regulated-software.cases.yaml`, 43 rows: 38 judged under the pack (22 that must ask, 16 benign), 5 with the pack off (every one allows). `openmorals eval`: caught 22/22, false alarms 0/16, every row matched.
- Removal test (`test/packs-wave2.test.ts`): deleting any one rule makes exactly its own catching rows (3 to 7 per rule) fail as missed; deleting `merge.always_review` turns the regulated change review-free again.
- Cost for an ordinary session: with the pack laid over each benign row of the other case files as a project file, it asks or refuses on 25 of the 454 benign rows: twenty-three package installs or removals (`information-security.cases.yaml` rows 37, 43, 44 and 75, `online-delete.cases.yaml` row 29, `outward-actions.cases.yaml` rows 27 and 62, and sixteen rows of `packages.cases.yaml`, 22 to 44, that the packages guard lets through because the project already lists the package or has no list file: `reg-soup-change`, which asks about every change of third-party software), a `package-lock.json` write (`document.cases.yaml` row 55) and a `package.json` edit (`test-lock.cases.yaml` row 34: `reg-manifest-write`). How often it asks in real sessions is not measured.
