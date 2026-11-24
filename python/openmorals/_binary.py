"""Find, verify and run the openmorals binary that ships inside this package.

Nothing here judges a command. Every decision is made by the binary (the
TypeScript engine compiled into a single executable). This module only finds
that file, checks it is the one the wheel was built with, and hands it the
arguments, stdin, stdout and exit code unchanged. When it cannot do that it
fails closed: a plain command prints why and exits non-zero; a hook prints the
answer that makes the host ask (or block) instead of letting the tool run.
"""

import hashlib
import json
import os
import platform
import subprocess
import sys
from typing import Dict, List, Optional, Tuple

MANIFEST = "_binary.json"
STAMP = ".openmorals-verified.json"
UNAVAILABLE_RULE = "python.binary-unavailable"
EXIT_UNAVAILABLE = 69

SUPPORTED = ("linux-x64", "linux-arm64", "macos-arm64", "macos-x64", "windows-x64")

_MACHINES = {
    "x86_64": "x64",
    "amd64": "x64",
    "x64": "x64",
    "aarch64": "arm64",
    "arm64": "arm64",
}


class Unavailable(Exception):
    """The binary cannot be used; the message says why, for a person to read."""


def platform_key(system: Optional[str] = None, machine: Optional[str] = None) -> Optional[str]:
    sys_name = (system if system is not None else sys.platform).lower()
    os_name = "linux" if sys_name.startswith("linux") else "macos" if sys_name == "darwin" else "windows" if sys_name in ("win32", "cygwin", "windows") else None
    arch = _MACHINES.get((machine if machine is not None else platform.machine()).lower())
    if os_name is None or arch is None:
        return None
    key = "{}-{}".format(os_name, arch)
    return key if key in SUPPORTED else None


def package_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _stat_key(st: os.stat_result) -> Dict[str, int]:
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "ino": st.st_ino, "dev": st.st_dev}


def _read_json(path: str) -> Optional[Dict[str, object]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def resolve_binary(pkg_dir: Optional[str] = None, version: Optional[str] = None) -> str:
    """Return the path of a verified binary, or raise Unavailable saying why."""
    from . import __version__

    pkg = pkg_dir if pkg_dir is not None else package_dir()
    want_version = version if version is not None else __version__
    here = platform_key()
    manifest_path = os.path.join(pkg, MANIFEST)
    manifest = _read_json(manifest_path)
    if manifest is None:
        if here is None:
            raise Unavailable(
                "this platform ({} {}) has no openmorals binary. Supported: {}. Use the npm package "
                "(npx openmorals) where Node.js runs.".format(sys.platform, platform.machine(), ", ".join(SUPPORTED))
            )
        raise Unavailable(
            "this install has no openmorals binary ({} is missing). It was probably installed from source, "
            "which carries no binary; install the {} wheel instead: pip install --force-reinstall --only-binary :all: openmorals".format(manifest_path, here)
        )
    rel = manifest.get("file")
    sha = manifest.get("sha256")
    size = manifest.get("size")
    built_for = manifest.get("platform")
    built_version = manifest.get("version")
    if not isinstance(rel, str) or not isinstance(sha, str) or not isinstance(size, int) or not isinstance(built_for, str) or not isinstance(built_version, str):
        raise Unavailable("{} is malformed; reinstall openmorals".format(manifest_path))
    if built_version != want_version:
        raise Unavailable("the binary is version {} but the Python package is {}; reinstall openmorals".format(built_version, want_version))
    if here != built_for:
        raise Unavailable(
            "this wheel carries the {} binary but this machine is {} ({} {}); install the wheel for this platform".format(
                built_for, here if here is not None else "unsupported", sys.platform, platform.machine()
            )
        )
    path = os.path.normpath(os.path.join(pkg, rel))
    if os.path.dirname(path) != os.path.join(pkg, "bin"):
        raise Unavailable("{} points outside the package's bin folder; reinstall openmorals".format(manifest_path))
    try:
        st = os.stat(path)
    except OSError:
        raise Unavailable("the openmorals binary is missing ({}); reinstall openmorals".format(path))
    if st.st_size != size:
        raise Unavailable("the openmorals binary at {} is {} bytes, expected {}; it is damaged or replaced, reinstall openmorals".format(path, st.st_size, size))
    stamp_path = os.path.join(os.path.dirname(path), STAMP)
    stamp = _read_json(stamp_path)
    key = _stat_key(st)
    if not (stamp is not None and stamp.get("sha256") == sha and stamp.get("stat") == key):
        actual = _sha256(path)
        if actual != sha:
            raise Unavailable("the openmorals binary at {} has SHA-256 {}, expected {}; it is damaged or replaced, reinstall openmorals".format(path, actual, sha))
        try:
            with open(stamp_path, "w", encoding="utf-8") as f:
                json.dump({"sha256": sha, "stat": key}, f)
        except OSError:
            pass
    if os.name != "nt" and not os.access(path, os.X_OK):
        raise Unavailable("the openmorals binary at {} is not executable; reinstall openmorals".format(path))
    return path


def _is_hook(args: List[str]) -> Tuple[bool, Optional[str]]:
    positional = [a for a in args if not a.startswith("-")]
    if positional and positional[0] == "hook":
        return True, positional[1] if len(positional) > 1 else None
    return False, None


def _unattended(args: List[str]) -> bool:
    if "--unattended" in args:
        return True
    v = os.environ.get("OPENMORALS_UNATTENDED")
    return v is not None and v != "" and v != "0" and v.lower() != "false"


def hook_fallback(target: Optional[str], why: str, unattended: bool) -> str:
    """The fail-closed answer, in the shape each host reads, matching the CLI's own crash answer."""
    decision = "deny" if unattended else "ask"
    reason = "openmorals could not run its engine ({}) and fails closed".format(why)
    if unattended:
        reason += " [unattended: nobody can answer, so ask becomes deny]"
    text = "openmorals {} [{}]: {}".format(decision, UNAVAILABLE_RULE, reason)
    if target == "codex":
        msg = text if unattended else text + (
            ". Codex hooks cannot ask the user, so openmorals blocked this call: tell the user what you wanted to run and why, "
            "and let them decide (they can run it themselves or allow it in openmorals.yaml)."
        )
        return json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": msg}}, separators=(",", ":"))
    if target == "gemini-cli":
        msg = text if unattended else text + ". openmorals is set to block what it would ask about here: tell the user what you wanted to run and why, and let them decide."
        return json.dumps({"decision": "deny", "reason": msg, "systemMessage": text}, separators=(",", ":"))
    if target == "opencode":
        msg = text if unattended else text + ". This opencode plugin API cannot ask the user, so openmorals blocked this call: tell the user what you wanted to run and why, and let them decide."
        return json.dumps({"decision": decision, "rule": UNAVAILABLE_RULE, "block": True, "effect": decision, "message": msg}, separators=(",", ":"))
    return json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision, "permissionDecisionReason": text}}, separators=(",", ":"))


