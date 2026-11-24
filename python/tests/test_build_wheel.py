"""Tests for build_wheel.py: the wheel's layout, its RECORD and its refusals."""

import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PY_ROOT = os.path.dirname(HERE)
sys.path.insert(0, PY_ROOT)

import build_wheel  # noqa: E402
import openmorals  # noqa: E402


class BuildWheelTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="openmorals-pytest-wheel-")
        self.binary = os.path.join(self.tmp, "openmorals-linux-x64")
        with open(self.binary, "wb") as f:
            f.write(b"\x7fELF pretend binary")
        self.notices = os.path.join(self.tmp, "THIRD-PARTY-LICENSES.txt")
        with open(self.notices, "w", encoding="utf-8") as f:
            f.write("===== Node.js =====\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_layout_tags_and_record(self) -> None:
        path = build_wheel.build(self.binary, "linux-x64", os.path.join(self.tmp, "out"), self.notices)
        v = openmorals.__version__
        self.assertEqual(os.path.basename(path), "openmorals-{}-py3-none-manylinux_2_28_x86_64.whl".format(v))
        di = "openmorals-{}.dist-info".format(v)
        with zipfile.ZipFile(path) as z:
            names = set(z.namelist())
            for want in ("openmorals/__init__.py", "openmorals/__main__.py", "openmorals/_binary.py", "openmorals/py.typed", "openmorals/_binary.json", "openmorals/bin/openmorals", di + "/METADATA", di + "/WHEEL", di + "/RECORD", di + "/entry_points.txt", di + "/licenses/LICENSE", di + "/licenses/THIRD-PARTY-LICENSES.txt"):
                self.assertIn(want, names)
            self.assertEqual((z.getinfo("openmorals/bin/openmorals").external_attr >> 16) & 0o777, 0o755)
            self.assertIn("Tag: py3-none-manylinux_2_28_x86_64", z.read(di + "/WHEEL").decode())
            self.assertIn("Root-Is-Purelib: false", z.read(di + "/WHEEL").decode())
            self.assertIn("openmorals = openmorals.__main__:entry", z.read(di + "/entry_points.txt").decode())
            meta = z.read(di + "/METADATA").decode()
            self.assertIn("Requires-Python: >=3.9", meta)
            self.assertNotIn("Requires-Dist", meta)
            manifest = json.loads(z.read("openmorals/_binary.json").decode())
            data = z.read("openmorals/bin/openmorals")
            self.assertEqual(manifest, {"file": "bin/openmorals", "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "platform": "linux-x64", "version": v})
            rows = [r.split(",") for r in z.read(di + "/RECORD").decode().splitlines()]
            listed = {r[0] for r in rows}
            self.assertEqual(listed, names)
            for name, digest, size in rows:
                if name.endswith("/RECORD"):
                    self.assertEqual((digest, size), ("", ""))
                    continue
                body = z.read(name)
                self.assertEqual(digest, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b"=").decode())
                self.assertEqual(int(size), len(body))

    def test_windows_binary_name(self) -> None:
        path = build_wheel.build(self.binary, "windows-x64", os.path.join(self.tmp, "out"))
        self.assertTrue(path.endswith("-py3-none-win_amd64.whl"))
        with zipfile.ZipFile(path) as z:
            self.assertIn("openmorals/bin/openmorals.exe", z.namelist())
            self.assertEqual(json.loads(z.read("openmorals/_binary.json").decode())["file"], "bin/openmorals.exe")

    def test_every_supported_platform_has_a_tag(self) -> None:
        from openmorals import _binary

        self.assertEqual(sorted(build_wheel.PLATFORM_TAGS), sorted(_binary.SUPPORTED))

    def test_refuses_an_unknown_platform(self) -> None:
        with self.assertRaises(SystemExit):
            build_wheel.build(self.binary, "freebsd-x64", os.path.join(self.tmp, "out"))

    def test_refuses_when_versions_differ(self) -> None:
        saved = build_wheel.npm_version
        try:
            build_wheel.npm_version = lambda: "0.0.0"  # type: ignore[assignment]
            with self.assertRaises(SystemExit) as cm:
                build_wheel.build(self.binary, "linux-x64", os.path.join(self.tmp, "out"))
        finally:
            build_wheel.npm_version = saved  # type: ignore[assignment]
        self.assertIn("differs from package.json", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
