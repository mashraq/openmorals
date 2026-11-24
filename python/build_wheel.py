"""Build one platform wheel of the openmorals Python package around a built binary.

    python build_wheel.py --binary ../build/openmorals-macos-arm64 --platform macos-arm64 --out ../build/wheels

Standard library only. The wheel holds the Python wrapper (no decision code), the
binary under openmorals/bin/, and openmorals/_binary.json recording the binary's
SHA-256, size, platform and version, which the wrapper checks before running it.
The version comes from openmorals/__init__.py and must match ../package.json.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import zipfile
from typing import Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Node 26's prebuilt minimums (nodejs/node BUILDING.md): glibc 2.28, macOS 13.5, Windows 10.
PLATFORM_TAGS: Dict[str, str] = {
    "linux-x64": "manylinux_2_28_x86_64",
    "linux-arm64": "manylinux_2_28_aarch64",
    "macos-arm64": "macosx_13_0_arm64",
    "macos-x64": "macosx_13_0_x86_64",
    "windows-x64": "win_amd64",
}

PY_FILES = ("__init__.py", "__main__.py", "_binary.py", "py.typed")
FIXED_TIME = (2020, 1, 1, 0, 0, 0)


def read_version() -> str:
    with open(os.path.join(HERE, "openmorals", "__init__.py"), encoding="utf-8") as f:
        m = re.search(r'^__version__ = "([^"]+)"$', f.read(), re.M)
    if m is None:
        raise SystemExit("build_wheel: no __version__ in openmorals/__init__.py")
    return m.group(1)


def npm_version() -> str:
    with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as f:
        return str(json.load(f)["version"])


def _record_hash(data: bytes) -> str:
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")


def _metadata(version: str) -> str:
    with open(os.path.join(HERE, "README.md"), encoding="utf-8") as f:
        readme = f.read()
    return (
        "Metadata-Version: 2.1\n"
        "Name: openmorals\n"
        "Version: {}\n"
        "Summary: Ask before an AI coding agent deletes, force-pushes, leaks a secret or overspends: the openmorals engine as a single binary.\n"
        "License: Apache-2.0\n"
        "Requires-Python: >=3.9\n"
        "Classifier: License :: OSI Approved :: Apache Software License\n"
        "Classifier: Programming Language :: Python :: 3\n"
        "Description-Content-Type: text/markdown\n"
        "\n{}"
    ).format(version, readme)


def build(binary: str, plat: str, out_dir: str, third_party: Optional[str] = None) -> str:
    if plat not in PLATFORM_TAGS:
        raise SystemExit("build_wheel: --platform must be one of {}".format(", ".join(PLATFORM_TAGS)))
    version = read_version()
    if version != npm_version():
        raise SystemExit("build_wheel: Python version {} differs from package.json {}".format(version, npm_version()))
    with open(binary, "rb") as f:
        bin_bytes = f.read()
    bin_name = "openmorals.exe" if plat.startswith("windows") else "openmorals"
    manifest = {
        "file": "bin/" + bin_name,
        "sha256": hashlib.sha256(bin_bytes).hexdigest(),
        "size": len(bin_bytes),
        "platform": plat,
        "version": version,
    }
    tag = "py3-none-" + PLATFORM_TAGS[plat]
    dist_info = "openmorals-{}.dist-info".format(version)
    files: List[Tuple[str, bytes, int]] = []
    for name in PY_FILES:
        with open(os.path.join(HERE, "openmorals", name), "rb") as f:
            files.append(("openmorals/" + name, f.read(), 0o644))
    files.append(("openmorals/_binary.json", (json.dumps(manifest, indent=2) + "\n").encode("utf-8"), 0o644))
    files.append(("openmorals/bin/" + bin_name, bin_bytes, 0o755))
    for lic in ("LICENSE", "NOTICE"):
        with open(os.path.join(ROOT, lic), "rb") as f:
            files.append(("{}/licenses/{}".format(dist_info, lic), f.read(), 0o644))
    if third_party is not None:
        with open(third_party, "rb") as f:
            files.append(("{}/licenses/THIRD-PARTY-LICENSES.txt".format(dist_info), f.read(), 0o644))
    files.append(("{}/METADATA".format(dist_info), _metadata(version).encode("utf-8"), 0o644))
    wheel_meta = "Wheel-Version: 1.0\nGenerator: openmorals build_wheel.py\nRoot-Is-Purelib: false\nTag: {}\n".format(tag)
    files.append(("{}/WHEEL".format(dist_info), wheel_meta.encode("utf-8"), 0o644))
    entry_points = "[console_scripts]\nopenmorals = openmorals.__main__:entry\n"
    files.append(("{}/entry_points.txt".format(dist_info), entry_points.encode("utf-8"), 0o644))
    record_lines = ["{},{},{}".format(path, _record_hash(data), len(data)) for path, data, _ in files]
    record_lines.append("{}/RECORD,,".format(dist_info))
    files.append(("{}/RECORD".format(dist_info), ("\n".join(record_lines) + "\n").encode("utf-8"), 0o644))

    os.makedirs(out_dir, exist_ok=True)
    wheel_path = os.path.join(out_dir, "openmorals-{}-{}.whl".format(version, tag))
    with zipfile.ZipFile(wheel_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for path, data, mode in files:
            info = zipfile.ZipInfo(path, date_time=FIXED_TIME)
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    return wheel_path


def main(argv: List[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--binary", required=True, help="the built openmorals binary for this platform")
    p.add_argument("--platform", required=True, choices=sorted(PLATFORM_TAGS), help="which platform the binary is for")
    p.add_argument("--out", required=True, help="folder to write the wheel into")
    p.add_argument("--third-party", help="the licences of what the binary embeds (build/THIRD-PARTY-LICENSES.txt)")
    a = p.parse_args(argv)
    path = build(a.binary, a.platform, a.out, a.third_party)
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
