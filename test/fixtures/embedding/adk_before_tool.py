import uuid

import openmorals
from google.adk.agents import LlmAgent

MODEL = "your-model-name"
SESSION = "adk-" + uuid.uuid4().hex
# True: an ask is refused. Set False only when a person is at this program's own terminal to answer.
UNATTENDED = True
OWN_TOOLS = {"run_shell": []}  # your tools whose arguments show everything they do


def run_shell(command: str) -> dict:
    """Your own tool."""
    ...


def before_tool(tool, args, tool_context):
    d = openmorals.guard(tool.name, args, session=SESSION, actions=OWN_TOOLS.get(tool.name), unattended=UNATTENDED)
    if d.decision == "allow":
        return None
    if d.decision == "ask" and input(f"{tool.name}: {d.reason}\nRun it? [y/N] ").strip() == "y":
        return None
    return {"status": "not run", "reason": f"openmorals {d.decision}: {d.reason}"}


root_agent = LlmAgent(name="helper", model=MODEL, tools=[run_shell], before_tool_callback=before_tool)
