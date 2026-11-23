# Security policy

openmorals exists to stop harmful actions, so a way past a guard is a security bug, and we want to hear about it.

## Reporting a hole

Please report it **privately**. Use GitHub's private vulnerability reporting: on the repository page, open **Security → Report a vulnerability**. Do not open a public issue for something that lets an action through which should have been asked about or denied, that leaks a secret into the audit log, or that makes openmorals fail open.

Include:
- the exact command or tool input,
- the decision you expected and the one you got (`openmorals check --json "<command>"` shows both),
- the openmorals version (`openmorals --version`), your OS and the shell.

Please use fake secrets in your report.

We aim to acknowledge a report within 7 days and to agree a disclosure date with you. Fixes ship with a new case in `cases/`, so the hole stays closed.

## Scope

In scope: evasions of the guards, fail-open paths (an error that results in allow), secret values reaching the audit log, and `openmorals init` damaging a settings file.

Out of scope: things the README lists as limits. One example is code that runs inside a script openmorals never sees; a hook is not a sandbox. Better coverage of those is still welcome as a normal issue.

## Supported versions

Only the latest release gets security fixes during 0.x.
