import { guardCall, type GuardCallAction } from "openmorals";

export type ToolCall = { name: string; input: Record<string, unknown> };

// Your own tools whose input shows everything they do. Any other name asks.
const ownTools: Record<string, GuardCallAction[]> = { run_shell: [] };
const session = `my-agent-${process.pid}`;

export async function callTool(
  call: ToolCall,
  run: (call: ToolCall) => Promise<string>,
  askPerson?: (reason: string) => Promise<boolean>,
): Promise<string> {
  const v = guardCall(
    { session, cwd: process.cwd(), tool: call.name, input: call.input, actions: ownTools[call.name] },
    { unattended: askPerson === undefined },
  );
  if (v.decision === "allow") return run(call);
  if (v.decision === "ask" && askPerson !== undefined && (await askPerson(v.reason))) return run(call);
  return `not run (openmorals ${v.decision}, ${v.rule}): ${v.reason}`;
}
