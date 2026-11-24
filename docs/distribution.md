# Distribution: npm, a single binary, or pip

There is one implementation of openmorals: the TypeScript engine in `src/`. The
three ways to install it all run that same engine. The binary is the engine plus
the Node.js runtime in one file; the Python package is a launcher for the binary
and contains no decision code.

| Route | Needs | Install | Status |
|---|---|---|---|
| npm | Node.js 20 or later | `npm install -g openmorals`, or `npx openmorals ...` | Not yet published to npm. Until then: clone, `npm install && npm run build && npm link`. |
| Binary | Nothing | Download `openmorals-<os>-<arch>` from the GitHub release, check it against `SHA256SUMS`, put it on your PATH. | Built by `.github/workflows/release.yml`; no release has been made yet. |
| pip | Python 3.9 or later | `pip install openmorals` | Wheels built by the same workflow; not yet published to PyPI. |

Targets for the binary and the wheels: `linux-x64`, `linux-arm64` (glibc 2.28 or
later), `macos-arm64`, `macos-x64` (macOS 13.5 or later), `windows-x64` (Windows 10
or later). These are the minimums of the Node.js 26 builds that the binary
contains (nodejs/node `BUILDING.md`, v26.x, read 24 Nov 2026). There is no binary
for Alpine/musl, Windows on Arm or the BSDs; use npm there.

All three routes give you the same `openmorals` command, so the hook line that
`openmorals init` writes (`openmorals hook claude-code`) works with any of them as
long as `openmorals` is on the PATH the agent's host uses. If it is not, pass the
full path: `openmorals init --hook-command "/full/path/to/openmorals hook claude-code"`.

## How the binary is built

Mechanism: Node.js single executable applications, built with Node's own
`node --build-sea` (added in Node 25.5.0). Source:
https://nodejs.org/api/single-executable-applications.html, read 24 Nov 2026 (the
page for Node v26.13.1; the feature is marked "Stability: 1.1 - Active
development"). The release builds with Node 26.13.1, the current LTS line.

`scripts/build-binary.mjs`:

1. Bundles the compiled CLI (`dist/src/cli.js`) and its one runtime dependency,
   `yaml`, into a single CommonJS file with esbuild (a development dependency,
   pinned to an exact version). A bundler is needed because a single executable
   loads only Node's built-in modules from inside itself ("module loading does not
   read from the file system"); Node's newer virtual file system for single
   executables needs Node 26.9 or later and is marked early development.
2. Adds the five bylaws packs (`packs/*.yaml`) as single-executable assets. Inside
   the binary, `openmorals packs` and `openmorals init --pack` read them with
   `node:sea` instead of from a folder.
3. Runs `node --build-sea` with code cache on, then, on macOS, signs the result ad
   hoc (`codesign --sign -`), which Apple silicon requires before it will run a
   modified executable.
4. Starts the binary with `--version` and fails unless it prints the version in
   `package.json`.
5. Writes `build/THIRD-PARTY-LICENSES.txt`: the binary contains Node.js (MIT, with
   the licences of its own dependencies) and `yaml` (ISC), and those licences ship
   with it.

