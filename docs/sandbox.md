# Sandbox (run a command under an OS sandbox built from the bylaws)

## How it is wired (0.3.0)

- **CLI**: `openmorals sandbox plan [--json] [--platform darwin|linux|win32]` resolves the bylaws for the
  current folder, plans for the folder holding the nearest `openmorals.yaml` (else the current folder) with
  `hostPlanInputs`, and prints the Seatbelt profile, the bubblewrap arguments or the Windows plan, the srt
  settings and the notes; a plan that cannot be made exits 1. `openmorals sandbox run -- <cmd> [args...]`
  plans the same way, calls `runSandboxed` and exits with the command's code, or 125 when it refuses (the
  command did not run). The command must come after `--`.
- **Bylaws**: the optional `sandbox` section, validated with the rest of the file by `validateSandboxSection`
  (unknown keys, IP addresses, URLs and a bare `*` are errors). A loaded `Bylaws` always carries it (empty
  lists by default: network off, nothing extra writable, nothing extra unreadable):
  ```yaml
  sandbox:
    network:
      allow_hosts: []      # empty = network off; host names or *.example.com only
    write:
      allow: []            # extra writable paths; ~/ and project-relative accepted
    read:
      deny: []             # extra read-denied paths
  ```
- **Package entry point**: `planSandbox`, `runSandboxed`, `sandboxCommand`, `planForProject`,
  `formatPlanText`, `hostPlanInputs`, `detectSandboxTool`, `validateSandboxSection`, `SANDBOX_REFUSED_EXIT`
  and the types.
- **Tests** (`test/sandbox-wiring.test.ts`): 11 bylaws cases, 10 run cases with injected tool detection and
  spawn (both refusal branches on macOS and Linux, Windows, no `--`), the plan output, and two CLI runs that
  start nothing. Real runs under `sandbox-exec` while wiring: `/bin/echo` (below), and once, while proving the `--` check by
  breaking it, a `touch` that created an empty file inside a test's temporary folder.
- **Dependencies**: none. It never installs `sandbox-exec`, `bwrap` or `srt`.

## What `planSandbox(bylaws, platform, projectRoot, opts)` returns

A pure function (no file system, environment or clock; everything machine-specific comes in
through `opts`: `home`, `tmpDirs`, `sandbox`, `probe`, `projectSecretFiles`;
`hostPlanInputs(cwd)` builds them for the current machine). The policy is the same on every OS:

- **Writes** are denied everywhere except the project root, the temp directories (macOS
  `/private/tmp`, `/private/var/tmp` and the real `os.tmpdir()`; Linux `/tmp` and `os.tmpdir()`)
  and paths listed in `sandbox.write.allow`. Inside the project, `.git/hooks`, `.git/config`,
  `openmorals.yaml`/`.yml` and `.claude/settings*.json` stay read-only, so a sandboxed command
  cannot plant a hook or loosen its own rules.
- **Reads** are denied for credential locations under home (`.ssh`, `.aws`, `.gnupg`,
  `.config/gcloud`, `.azure`, `.password-store`, `.kube/config`, `.docker/config.json`, `.netrc`,
  `.npmrc`, `.pypirc`, `.git-credentials`, `.vault-token`, `.pgpass`, `.my.cnf`), for
  secret-looking file names anywhere (`.env`, `.env.*`, `.envrc`, `id_rsa`-style keys, `*.pem`,
  `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk`, `*.kdbx`, `terraform.tfstate`) and
  for `sandbox.read.deny`. When `guards.secrets.read` is `allow`, the built-in home list is left
  out. Note `.env.example` is also unreadable inside the sandbox (no exceptions in the patterns).