def _write_stdout(data: bytes) -> None:
    out = getattr(sys.stdout, "buffer", None)
    if out is not None:
        out.write(data)
        out.flush()
    else:
        sys.stdout.write(data.decode("utf-8", "replace"))
        sys.stdout.flush()


def run(args: List[str], pkg_dir: Optional[str] = None) -> int:
    """Run the binary with these arguments. Returns the exit code (POSIX non-hook runs replace this process)."""
    hook, target = _is_hook(args)
    try:
        binary = resolve_binary(pkg_dir)
    except Unavailable as e:
        sys.stderr.write("openmorals: {}\n".format(e))
        if hook:
            _write_stdout((hook_fallback(target, str(e), _unattended(args)) + "\n").encode("utf-8"))
            return 0
        return EXIT_UNAVAILABLE
    if hook:
        try:
            done = subprocess.run([binary] + args, stdout=subprocess.PIPE)
        except OSError as e:
            why = "could not start {}: {}".format(binary, e)
            sys.stderr.write("openmorals: {}\n".format(why))
            _write_stdout((hook_fallback(target, why, _unattended(args)) + "\n").encode("utf-8"))
            return 0
        if done.returncode != 0:
            why = "the binary exited with code {}".format(done.returncode)
            sys.stderr.write("openmorals: {}\n".format(why))
            _write_stdout((hook_fallback(target, why, _unattended(args)) + "\n").encode("utf-8"))
            return 0
        _write_stdout(done.stdout)
        return 0
    if os.name != "nt":
        sys.stdout.flush()
        sys.stderr.flush()
        try:
            os.execv(binary, [binary] + args)
        except OSError as e:
            sys.stderr.write("openmorals: could not start {}: {}\n".format(binary, e))
            return EXIT_UNAVAILABLE
    try:
        proc = subprocess.Popen([binary] + args)
    except OSError as e:
        sys.stderr.write("openmorals: could not start {}: {}\n".format(binary, e))
        return EXIT_UNAVAILABLE
    while True:
        try:
            return proc.wait()
        except KeyboardInterrupt:
            continue
