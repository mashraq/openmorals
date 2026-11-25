# The packages guard (0.32.0)

On by default, with decision `ask`. Before a command installs a package by name that the project's own manifest and lockfile do not list, it asks. An agent can name a package that does not exist, or the near-miss of one that does (`expresss`, `requestss`), and someone may have published code under that name that runs the moment it installs.

Covered: `npm install` (`i`, `add`), `pnpm add`, `yarn add`, `yarn global add`, `bun add`, `pip`, `pip3` and `python -m pip install`, `uv pip install`, `uv add`, `poetry add`, `pdm add`, `cargo add`, `go get`, `gem install`, `bundle add`, `composer require`. Rule id: `packages.unlisted`.

The lists it reads, in the working folder or the nearest folder above it that has one (up to six folders up): `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`; `requirements*.txt` (the common names), `constraints.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock`, `Pipfile`, `Pipfile.lock`, `setup.cfg`, `setup.py`, `pdm.lock`; `Cargo.toml`, `Cargo.lock`; `go.mod`, `go.sum`; `Gemfile`, `Gemfile.lock`, `gems.rb`; `composer.json`, `composer.lock`. Python names compare as PEP 503 says (case, `-`, `_` and `.` are one).

Not judged:

- a name the project already lists (a version change of it included);
- a bare install from the manifest (`npm install`, `npm ci`, `pip install -r requirements.txt`, `pip install -e .`);
- an install from a path, URL or git (the diff rule `integrity.lockfile` points at a lockfile that resolves from git or plain http);
- a project with no list file of that kind: a fresh project has nothing to compare with.

It misses: `npx`, `pnpm dlx`, `bunx` and `pipx run` (they run a package without adding it), a name written into the manifest by hand and installed afterwards (the diff rules `integrity.dependency-added` and `integrity.lockfile` see that), a typo that matches another listed name, and a listed name that is itself a bad package. It does not look a name up in a registry: it says only that the project does not list it.

```yaml
guards:
  packages:
    decision: ask    # deny refuses instead; allow switches it off
```

A project file can make it stricter, never looser. The `ci-unattended` pack sets it to `deny`.

Measured on its case table (`cases/packages.cases.yaml`, 45 rows): 22 of 22 caught, 0 of 23 false alarms. How often it asks in real sessions is not measured.
