"""openmorals for Python: the same engine as the npm package, run as a single binary.

This package holds no decision code. ``openmorals`` on the command line, ``python -m
openmorals`` and :func:`check` all run the openmorals binary that ships inside the
wheel, after checking its SHA-256 against the one recorded when the wheel was built.
"""

import json
import subprocess
from dataclasses import dataclass, field
from typing import Dict, Mapping, Optional

from ._binary import UNAVAILABLE_RULE, Unavailable, resolve_binary

__version__ = "0.38.0"

__all__ = ["Decision", "check", "binary_path", "Unavailable", "__version__"]

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