- **Network** is off unless `sandbox.network.allow_hosts` lists hosts.
- Refused (plan `ok: false`): an unsupported platform, a relative or empty root, the file
  system root, home or any parent of home as root or as a writable path, a writable path inside
  a read-denied location, paths with control characters (and on macOS/Linux a `"` or `\`,
  which a profile would have to quote), `~user` paths, invalid host names. Invalid bylaws give a
  plan from the defaults (network off) with a note.
- Paths are normalised (`..` and `.` resolved, trailing separators dropped; on macOS `/tmp`,
  `/var`, `/etc` become their `/private` form, because Seatbelt matches resolved paths). The
  planner does not follow symlinks; `hostPlanInputs` passes real paths.

Per platform:

| platform | output | enforced by openmorals | run on this build machine |
|---|---|---|---|
| macOS | Seatbelt profile text for `/usr/bin/sandbox-exec -p`; srt settings | yes (`runSandboxed`) | yes, one smoke test (below) |
| Linux | bubblewrap argument array (`--unshare-all`, `--ro-bind / /`, `--bind` for writable paths, `--tmpfs`+`--remount-ro` or `--ro-bind /dev/null` over secrets, `--chdir`); srt settings | yes (`runSandboxed`) | no: unit-tested as pure logic only, not run on Linux |
| Windows | a documented plan (dedicated user, write-restricted token, ACLs, per-user firewall rule, after Codex's published design) | **no**: `runSandboxed` refuses | no: plan only |

**Host allow-lists are not enforced by the built-in runners.** Neither Seatbelt nor bubblewrap
can filter by host name; both keep the network fully off, and the host list is carried only in
the srt settings (`network.allowedDomains`), where Anthropic's sandbox runtime enforces it
through its proxy. `runSandboxed` does not drive `srt` yet, because srt's README shows only
single quoted shell-string commands and openmorals passes argument vectors, never shell strings.

On Linux, bubblewrap binds concrete paths: with a `probe`, paths that do not exist are skipped,
so a secret or protected file created during the run is not covered; without a probe every
planned path is bound and bwrap fails (closed) if one is missing. `hostPlanInputs` lists the
project's existing secret-looking files (depth 4, skipping `.git` and `node_modules`).

## `runSandboxed(cmd, args, plan, deps)`

Starts `cmd` with `args` as an argument vector (`spawn` with `shell: false`) under
`/usr/bin/sandbox-exec -p <profile> cmd args...` on macOS, or
`bwrap <plan args> -- cmd args...` on Linux, in the project root.

It **refuses** (exit code 125, `refused: true`, nothing started, a message ending "The command was
not run.") when the plan is invalid, the plan is the Windows one, the plan was made for another
platform, the command is empty, starts with `-` or contains a NUL, or the sandbox tool is absent.
**It never falls back to running the command unsandboxed.** Tools are looked for only at fixed
absolute paths (`/usr/bin/sandbox-exec`; `/usr/bin/bwrap`, `/bin/bwrap`, `/usr/local/bin/bwrap`),
never through `PATH`, where a planted fake could pose as the sandbox. Environment variables whose
names look like credentials (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, `*AUTH*` and similar)
are dropped from the child's environment unless `keepSecretEnv` is set; values are never read.
Detection, spawning, platform and environment are injectable, so both branches are tested
without a sandbox tool.

## srt settings

Shape per the sandbox-runtime README (MEASURED 23 Nov 2026,
https://github.com/anthropic-experimental/sandbox-runtime): `srt --settings <file> <command>`
with `{ network: { allowedDomains, deniedDomains }, filesystem: { denyRead, allowRead,
allowWrite, denyWrite } }`; an empty `allowedDomains` means no network and an empty `allowWrite`
means no writes; macOS uses `sandbox-exec`, Linux `bwrap` (where `allowWrite`/`denyWrite` take
literal paths only), Windows is alpha. openmorals emits this object in the plan; it does not
write the file or run `srt`.

## What was actually run

- Unit tests: `test/sandbox/cases.ts` is a table of 46 planner cases (paths with spaces, `..`,
  trailing slashes, `/tmp` and `/var` firmlinks, Windows drive, UNC and drive-relative paths,
  case-insensitive home on Windows and macOS, empty and invalid allow lists, invalid bylaws, an
  unsupported platform) with invariants checked on every plan (no `..` left, root writable, no
  writable path inside a read-denied one, network denied in every Seatbelt profile, balanced
  parentheses, `--unshare-all` in every bwrap plan). `test/sandbox/sandbox.test.ts` covers the
  runner's refusals and argument vectors with a fake spawn, `scrubEnv`, the name regexes and
  the secret-file finder (in a temp directory).
- One real smoke test on macOS (`test/sandbox/smoke.test.ts`, skipped unless
  `OPENMORALS_SANDBOX_SMOKE=1`): under the generated profile `/bin/echo` printed its text;
  `touch` of a file outside the project (inside the test's own temp directory) failed with
  "Operation not permitted" and the file did not appear; `touch` inside the project succeeded;
  the same outside directory was writable without the sandbox (control). Nothing else was run;
  bubblewrap and srt were not available and were not installed.
- Through the CLI on macOS, 23 Nov 2026 (MEASURED):
  ```console
  $ openmorals sandbox run -- /bin/echo hello from the sandbox
  hello from the sandbox
  $ echo $?
  0
  ```

## Limits, stated plainly

- Seatbelt (`sandbox-exec`) is deprecated by Apple, and with `(allow default)` this profile is a
  filter on writes, secret reads and network, not a full isolation boundary: the command can
  still read the rest of the disk, list processes and use IPC.
- Host-level network filtering needs srt; the built-in runners only offer network off.
- Windows is not enforced at all.
- Name patterns are deliberately broad (`*.key` also matches Keynote files).
