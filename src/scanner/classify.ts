import type { FileKind } from "./types.js";

const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "fish", "ksh", "ps1", "psm1", "psd1", "bat", "cmd",
  "py", "js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx", "rb", "pl", "php", "lua", "go", "rs",
  "applescript", "scpt", "vbs", "wsf",
]);

const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "avif",
  "woff", "woff2", "ttf", "otf", "eot", "pdf", "mp3", "mp4", "wav", "ogg", "webm",
]);

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isMediaFile(path: string): boolean {
  return MEDIA_EXTENSIONS.has(extensionOf(path));
}

export function classifyFile(path: string, text: string): FileKind {
  const name = baseName(path);
  const lower = name.toLowerCase();
  const ext = extensionOf(path);
  if (name === "SKILL.md") return "skill-md";
  if (lower === "package.json") return "package-json";
  if (lower === ".mcp.json" || lower === "mcp.json" || lower === "claude_desktop_config.json") return "mcp-config";
  if (lower === "plugin.json" && path.includes(".claude-plugin/")) return "plugin-manifest";
  if (lower === "marketplace.json" && path.includes(".claude-plugin/")) return "plugin-manifest";
  if (lower === "hooks.json") return "hooks-config";
  if (/^settings(\.local)?\.json$/.test(lower)) return "settings-json";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  if (ext === "json" || ext === "jsonc") {
    if (/"mcpServers"\s*:/.test(text)) return "mcp-config";
    if (/"hooks"\s*:\s*\{/.test(text) && /"(PreToolUse|PostToolUse|SessionStart|UserPromptSubmit|Stop|PermissionRequest|Notification)"\s*:/.test(text)) return "hooks-config";
    if (/"permissions"\s*:\s*\{/.test(text)) return "settings-json";
    return "json";
  }
  if (ext === "toml") return "toml";
  if (SCRIPT_EXTENSIONS.has(ext)) return "script";
  if (text.startsWith("#!")) return "script";
  return "text";
}

export function isProbablyBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}
