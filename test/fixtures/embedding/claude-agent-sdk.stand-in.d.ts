// A STAND-IN, not the real package. It declares only what docs/embedding.md's Claude Agent SDK
// example uses, in the shape the SDK's documentation gives (read 28 Nov 2026), so the example
// can be type-checked here without installing the SDK. It proves nothing about the real SDK.
declare module "@anthropic-ai/claude-agent-sdk" {
  export type SettingSource = "user" | "project" | "local";
  export interface Options {
    cwd?: string;
    settingSources?: SettingSource[];
  }
  export interface SDKMessage {
    type: string;
  }
  export function query(params: { prompt: string; options?: Options }): AsyncGenerator<SDKMessage, void>;
}
