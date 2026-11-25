# The `outward-actions` pack (0.26.0)

**Not a certification, an audit or legal advice.** This pack asks before some commands that reach other people, spend money or cannot be undone, and names the openmorals guards that check some others. It does not judge whether the software or the agent's work is harmful. That no rule fired means none of these commands was attempted, not that no harm was done.

It is named for what it checks. There is no pack called "do no harm": no rule can show that work is harmless, and the checkable part of that idea is the core guards, which are on by default.

Off unless you choose it. Rules only add asks; it calls no model and costs no tokens unless a rule asks (then the agent reads the rule's one-line reason, 48 to 104 characters). With `--unattended` an ask becomes a deny.

## Using it

- A new project: `openmorals init --pack outward-actions` writes it as the project's `openmorals.yaml`. A project file can only make your user-level settings stricter.
- For every project: copy `packs/outward-actions.yaml` (`openmorals packs outward-actions` prints it) to `openmorals.yaml` in your openmorals config folder.
- With another pack: copy its `rules:` and `principles:` entries into your file; a principle naming a guard needs that guard listed under the same file's `guards:`.
- `openmorals packs show outward-actions` prints the principles and the disclaimer.

## Rules

| rule | asks when |
|---|---|
| `out-publish` | `npm`, `pnpm`, `yarn`, `bun`, `cargo`, `poetry`, `flit`, `hatch`, `uv`, `vsce` or `ovsx` `publish`; `dart`/`flutter pub publish`; `twine upload`; `gem push`; `nuget push`; `gh release create`/`upload`/`edit`; `docker`/`podman push`; `helm push`. Not with `--dry-run` |
| `out-message-people` | `sendmail`, `mail`, `mailx`, `mutt`, `swaks`, `msmtp` run as a command; `git send-email`; `gh issue`/`gh pr` `create`, `comment`, `close`, `reopen`, `merge`, `review`, `edit`, `lock`; `glab issue`/`mr` `create`, `note`, `close`, `reopen`, `merge`; a command naming a Slack, Discord, Teams, Telegram, Twilio, SendGrid or Mailgun message endpoint |
| `out-spend-money` | `aws ec2 run-instances`, `request-spot-instances`, `purchase-reserved-instances-offering`, `allocate-hosts`, `aws rds create-db-instance`/`-cluster`; `gcloud compute instances create`, `gcloud sql instances create`, `gcloud container clusters create`; `az vm create`, `az aks create`, `az sql server create`; `doctl compute droplet create`; `hcloud server create`; `stripe` charges, payouts, refunds, transfers, payment intents, subscriptions or invoices with `create`, `capture`, `confirm` or `pay` |
| `out-kill-or-disable` | `kill ... -1` (every process you own), `killall`, `pkill`; `launchctl` `disable`, `stop`, `unload`, `bootout`, `remove`, `kill`; `systemctl` `disable`, `stop`, `mask`, `kill`, `poweroff`, `reboot`, `halt`, `isolate`; `service NAME stop`; `crontab -r`; `shutdown`, `reboot`, `halt`, `poweroff` |
| `out-rewrite-history` | `bfg` (the BFG Repo-Cleaner, also as `java -jar bfg*.jar`); `git reflog expire --expire=now`; `git gc --prune=now`, which remove what could recover rewritten commits |

Commands such as `mail`, `kill` and `shutdown` are matched where a command starts (after `;`, `&`, `|`, `(`, a quote, `sudo`, `nohup` or `exec`), so `grep -r mail src` or `git log --grep shutdown` is not asked about.

`git filter-branch`, `git filter-repo`, `git push --force` (and `--mirror`, `--prune`, `--force-with-lease`) already ask through the `destructive` guard, and deleting a repository or a cloud resource through `online-delete`; the pack maps its principles to those guards instead of repeating them.

## Guards it sets

`destructive` (ask), `online-delete` (ask), `outbound` (recipient ask: a blind copy, a new outside recipient, or an address seen only in untrusted output). These are the built-in defaults: for someone on the defaults they change nothing; over a looser user-level file, as a project file, they raise it back.

## Principles

Checked (each only as far as the named rules or guards reach): `ask-before-publishing` (`out-publish`), `ask-before-messaging-people` (`out-message-people`, guard `outbound`), `ask-before-spending-money` (`out-spend-money`), `ask-before-stopping-services` (`out-kill-or-disable`), `ask-before-rewriting-history` (`out-rewrite-history`, guard `destructive`), `ask-before-deleting-online` (guard `online-delete`), `ask-before-what-cannot-be-undone` (guard `destructive`).

Advice only, not checked: harm done by what the software does once shipped (a dark pattern, a biased rule, a privacy-hostile default); what the agent says to a person; the same actions done by a script, an SDK or a tool the pack does not list; how many files a change deletes or rewrites; and that no rule firing does not mean no harm was done.

## What it does not cover

- The same actions through a script, an SDK, a cloud console, another mail client or cloud, or an MCP server's own tools. The OS sandbox (`openmorals sandbox`) can keep the network off.
- A plain `git push`. The `strict` and `beginner` packs ask about it; this pack does not, because pushing to your own branch is ordinary work.
- Spending through tools not listed (other clouds, other payment APIs, paid API calls from code). The `budget` guard limits the session's own calls and tokens; it is not part of this pack's claims.
- Whether the software or the agent's work does harm.

## Known false alarms

- `gh pr create` and `gh pr merge` ask every time, also on your own repository.
- `killall` and `pkill` ask even for a process you started a minute ago (a dev server).
- `docker push` to a private registry asks.
- `git gc --prune=now` asks even when nothing was rewritten.

## Measured

- Case table `cases/outward-actions.cases.yaml`, 72 rows: 67 judged under the pack (40 that must ask, 27 benign), 5 with the pack off (every one allows). `openmorals eval`: caught 40/40, false alarms 0/27, every row matched.
- Removal test (`test/packs-wave1.test.ts`): deleting any one rule makes exactly its own catching rows (4 to 9 per rule) fail as missed.
- Cost for an ordinary session: with the pack laid over each benign row of the other case files as a project file, it asks or refuses on 3 of the 456 benign rows: `online-delete.cases.yaml` row 28 (`npm publish`, a new ask from `out-publish`: publishing is not a delete, so that file allows it), `destructive.cases.yaml` row 116 (`rm -rf build` where that row's user file sets destructive to allow; the pack raises it to ask) and `online-delete.cases.yaml` row 49 (an MCP `delete_file` where that row's user file sets online-delete to allow). Under the default user settings the only new ask among existing benign rows is `npm publish`. How often it asks in real sessions is not measured.
