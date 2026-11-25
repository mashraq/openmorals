# Contributing

Thank you for helping. Bug reports, new evasion cases and fixes are all welcome.

What to work on next, in order, is in [docs/contributing/roadmap.md](docs/contributing/roadmap.md). Where the code lives, how to build and test it, and each area's limits are in [docs/contributing/handover.md](docs/contributing/handover.md).

## Before you open a pull request

```sh
npm install
npm run build   # strict TypeScript; `any` is not allowed
npm test        # every case file and unit test must pass
```

- **A guard change comes with cases.** Add rows to the guard's file in `cases/`. Include at least one case that fails without your change and one that shows you did not block something harmless. A reported evasion is best filed as a failing case.
- **Fail closed.** New code must never turn an error, a timeout or an unreadable input into `allow`.
- **Keep the core pure.** `decide()` and the guards do no I/O. Files, the clock and the environment belong to the adapter and the CLI.
- **Cross-platform.** Use `node:path` and `node:os`, no shell scripts, and test Windows paths and PowerShell or `cmd` syntax where they apply.
- **No real secrets or personal data** in code, cases or fixtures. Use obviously fake values such as `ghp_FAKE…` and `example.test` domains.
- New dependencies need a stated reason in the pull request.

## Developer Certificate of Origin

Every commit must be signed off to certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the change, or otherwise have the right to submit it under the project's licence.

```sh
git commit -s -m 'Add an evasion case for split rm flags'
```

This adds a line like `Signed-off-by: Your Name <you@example.com>`. Pull requests with unsigned commits cannot be merged.

By contributing, you agree that your contribution is licensed under the Apache License 2.0.