The script refuses to build with a Node.js that links `libnode` as a shared
library (Homebrew's build, for one): the result would need those libraries at run
time and would not be a single file. `--allow-shared-node` overrides this for a
local experiment only. Homebrew's Node also lacks the marker `--build-sea` writes
into, so on such a machine no binary can be built at all; use an official Node.js
build from nodejs.org, or the release workflow.

```sh
npm ci && npm run build
node scripts/build-binary.mjs                 # build/openmorals (openmorals.exe on Windows)
node scripts/build-binary.mjs --release-name  # build/openmorals-<os>-<arch>[.exe]
node scripts/compare-binary.mjs build/openmorals --timing 10
```

## What is verified, and how

- **The binary gives the same answers as the Node CLI.** `scripts/compare-binary.mjs`
  runs every case in `cases/*.cases.yaml` (279 today) through both `node
  dist/src/cli.js` and the binary, command cases with `check --json` and tool cases
  with `hook claude-code`, plus `--version`, `packs`, `sandbox plan` for each
  platform, `scan`, `validate`, invalid hook input, and `init --pack` for every
  pack (the written file is compared too, which proves the embedded packs are the
  shipped ones). Any difference in stdout or exit code fails it. The release
  workflow and CI run it on every target. It was checked to catch a difference: a
  stand-in that set `OPENMORALS_UNATTENDED=1` produced 185 differences and a
  failing exit code.
- **The release files are what was built.** The release workflow writes
  `SHA256SUMS` over every binary and wheel, checks it, and attaches it to the
  release. Check a download before you run it:

  ```sh
  sha256sum -c SHA256SUMS --ignore-missing            # Linux
  shasum -a 256 -c SHA256SUMS --ignore-missing        # macOS
  ```
  ```powershell
  (Get-FileHash .\openmorals-windows-x64.exe -Algorithm SHA256).Hash   # compare with the line in SHA256SUMS
  ```

  A checksum file published next to the binary proves the download is intact and
  is the file the workflow built. It does not prove who built it: the files are not
  signed (see below).
- **The Python package runs only the binary its wheel was built with.** Each wheel
  records the binary's SHA-256, size, platform and version in
  `openmorals/_binary.json`. Before running it, the wrapper checks all four; the
  hash is computed on first use and again whenever the file's size, time or inode
  changes (it keeps a small stamp file next to the binary; hashing the binary takes
  about 50 ms on an Apple silicon Mac). This catches a damaged or partial install,
  a wheel for another platform and a stray source install. It is not a defence
  against someone who can write to your `site-packages`: they could change the
  Python code too.
- **The workflow itself** is held by `test/release-workflow.test.ts`: it runs only
  on a `v*` tag or by hand, reads by default, only the publish job (only on a tag
  push) may write, every action is pinned to a full commit SHA, and no secret but
  the built-in token is used.

## The Python package

`pip install openmorals` installs the wheel for your platform. Each wheel holds the
binary under `openmorals/bin/`, so nothing is downloaded at run time and no network
access is needed after install. The wheels are built by `python/build_wheel.py`
with the standard library only; the package has no Python dependencies.

- `openmorals ...` and `python -m openmorals ...` run the binary with the same
  arguments, stdin, stdout and exit code (on Linux and macOS the Python process is
  replaced by the binary; on Windows it waits for it and returns its exit code).
- `openmorals.check(command, *, shell="posix", bylaws=None, unattended=False,
  cwd=None, env=None, timeout=60.0) -> Decision` runs `openmorals check --json` and
  returns `Decision(decision, rule, reason, bylaws)`.

When it cannot run the engine, it fails closed:

| What went wrong | `openmorals ...` | `openmorals hook <host>` | `openmorals.check()` |
|---|---|---|---|
| No binary in the install (source install), binary missing, size or SHA-256 differs, wheel for another platform, version mismatch, platform not supported | Prints why on stderr, exit code 69 | Prints why on stderr, and on stdout the answer that makes the host ask (Claude Code: `permissionDecision: "ask"`; `deny` with `--unattended` or `OPENMORALS_UNATTENDED`) or block (Codex, Gemini CLI, opencode), exit code 0 | Returns `ask` with rule `python.binary-unavailable` |
| The binary crashed or was killed | Its exit code is passed through | The same ask or block answer | Returns `ask` with rule `python.binary-unavailable` |
| The binary printed no verdict, timed out, or its exit code disagrees with its verdict | (not applicable) | (not applicable) | Returns `ask` with rule `python.binary-unavailable` |

The hook answers with exit code 0 on purpose: Claude Code reads the JSON answer only
when a hook exits with 0, and treats any other code except 2 as a non-blocking error
and runs the tool. The fallback answers have the same shape as the engine's own
fail-closed answers, which the Python tests compare against the binary.

There is no source distribution on PyPI: a source install carries no binary and
would only ever fail closed. On a platform without a wheel, pip reports that no
matching distribution exists.

## Unsigned binaries: macOS Gatekeeper and Windows SmartScreen

The binaries are not signed with a developer certificate and not notarised. The
macOS ones carry only an ad hoc signature, which Apple silicon needs to run them at
all but which identifies nobody.

- **macOS.** A binary downloaded with a web browser is marked as quarantined, and
  Gatekeeper refuses to open it ("cannot be opened because the developer cannot be
  verified" or "Apple could not verify ..."). After checking it against
  `SHA256SUMS`, either allow it once under System Settings > Privacy & Security >
  "Open Anyway", or remove the mark: `xattr -d com.apple.quarantine
  ./openmorals-macos-arm64`. Then `chmod +x` it. A file fetched with `curl` is not
  marked. The binary inside a pip wheel is written by pip itself, which as far as we
  know does not add the mark (not yet observed on a real install).
- **Windows.** A downloaded `.exe` carries the "Mark of the Web", and SmartScreen
  may stop it with "Windows protected your PC". After checking the hash, choose
  "More info" > "Run anyway", or run `Unblock-File .\openmorals-windows-x64.exe` in
  PowerShell. Some antivirus products are suspicious of any unsigned executable
  that embeds a script runtime.
- **Linux** has neither check; `chmod +x` and run.

Signing and notarisation need the maintainer's certificates and are not done by
this workflow.

## What has been run where

On the development machine (macOS, Apple silicon, Python 3.9.6), 24 Nov 2026:

- The esbuild bundle was built, and the bundle run by plain Node gave the same
  answer as the multi-file CLI for all 279 guard cases; only the pack comparisons
  differed, as expected outside a single executable (there are no assets to read).
  Start-up plus `check "git status"`, median of 7: bundle 73.8 ms, multi-file CLI
  87.8 ms.
- **No binary was built there.** That machine's Node.js is a Homebrew
  shared-library build, which has no single-executable marker (`node --build-sea`
  answers "sentinel ... not found"), and an official Node.js build was not fetched.
  So the binary's size and start time on macOS, and every run of a real binary, come
  from the release workflow.
- The Python tests (29) ran against a stand-in executable that runs `node
  dist/src/cli.js`, and a wheel built around that stand-in installed with pip into
  a fresh virtual environment and ran `openmorals`, `python -m openmorals`, the
  hook and `openmorals.check()`.

Only CI shows: the binary on all five targets, its size and start time (each build
job writes them to the run summary), the verdict comparison against a real binary,
the Python tests against a real binary on Linux (Python 3.9 and 3.13), macOS and
Windows, and the wheels installed by pip on each target. Intel macOS is
best-effort: Node's documentation says single executables on x64 macOS are not
tested upstream, so that build may fail without stopping the release, which then
has no `macos-x64` files.

## Making a release (maintainers)

1. Set the version in `package.json`, `src/version.ts`, `python/openmorals/__init__.py`
   and `python/pyproject.toml` (tests fail if they differ), and add a CHANGELOG entry.
2. Dry run: start the `release` workflow by hand (GitHub > Actions > release > Run
   workflow, or `gh workflow run release.yml --ref main`). It builds and tests every
   target and uploads the files as workflow artifacts; it creates no release.
3. Push a tag `v<version>`. The workflow checks that the tag matches `package.json`,
   builds and tests again, and creates the GitHub release with the binaries, wheels,
   `SHA256SUMS` and `THIRD-PARTY-LICENSES.txt`.
4. Publishing to npm (`npm publish`) and PyPI (upload the wheels from the release)
   is done by hand with the maintainer's accounts; the workflow holds no
   credentials for either.
