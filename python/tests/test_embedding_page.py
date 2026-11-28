"""The Python example on docs/embedding.md (0.44.1), run with the standard library only.

The page's block is byte-equal to test/fixtures/embedding/adk_before_tool.py (test/embedding-page.test.ts
checks that). Here the file is parsed, then run with STAND-INS: a module that takes the place of
google.adk.agents (it records what LlmAgent is given and does nothing else), and the stand-in binary
of test_wrapper.py that starts the built Node CLI. ADK is not installed and not run; no model is called.
"""

import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from test_wrapper import CLI_JS, POSIX_ONLY, REPO, _env, _script, fake_install

FIXTURE = os.path.join(REPO, "test", "fixtures", "embedding", "adk_before_tool.py")

_RUN = r"""
import json, sys, types

# STAND-IN for google.adk.agents: records the keyword arguments LlmAgent gets. Not ADK.
class LlmAgent:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

for name in ("google", "google.adk", "google.adk.agents"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["google.adk.agents"].LlmAgent = LlmAgent

class Tool:
    def __init__(self, name):
        self.name = name

ns = {"__name__": "adk_example"}
exec(compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec"), ns)
agent = ns["agent"]
callback = agent.kwargs["before_tool_callback"]
out = {
    "callback_is_before_tool": callback is ns["before_tool"],
    "tools": [t.__name__ for t in agent.kwargs["tools"]],
    "unattended": ns["UNATTENDED"],
    "calls": [
        callback(tool=Tool(t), args=a, tool_context=None)
        for t, a in json.loads(sys.argv[2])
    ],
}
print(json.dumps(out))
"""


class ParseTest(unittest.TestCase):
    def test_the_example_parses(self) -> None:
        with open(FIXTURE, encoding="utf-8") as f:
            tree = ast.parse(f.read(), FIXTURE)
        names = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
        self.assertEqual(names, {"run_shell", "before_tool"})
        before = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "before_tool")
        self.assertEqual([a.arg for a in before.args.args], ["tool", "args", "tool_context"])


@POSIX_ONLY
@unittest.skipIf(not os.path.exists(CLI_JS) or shutil.which("node") is None, "needs node and a build (npm run build)")
class RunWithStandInsTest(unittest.TestCase):
    def test_allows_ls_and_does_not_run_rm_rf_home_with_nobody_to_ask(self) -> None:
        folder = tempfile.mkdtemp(prefix="openmorals-pytest-embed-")
        home = tempfile.mkdtemp(prefix="openmorals-pytest-embed-home-")
        try:
            root = fake_install(_script(folder, "openmorals", 'exec node "{}" "$@"\n'.format(CLI_JS)))
            try:
                calls = [["run_shell", {"command": "ls"}], ["run_shell", {"command": "rm -rf ~"}], ["delete_rows", {"table": "users"}]]
                e = _env({"OPENMORALS_HOME": home})
                e["PYTHONPATH"] = root
                r = subprocess.run(
                    [sys.executable, "-c", _RUN, FIXTURE, json.dumps(calls)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=e, cwd=folder, timeout=120,
                )
                self.assertEqual(r.returncode, 0, r.stderr.decode())
                got = json.loads(r.stdout.decode())
            finally:
                shutil.rmtree(root, ignore_errors=True)
        finally:
            shutil.rmtree(folder, ignore_errors=True)
            shutil.rmtree(home, ignore_errors=True)
        self.assertTrue(got["callback_is_before_tool"])
        self.assertEqual(got["tools"], ["run_shell"])
        self.assertTrue(got["unattended"])
        ls, rm, unknown = got["calls"]
        self.assertIsNone(ls)
        self.assertEqual(rm["status"], "not run")
        self.assertTrue(rm["reason"].startswith("openmorals deny: "), rm)
        self.assertEqual(unknown["status"], "not run")
        self.assertTrue(unknown["reason"].startswith("openmorals deny: "), unknown)


if __name__ == "__main__":
    unittest.main()
