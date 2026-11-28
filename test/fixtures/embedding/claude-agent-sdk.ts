import { query } from "@anthropic-ai/claude-agent-sdk";

// The folder where you ran `openmorals init`. Its .claude/settings.json holds the hook.
const project = "/path/to/project";

for await (const message of query({
  prompt: "Fix the failing test",
  options: { cwd: project, settingSources: ["project"] },
})) {
  if (message.type === "result") console.log(message);
}
