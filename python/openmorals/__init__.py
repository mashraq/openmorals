"""openmorals for Python: the same engine as the npm package, run as a single binary.

This package holds no decision code. ``openmorals`` on the command line, ``python -m
openmorals``, :func:`check` and :func:`guard` all run the openmorals binary that ships inside the
wheel, after checking its SHA-256 against the one recorded when the wheel was built.
"""

import json
import subprocess
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

from ._binary import UNAVAILABLE_RULE, Unavailable, resolve_binary

__version__ = "0.43.1"

__all__ = ["Decision", "check", "guard", "binary_path", "Unavailable", "__version__"]

_DECISIONS = ("allow", "ask", "deny")
_EXIT_FOR = {"allow": 0, "ask": 1, "deny": 2}
_SHELLS = ("posix", "powershell", "cmd")


@dataclass(frozen=True)
class Decision:
    """The engine's answer: ``decision`` is ``"allow"``, ``"ask"`` or ``"deny"``."""

    decision: str
    rule: str
    reason: str
    bylaws: Optional[str] = None
    raw: Mapping[str, object] = field(default_factory=dict, compare=False, repr=False)

    @property
    def allowed(self) -> bool:
        return self.decision == "allow"


def binary_path() -> str:
    """The verified binary this package runs; raises :class:`Unavailable` saying why when there is none."""
    return resolve_binary()


def _unavailable(why: str) -> Decision:
    return Decision("ask", UNAVAILABLE_RULE, "openmorals could not run its engine ({}) and fails closed".format(why))


def check(
    command: str,
    *,
    shell: str = "posix",
    bylaws: Optional[str] = None,
    unattended: bool = False,
    cwd: Optional[str] = None,
    env: Optional[Dict[str, str]] = None,
    timeout: Optional[float] = 60.0,
) -> Decision:
    """Judge a command line with ``openmorals check --json``.

    The command is judged on its own, with no session. With ``bylaws`` it is judged
    against that file alone; your user-level file is not applied.

    Never returns ``allow`` unless the binary itself said allow: if the binary is
    missing, fails its checksum, times out, crashes or prints something that is not
    its verdict, the answer is ``ask`` with rule ``python.binary-unavailable``.
    """
    if not isinstance(command, str) or command.strip() == "":
        raise ValueError("command must be a non-empty string")
    if shell not in _SHELLS:
        raise ValueError("shell must be one of {}".format(", ".join(_SHELLS)))
    try:
        binary = resolve_binary()
    except Unavailable as e:
        return _unavailable(str(e))
    argv = [binary, "check", "--json", "--shell", shell]
    if bylaws is not None:
        argv += ["--bylaws", bylaws]
    if unattended:
        argv.append("--unattended")
    argv += ["--", command]
    try:
        done = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd, env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        return _unavailable("the binary did not answer within {} seconds".format(timeout))
    except OSError as e:
        return _unavailable("could not start {}: {}".format(binary, e))
    return _verdict(done)


def _verdict(done: "subprocess.CompletedProcess[bytes]") -> Decision:
    """The binary's printed verdict, or the unavailable answer when it is not one or its exit code disagrees."""
    try:
        data = json.loads(done.stdout.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return _unavailable("the binary exited with code {} and printed no verdict".format(done.returncode))
    if not isinstance(data, dict):
        return _unavailable("the binary printed something that is not a verdict")
    decision = data.get("decision")
    rule = data.get("rule")
    reason = data.get("reason")
    if decision not in _DECISIONS or not isinstance(rule, str) or not isinstance(reason, str):
        return _unavailable("the binary printed something that is not a verdict")
    if _EXIT_FOR[str(decision)] != done.returncode:
        return _unavailable("the binary said {} but exited with code {}".format(decision, done.returncode))
    source = data.get("bylaws")
    return Decision(str(decision), rule, reason, source if isinstance(source, str) else None, data)


def guard(
    tool: str,
    input: Optional[Dict[str, Any]] = None,
    *,
    session: str,
    cwd: Optional[str] = None,
    actions: Optional[Sequence[Dict[str, Any]]] = None,
    unattended: bool = False,
    timeout: Optional[float] = 60.0,
) -> Decision:
    """Judge one call of a program's agent with ``openmorals guard --json`` (Preview).

    The same check as the library call ``guardCall``: your user file, the project file
    over it, the built-in guards and the history of ``session``. The request goes to the
    binary on stdin, never on its command line, so the input does not show in the list
    of running processes. This is advice to your program: never treat ``ask`` as allow.

    Never raises for a failure to judge and never returns ``allow`` unless the binary
    said allow: if the binary is missing or fails its checksum, times out, cannot be
    started, prints something that is not its verdict, or exits with a code that
    disagrees with the verdict it printed, or the request cannot be written as JSON, the
    answer is ``ask`` with rule ``python.binary-unavailable``. A request the binary
    cannot read (a bad session id, an unknown key) is its own ``ask``.
    """
    request: Dict[str, Any] = {"session": session, "tool": tool}
    if cwd is not None:
        request["cwd"] = cwd
    if input is not None:
        request["input"] = input
    if actions is not None:
        request["actions"] = actions
    try:
        payload = json.dumps(request, allow_nan=False, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError, UnicodeEncodeError) as e:
        return _unavailable("the request could not be written as JSON: {}".format(e))
    try:
        binary = resolve_binary()
    except Unavailable as e:
        return _unavailable(str(e))
    argv: List[str] = [binary, "guard", "--json"]
    if unattended:
        argv.append("--unattended")
    try:
        done = subprocess.run(argv, input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        return _unavailable("the binary did not answer within {} seconds".format(timeout))
    except (OSError, ValueError) as e:
        return _unavailable("could not start {}: {}".format(binary, e))
    return _verdict(done)
