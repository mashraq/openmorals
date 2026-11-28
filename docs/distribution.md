# Distribution: npm, a single binary, or pip

There is one implementation of openmorals: the TypeScript engine in `src/`. The
three ways to install it all run that same engine. The binary is the engine plus
the Node.js runtime in one file; the Python package is a launcher for the binary
and contains no decision code.

Nothing is published yet. The table says what each route will be; only the clone works today.

| Route | Needs | Install, once published | Status |
|---|---|---|---|
| Clone | Node.js 20 or later | `npm install && npm run build && npm link` in a clone of this repository | Works today. |
| npm | Node.js 20 or later | `npm install -g openmorals@<version>` (an exact version) | Ready to publish since 0.42.0 (see [the by-hand release list](#publishing-to-npm-by-hand)); not published. |
| Binary | Nothing | `openmorals-<os>-<arch>` from a GitHub release, checked against `SHA256SUMS`, on your PATH. | Built only by `.github/workflows/release.yml`, which is switched off; no release has been made. |
| pip | Python 3.9 or later | the `openmorals` wheel for your platform from PyPI | Wheels are built by the same workflow around the binary; none has been built or published. |

Targets for the binary and the wheels: `linux-x64`, `linux-arm64` (glibc 2.28 or
later), `macos-arm64`, `macos-x64` (macOS 13.5 or later), `windows-x64` (Windows 10
or later). These are the minimums of the Node.js 26 builds that the binary
contains (nodejs/node `BUILDING.md`, v26.x, read 24 Nov 2026). There is no binary
for Alpine/musl, Windows on Arm or the BSDs; use npm there.

All three routes give you the same `openmorals` command, so the hook line that
`openmorals init` writes (`openmorals hook claude-code`) works with any of them as
long as `openmorals` is on the PATH the agent's host uses. Since 0.41.2 `init`
refuses to write a hook whose program it cannot find on PATH, and writes nothing.
Then pass the full path: `openmorals init --hook-command "/full/path/to/openmorals hook claude-code"`.

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
2. Adds the bylaws packs (`packs/*.yaml`, six since 0.9.0) as single-executable assets. Inside
   the binary, `openmorals packs` and `openmorals init --pack` read them with
   `node:sea` instead of from a folder. Since 0.7.0 the case files
   (`cases/*.cases.yaml`, `cases/*.table.yaml`) travel the same way, for
   `openmorals eval`.
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
  platform, `scan`, `validate`, invalid hook input, `init --pack` for every
  pack (the written file is compared too, which proves the embedded packs are the
  shipped ones), and since 0.7.0 `eval --json` with the times and the source name
  set aside (both must exit 0, which proves the binary carries the case rows; a
  stand-in without them was checked to fail this comparison). Any difference in stdout or exit code fails it. The release
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

Once wheels are published, pip installs the one for your platform. Each wheel holds the
binary under `openmorals/bin/`, so nothing is downloaded at run time and no network
access is needed after install. The wheels are built by `python/build_wheel.py`
with the standard library only; the package has no Python dependencies.

- `openmorals ...` and `python -m openmorals ...` run the binary with the same
  arguments, stdin, stdout and exit code (on Linux and macOS the Python process is
  replaced by the binary; on Windows it waits for it and returns its exit code).
- `openmorals.check(command, *, shell="posix", bylaws=None, unattended=False,
  cwd=None, env=None, timeout=60.0) -> Decision` runs `openmorals check --json` and
  returns `Decision(decision, rule, reason, bylaws)`.
- `openmorals.guard(tool, input=None, *, session, cwd=None, actions=None,
  unattended=False, timeout=60.0) -> Decision` (Preview, 0.43.1) runs
  `openmorals guard --json` with the request on stdin and returns the same type
  (`bylaws` is `None`). See [API.md](../API.md#openmorals-guard---json-and-python-guard-preview-0431).

When it cannot run the engine, it fails closed:

| What went wrong | `openmorals ...` | `openmorals hook <host>` | `openmorals.check()` and `openmorals.guard()` (0.43.1) |
|---|---|---|---|
| No binary in the install (source install), binary missing, size or SHA-256 differs, wheel for another platform, version mismatch, platform not supported | Prints why on stderr, exit code 69 | Prints why on stderr, and on stdout the answer that makes the host ask (Claude Code: `permissionDecision: "ask"`; `deny` with `--unattended` or `OPENMORALS_UNATTENDED`) or block (Codex, Gemini CLI, opencode), exit code 0 | Returns `ask` with rule `python.binary-unavailable`; `deny` with `unattended=True` or `OPENMORALS_UNATTENDED` |
| The binary crashed or was killed | Its exit code is passed through | The same ask or block answer | Returns `ask` with rule `python.binary-unavailable`; `deny` with `unattended=True` or `OPENMORALS_UNATTENDED`, or when it exited with 2 |
| The binary printed no verdict, timed out, or its exit code disagrees with its verdict | (not applicable) | (not applicable) | Returns `ask` with rule `python.binary-unavailable`; `deny` with `unattended=True` or `OPENMORALS_UNATTENDED`, or when it printed deny or exited with 2 |

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

1. Set the version in `package.json`, `package-lock.json`, `src/version.ts`,
   `python/openmorals/__init__.py`, `python/pyproject.toml`, the install line in
   `README.md` and the tarball name in `docs/embedding.md` (tests fail if any of them but
   the lock file differs from `package.json`),
   and add a CHANGELOG entry.
2. Dry run: start the `release` workflow by hand (GitHub > Actions > release > Run
   workflow, or `gh workflow run release.yml --ref main`). It builds and tests every
   target and uploads the files as workflow artifacts; it creates no release.
3. Push a tag `v<version>`. The workflow checks that the tag matches `package.json`,
   builds and tests again, and creates the GitHub release with the binaries, wheels,
   `SHA256SUMS` and `THIRD-PARTY-LICENSES.txt`.
4. Publishing to npm ([the list below](#publishing-to-npm-by-hand)) and PyPI (upload the wheels from the release)
   is done by hand with the maintainer's accounts; the workflow holds no
   credentials for either.

Both workflows are switched off for now. Until one is run, steps 2 and 3 make no binary and no wheel, and npm can be published on its own with the list below.

## Publishing to npm by hand

The package is ready to publish since 0.42.0 and has not been published. Publishing is done by the maintainer, on the build machine, from the release commit, with the maintainer's own npm account. Nothing in this repository holds a credential or publishes by itself.

What makes it ready (0.42.0): `package.json` names the repository, homepage and issue tracker; `files` lists what ships; `prepack` runs `npm run clean && npm run build`, so `npm pack` and `npm publish` of the folder empty `dist/` and build again, but only when npm runs scripts: with `--ignore-scripts`, or `ignore-scripts=true` in an npm config, `prepack` does not run and whatever is in `dist/` ships (step 4 checks this). `test/pack-list.test.ts` reads npm's own dry-run list and fails if the tarball would lack a file the package needs (the bin, the export targets, a `.d.ts`, a pack, a case file, a skill, the README, LICENSE, NOTICE, CHANGELOG or API.md) or hold one it must not (compiled tests, sources, source maps, dotfiles, a built file with no source, a file under `packs/`, `cases/` or `skills/` that git does not track). In 0.42.0 the tarball holds 410 files, about 0.94 MB packed and 3.3 MB unpacked.

**What cannot be undone.** A published version number can never be used again, even after it is unpublished. Unpublishing is allowed within 72 hours of publishing if no other package depends on it; after that, only if no package depends on it, it had under 300 downloads in the last week and it has one maintainer. If every version is unpublished, no new version can be published for 24 hours ([npm's unpublish policy](https://docs.npmjs.com/policies/unpublish), read 27 Nov 2026). So a wrong publish is fixed by publishing the next version, not by taking it back.

The case files under `cases/` ship, and they hold fake secret-shaped strings on purpose (a fake token, key headers with fake bodies, a sample JWT, prompt-injection text): they are test data for `openmorals eval`, and a secret scanner may flag them.

The list, in order. Stop at the first step that fails. No step puts a token in a file or on a command line.

1. **Check the name is still free.** Open https://www.npmjs.com/package/openmorals in a browser. For the first publish it must say the package is not found; for a later one, the version you are about to publish must not be listed. Nothing to run.
2. **Check which email the npm account shows.** The registry shows the publishing account's email to anyone who reads the package's details. Before the first publish, sign in on npmjs.com, look at the account's email in its settings, and change it there if it should not be public.
3. **Check out the release commit with a clean tree** (`git status` shows nothing, and `git status --ignored` shows nothing under `packs/`, `cases/` or `skills/`). Merge it to the main branch and push it with its tag first, so the repository link on the npm page shows the released code.
4. **Check npm will run scripts:** `npm config get ignore-scripts` must print `false`. If it prints `true`, `prepack` will not run: run `npm run clean && npm run build` yourself before step 6.
5. `npm ci`, `npm run clean`, `npm run build`, `npm test`, and `node dist/src/cli.js eval`. All must pass.
6. **Pack into an empty temp folder:** `npm pack --pack-destination <temp folder>`. Keep this `.tgz`: it is the file you test and the file you publish.
7. In another empty temp folder: `npm init -y`, then `npm install <path to the .tgz>`.
8. From that folder, set `OM="$PWD/node_modules/.bin/openmorals"` (a full path, so it still works from another folder). `$OM --version` must print the release version; `$OM check "rm -rf build"` must ask; then in a scratch project folder, `$OM init --hook-command "$OM hook claude-code"` must write the hook, and `$OM doctor` there must find it.
9. **Sign in** with `npm login`, which asks in the terminal; turn two-factor authentication on for the account first.
10. **Dry run the publish:** `npm publish <path to the .tgz> --dry-run`. Read what it says it would upload: the name, the version and the file count must match steps 6 to 8. Nothing is uploaded.
11. **Publish the tested tarball:** `npm publish <path to the .tgz>`. This uploads that file as it is; it does not build again from the tree.
12. Open the package page and check the version, the README and the repository link. Then delete the temp folders.

Not covered: CommonJS `require()` (the package is ES modules only); Windows and Linux (no version since 0.7.0 has been run there); provenance (npm's signed statement of where a package was built needs a supported CI service, so a publish by hand has none).
