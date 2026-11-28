# openmorals for Python

openmorals is a local policy engine for AI coding agents. Its hooks make an agent
ask before it deletes, force-pushes, drops a database, deletes something online,
leaks a secret or overspends its budget. This package gives you the engine's
command line and one Python function, `check()`.

`check()` judges one shell command line, on its own. It does not see the agent's
other tool calls and keeps no session, so no budget and no session marks come into
it. It is advice: your program decides whether to call it and whether to obey
the answer. Without `bylaws=` it uses your user-level file and the nearest project
file, from `cwd`. With `bylaws=FILE` it judges against that file alone; your
user-level file is not applied.

This package is a thin wrapper. The engine is written once, in TypeScript, and
ships here as a single executable inside a platform wheel. The Python code makes
no decisions: it finds that binary, checks its SHA-256 against the value recorded
when the wheel was built, and runs it with your arguments, stdin, stdout and exit
code passed through unchanged.

```sh
pip install openmorals
openmorals check "rm -rf ~/projects"      # ASK, exit code 1
python -m openmorals --version
```

```python
import openmorals

d = openmorals.check("git push --force origin main")
print(d.decision, d.rule, d.reason)       # ask destructive.git-force-push ...
```

`check()` returns `ask` with rule `python.binary-unavailable` whenever the binary
cannot give an answer (missing, wrong checksum, crashed, timed out); it never
returns `allow` unless the engine said allow.

Wheels exist for Linux x64 and arm64 (glibc 2.28 or later), macOS arm64 and x64
(13.5 or later) and Windows x64. On other platforms there is no wheel; use the npm
package. Python 3.9 or later; no other Python packages needed.

If the binary is missing or does not match its checksum, `openmorals` prints why and
exits with code 69. `openmorals hook claude-code` (and the other hook targets) then
prints the answer that makes the agent ask (or block, where the host cannot ask)
instead of printing nothing, so a broken install never lets a tool run unasked.

Apache-2.0. The full documentation, the bylaws format and the hook set-up are in
the project README and `docs/distribution.md` of the source repository.
