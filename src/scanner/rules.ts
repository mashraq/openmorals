import type { FileKind, ScanRule, RuleHit, ScanFile, Severity } from "./types.js";
import {
  asString,
  asStringArray,
  fencedLineFlags,
  findLine,
  isProse,
  isRecord,
  lineOfIndex,
  lineText,
  parseJsonLoose,
  splitLines,
} from "./util.js";

const CODE_KINDS: readonly FileKind[] = [
  "script", "package-json", "mcp-config", "hooks-config", "settings-json", "plugin-manifest", "json", "toml",
];

const CONFIG_KINDS: readonly FileKind[] = [
  "package-json", "mcp-config", "hooks-config", "settings-json", "plugin-manifest",
];

function eachLine(file: ScanFile, test: (line: string, index: number) => RuleHit | null): RuleHit[] {
  const hits: RuleHit[] = [];
  splitLines(file.text).forEach((line: string, i: number) => {
    const h = test(line, i);
    if (h !== null) hits.push(h);
  });
  return hits;
}

function firstMatch(line: string, patterns: readonly RegExp[]): RegExpExecArray | null {
  for (const p of patterns) {
    const m = p.exec(line);
    if (m !== null) return m;
  }
  return null;
}

// ---------- hidden instructions ----------

export const ZW_SET = new Set<number>([0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x180e, 0xfeff]);
export const BIDI_SET = new Set<number>([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
const PICTO = /\p{Extended_Pictographic}/u;
const NON_ASCII_LETTER = /[\p{L}\p{M}]/u;

export function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

export function isTag(cp: number): boolean {
  return cp >= 0xe0000 && cp <= 0xe007f;
}

export function isEmojiContext(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return PICTO.test(ch) || cp === 0xfe0f || (cp >= 0x1f3fb && cp <= 0x1f3ff);
}

function invisibleUnicode(file: ScanFile): RuleHit[] {
  const hits: RuleHit[] = [];
  const lines = splitLines(file.text);
  lines.forEach((line: string, li: number) => {
    const chars = Array.from(line);
    let worst: Severity | null = null;
    const kinds = new Set<string>();
    let smuggled = "";
    let vsRun = 0;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i] ?? "";
      const cp = ch.codePointAt(0) ?? 0;
      const prev = chars[i - 1];
      const next = chars[i + 1];
      if (isVariationSelector(cp)) {
        vsRun++;
        const prevCp = prev?.codePointAt(0) ?? 0;
        const supplementOnNonCjk = cp >= 0xe0100 && !(prevCp >= 0x3400 && prevCp <= 0x2ffff);
        if (vsRun >= 2 || supplementOnNonCjk) {
          kinds.add("variation-selector run");
          worst = "high";
        }
        continue;
      }
      vsRun = 0;
      if (isTag(cp)) {
        if (cp === 0xe007f) continue;
        let j = i;
        while (j > 0 && isTag((chars[j - 1] ?? "").codePointAt(0) ?? 0)) j--;
        const base = (chars[j - 1] ?? "").codePointAt(0) ?? 0;
        if (base === 0x1f3f4) continue;
        kinds.add("Unicode tag characters");
        if (cp >= 0xe0020 && cp <= 0xe007e) smuggled += String.fromCharCode(cp - 0xe0000);
        worst = "critical";
        continue;
      }
      if (BIDI_SET.has(cp)) {
        kinds.add("bidirectional control");
        if (worst !== "critical") worst = "high";
        continue;
      }
      if (ZW_SET.has(cp)) {
        if (cp === 0xfeff && li === 0 && i === 0) continue;
        if (cp === 0x200d && isEmojiContext(prev) && isEmojiContext(next)) continue;
        if ((cp === 0x200c || cp === 0x200d) && prev !== undefined && NON_ASCII_LETTER.test(prev) && (prev.codePointAt(0) ?? 0) > 0x2ff) continue;
        kinds.add("zero-width character");
        if (worst !== "critical") worst = "high";
      }
    }
    if (worst !== null) {
      const hidden = smuggled.length > 0 ? `; hidden text reads: "${smuggled.slice(0, 120)}"` : "";
      hits.push({ line: li + 1, evidence: line, severity: worst, message: `${[...kinds].join(", ")}${hidden}` });
    }
  });
  return hits;
}

const COMMENT_DIRECTED: readonly RegExp[] = [
  /\b(ignore|disregard|forget)\b[\s\S]{0,60}\b(instructions?|prompts?|rules|above|previous)\b/i,
  /\b(you|assistant|ai|model|agent|claude|llm)\s+(must|should|will|are\s+to|need\s+to|have\s+to)\b/i,
  /\b(do\s+not|don't|never)\s+(tell|mention|reveal|show|inform)\b/i,
  /\b(curl|wget|bash\s+-c|sh\s+-c|powershell|iex|base64|eval|exec)\b/i,
  /(~\/\.ssh|\.aws\/credentials|\bid_rsa\b|api[_ -]?key|\bpassword\b|\.env\b)/i,
  /\b(system\s+prompt|secret\s+instructions?|hidden\s+instructions?)\b/i,
  /\b(when|if)\s+(the\s+)?(user|you)\b[\s\S]{0,80}\b(run|execute|send|upload|call)\b/i,
];

function htmlCommentInstruction(file: ScanFile): RuleHit[] {
  const hits: RuleHit[] = [];
  const re = /<!--([\s\S]*?)-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(file.text)) !== null) {
    const body = m[1] ?? "";
    if (firstMatch(body, COMMENT_DIRECTED) !== null) {
      const line = lineOfIndex(file.text, m.index);
      hits.push({ line, evidence: m[0].replace(/\s+/g, " ") });
    }
  }
  return hits;
}

// ---------- secrets ----------

const HOME = String.raw`(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%|\$env:USERPROFILE|\$env:HOME|os\.homedir\(\)|Path\.home\(\)|homedir\(\)|expanduser\(\s*["']~)`;

const SENSITIVE_PATHS: readonly RegExp[] = [
  new RegExp(HOME + String.raw`[\\/"'\s,+)]*\.(?:ssh|aws|gnupg|kube|docker|azure|git-credentials|netrc|npmrc|pypirc)\b`, "i"),
  new RegExp(HOME + String.raw`[\\/"'\s,+)]*\.config[\\/](?:gcloud|gh)\b`, "i"),
  /\.ssh[\\/](?:id_[a-z0-9]+|identity)\b/i,
  /\.aws[\\/]credentials\b/i,
  /\/etc\/(?:shadow|sudoers)\b/,
  /\b(?:Login Data|Cookies\.sqlite|key4\.db|logins\.json)\b/,
  /\bsecurity\s+(?:find-generic-password|find-internet-password|dump-keychain)\b/,
  /\b(?:wallet\.dat|\.solana[\\/]id\.json|keystore[\\/]UTC--)/i,
];

const DOTENV_PATH = /(?:^|[\s"'`/\\=(])\.env(?:\.(?:local|production|prod|development|dev|staging))?(?=$|[\s"'`;|&),])/;

const ENV_DUMP: readonly RegExp[] = [
  /(?:^|[;&|(`]\s*|\s)(?:printenv|env)\s*(?:\||>)/,
  /JSON\.stringify\(\s*process\.env\s*\)/,
  /Object\.entries\(\s*process\.env\s*\)/,
  /\bdict\(\s*os\.environ\s*\)|os\.environ\.copy\(\)|json\.dumps\(\s*(?:dict\()?\s*os\.environ/,
  /\b(?:Get-ChildItem|gci|dir|ls)\s+env:/i,
];

const READ_VERB =
  /\b(?:cat|less|more|head|tail|type|get-content|gc|source|bat|strings|xxd|base64|grep|scp|tar|zip|open|opens|read|reads|reading|readfile\w*|read_text|load|loads|print|prints|send|sends|upload|uploads|post|include|attach|collect|grab|dump|copy|copies|paste|show|display|output|echo|exfiltrate|fetch|transmit|forward)\b/i;

interface SourceHit {
  readonly what: string;
  readonly index: number;
}

function secretSource(line: string, kind: FileKind): SourceHit | null {
  const needVerb = isProse(kind);
  const hasVerb = READ_VERB.test(line);
  for (const p of SENSITIVE_PATHS) {
    const m = p.exec(line);
    if (m !== null && (!needVerb || hasVerb)) return { what: m[0].trim(), index: m.index };
  }
  const d = DOTENV_PATH.exec(line);
  if (d !== null && hasVerb) return { what: ".env file", index: d.index };
  for (const p of ENV_DUMP) {
    const m = p.exec(line);
    if (m !== null) return { what: "the whole environment", index: m.index };
  }
  return null;
}

const NETWORK_SEND: readonly RegExp[] = [
  /\b(?:curl|wget|nc|ncat|netcat|socat|scp|sftp|ftp|rsync|telnet)\b/,
  /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Net\.WebClient|UploadString|UploadFile|UploadData)\b/i,
  /\bfetch\s*\(/,
  /\b(?:axios|got|needle|superagent)\s*[.(]/,
  /\bhttps?\.(?:request|get)\s*\(/,
  /\brequests\.(?:post|put|get|patch)\s*\(/,
  /\burllib\.request\b|\burlopen\s*\(/,
  /\bXMLHttpRequest\b|navigator\.sendBeacon/,
  /\/dev\/(?:tcp|udp)\//,
  /\b(?:dig|nslookup|host)\s+[^\n]*\$\(/,
];

function sensitiveRead(file: ScanFile): RuleHit[] {
  return eachLine(file, (line: string, i: number) => {
    const s = secretSource(line, file.kind);
    return s === null ? null : { line: i + 1, evidence: line, message: `touches ${s.what}` };
  });
}

function exfiltration(file: ScanFile): RuleHit[] {
  const lines = splitLines(file.text);
  const hits: RuleHit[] = [];
  let srcLine = 0;
  let srcWhat = "";
  let sendLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const s = secretSource(line, file.kind);
    const n = firstMatch(line, NETWORK_SEND) !== null;
    if (s !== null && n) {
      hits.push({ line: i + 1, evidence: line, severity: "critical", message: `reads ${s.what} and sends it over the network in one command` });
    }
    if (s !== null && srcLine === 0) {
      srcLine = i + 1;
      srcWhat = s.what;
    }
    if (n && sendLine === 0) sendLine = i + 1;
  }
  if (hits.length === 0 && srcLine > 0 && sendLine > 0) {
    hits.push({
      line: srcLine,
      evidence: lines[srcLine - 1] ?? "",
      severity: "high",
      message: `reads ${srcWhat} (line ${srcLine}) and the same file sends data over the network (line ${sendLine})`,
    });
  }
  return hits;
}

// ---------- destructive ----------

const SYSTEM_TARGET = /^(?:\/|\/\*|\/\.|\/(?:etc|usr|bin|sbin|var|opt|lib|System|Library|Applications|private|boot|root)\/?\*?|[A-Za-z]:[\\/]?\*?)$/;
const HOME_TARGET = /^(?:~|~\/|~\/\*|~\/\.\*?|\$HOME|\$\{HOME\}|\$HOME\/\*?|\$\{HOME\}\/\*?|\/Users\/?\*?|\/home\/?\*?|\/Users\/[^/\s]+\/?\*?|\/home\/[^/\s]+\/?\*?|%USERPROFILE%\\?\*?)$/;
const UNDER_HOME = /^(?:~\/|\$HOME\/|\$\{HOME\}\/)\S+/;
const BARE_VARIABLE = /^\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)\/?\*?$/;
const WIDE_GLOB = /^(?:\*|\.\/?\*?|\.\.(?:\/\.\.)*\/?\*?)$/;

function unquote(tok: string): string {
  return tok.replace(/^["'`]+|["'`,;)\]]+$/g, "");
}

function classifyDeleteTarget(raw: string): Severity | null {
  const t = unquote(raw);
  if (t.length === 0) return null;
  if (/:\?/.test(t)) return null;
  if (SYSTEM_TARGET.test(t) || HOME_TARGET.test(t)) return "critical";
  if (BARE_VARIABLE.test(t) || WIDE_GLOB.test(t) || UNDER_HOME.test(t)) return "high";
  return null;
}

function rmTargets(segment: string): { severity: Severity; target: string } | null {
  const re = /(?:^|[\s"'`(])rm\s+([^\n]*)/g;
  let m: RegExpExecArray | null;
  let worst: { severity: Severity; target: string } | null = null;
  while ((m = re.exec(segment)) !== null) {
    const toks = (m[1] ?? "").split(/\s+/).filter((t: string) => t.length > 0);
    let recursive = false;
    const targets: string[] = [];
    for (const tok of toks) {
      const bare = unquote(tok);
      if (/^(?:\d?>|#)/.test(bare)) break;
      if (/^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(bare) || bare === "--recursive") recursive = true;
      else if (bare.startsWith("-")) continue;
      else targets.push(tok);
    }
    if (!recursive) continue;
    for (const t of targets) {
      const sev = classifyDeleteTarget(t);
      if (sev === "critical") return { severity: sev, target: unquote(t) };
      if (sev === "high" && worst === null) worst = { severity: sev, target: unquote(t) };
    }
  }
  return worst;
}

const PS_DANGEROUS_TARGET = /(?:^|[\s"'])(?:[A-Za-z]:\\?\*?|[A-Za-z]:\\(?:Windows|Users)\\?\*?|~|\$HOME|\$env:(?:USERPROFILE|HOMEPATH|SystemRoot|windir|HOMEDRIVE)|\$\{env:USERPROFILE\})(?=["'\s\\]|$)/i;
const CMD_DANGEROUS_TARGET = /(?:^|\s)(?:[A-Za-z]:\\?(?:\*(?:\.\*)?)?|%USERPROFILE%|%SystemRoot%|%HOMEDRIVE%\\?)(?=["'\s]|$)/i;

function destructiveDelete(file: ScanFile): RuleHit[] {
  return eachLine(file, (line: string, i: number) => {
    let worst: { severity: Severity; message: string } | null = null;
    for (const seg of line.split(/&&|\|\||;|\|/)) {
      const r = rmTargets(seg);
      if (r !== null && (worst === null || r.severity === "critical")) {
        worst = { severity: r.severity, message: `recursive delete of ${r.target}` };
      }
    }
    if (/\b(?:Remove-Item|ri|del|rmdir|rd)\b[^\n]*-Recurse\b/i.test(line) && PS_DANGEROUS_TARGET.test(line.replace(/^[^]*?(?:Remove-Item|ri|del|rmdir|rd)\b/i, " "))) {
      worst = { severity: "critical", message: "PowerShell recursive delete of a drive root or home folder" };
    }
    if (/\b(?:rd|rmdir)\s+\/s\b/i.test(line) || /\bdel\s+[^\n]*\/s\b/i.test(line)) {
      if (CMD_DANGEROUS_TARGET.test(line.replace(/\/[sqfa]\b/gi, " "))) {
        worst = { severity: "critical", message: "cmd recursive delete of a drive root or home folder" };
      }
    }
    if (/\bfind\s+(?:\/|~|\$HOME|"\$HOME"|\/Users|\/home)(?:\s|\/\s)[^\n]*(?:-delete\b|-exec\s+rm\b)/.test(line)) {
      worst = { severity: "critical", message: "find over the root or home folder with delete" };
    }
    return worst === null ? null : { line: i + 1, evidence: line, severity: worst.severity, message: worst.message };
  });
}

// ---------- permissions ----------

const AUTO_APPROVE: readonly RegExp[] = [
  /\\?["']?permissionDecision\\?["']?\s*:\s*\\?["']allow\\?["']/,
  /\\?["']?decision\\?["']?\s*:\s*\\?["']approve\\?["']/,
  /\\?["']?behavior\\?["']?\s*:\s*\\?["']allow\\?["']/,
];

function hookAutoApprove(file: ScanFile): RuleHit[] {
  const inConfig = file.kind === "hooks-config" || file.kind === "settings-json" || file.kind === "plugin-manifest";
  return eachLine(file, (line: string, i: number) => {
    const m = firstMatch(line, AUTO_APPROVE);
    if (m === null) return null;
    return inConfig
      ? { line: i + 1, evidence: line, severity: "critical", message: "a hook command in a config file prints a constant allow decision" }
      : { line: i + 1, evidence: line, severity: "high", message: "code emits an allow decision for the agent's permission check" };
  });
}

const UNSAFE_MODE: readonly RegExp[] = [
  /--dangerously-skip-permissions\b/,
  /--dangerously-bypass-approvals-and-sandbox\b/,
  /--(?:permission-mode|approval-mode)[=\s]+["']?(?:bypassPermissions|yolo)\b/i,
  /(?:^|\s)--yolo\b/,
  /["']?defaultMode["']?\s*[:=]\s*["']bypassPermissions["']/,
  /\bsandbox_mode\s*=\s*["']danger-full-access["']/,
  /["']skipDangerousModePermissionPrompt["']\s*:\s*true/,
];

const AGENT_CLI = /\b(?:claude|codex|gemini|opencode)\b/i;

function unsafeAgentMode(file: ScanFile): RuleHit[] {
  const lines = splitLines(file.text);
  const fenced = fencedLineFlags(lines);
  const prose = isProse(file.kind);
  const hits: RuleHit[] = [];
  lines.forEach((line: string, i: number) => {
    const m = firstMatch(line, UNSAFE_MODE);
    if (m === null) return;
    if (prose && !fenced[i] && !AGENT_CLI.test(line)) return;
    hits.push({ line: i + 1, evidence: line, message: `disables the agent's permission prompts (${m[0].trim()})` });
  });
  return hits;
}

const WILDCARD_TOOLS = new Set<string>(["*", "Bash", "Bash(*)", "Bash(*:*)", "Bash(:*)", "PowerShell", "PowerShell(*)", "mcp__*"]);

function frontmatterAllowedTools(file: ScanFile): RuleHit[] {
  const fm = /^(?:\ufeff)?---\r?\n([\s\S]*?)\r?\n---/.exec(file.text);
  if (fm === null) return [];
  const body = fm[1] ?? "";
  const lines = body.split(/\r?\n/);
  const hits: RuleHit[] = [];
  lines.forEach((l: string, i: number) => {
    const km = /^(allowed-tools|allowed_tools|tools)\s*:\s*(.*)$/.exec(l);
    if (km === null) return;
    let value = km[2] ?? "";
    for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j] ?? ""); j++) value += ` ${(lines[j] ?? "").replace(/^\s*-\s+/, "")}`;
    const toks = value.match(/[A-Za-z_][\w-]*(?:\([^)]*\))?|\*/g) ?? [];
    const broad = toks.filter((t: string) => WILDCARD_TOOLS.has(t.replace(/\s+/g, "")));
    if (broad.length > 0) {
      hits.push({ line: i + 2, evidence: l, message: `grants unscoped tools: ${broad.join(", ")}` });
    }
  });
  return hits;
}

function broadPermissions(file: ScanFile): RuleHit[] {
  if (file.kind === "skill-md" || file.kind === "markdown") return frontmatterAllowedTools(file);
  if (file.kind === "toml") {
    return eachLine(file, (line: string, i: number) =>
      /\bapproval_policy\s*=\s*["']never["']/.test(line)
        ? { line: i + 1, evidence: line, message: "Codex approval policy set to never ask" }
        : null);
  }
  const parsed = parseJsonLoose(file.text);
  if (!parsed.ok || !isRecord(parsed.value)) return [];
  const root = parsed.value;
  const hits: RuleHit[] = [];
  const perms = root["permissions"];
  if (isRecord(perms)) {
    for (const entry of asStringArray(perms["allow"])) {
      if (WILDCARD_TOOLS.has(entry.replace(/\s+/g, ""))) {
        const line = findLine(file.text, entry);
        hits.push({ line, evidence: lineText(file.text, line), message: `permissions.allow contains ${entry}` });
      }
    }
  }
  if (root["enableAllProjectMcpServers"] === true) {
    const line = findLine(file.text, "enableAllProjectMcpServers");
    hits.push({ line, evidence: lineText(file.text, line), severity: "medium", message: "auto-trusts every MCP server a project declares" });
  }
  return hits;
}

function hookCommands(file: ScanFile): RuleHit[] {
  const parsed = parseJsonLoose(file.text);
  if (!parsed.ok || !isRecord(parsed.value)) return [];
  const hooks = parsed.value["hooks"];
  if (!isRecord(hooks)) return [];
  const hits: RuleHit[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isRecord(g)) continue;
      const matcher = asString(g["matcher"]) ?? "*";
      const inner = Array.isArray(g["hooks"]) ? g["hooks"] : [];
      for (const h of inner) {
        if (!isRecord(h)) continue;
        const cmd = asString(h["command"]);
        if (cmd === undefined) continue;
        const line = findLine(file.text, cmd);
        hits.push({ line, evidence: cmd, message: `runs automatically on ${event} (matcher ${matcher || "*"})` });
      }
    }
  }
  return hits;
}

// ---------- MCP and packages ----------

const EXACT_NPM = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(?:-[\w.]+)?$/i;
const EXACT_PY = /^[A-Za-z0-9][\w.-]*(?:==|@)\d+(?:\.\d+)*$/;
const RUNNERS = new Set<string>(["npx", "bunx", "pnpx", "uvx", "pipx", "pnpm", "yarn", "bun", "docker", "podman"]);

function packageSpec(command: string, args: readonly string[]): { spec: string; autoYes: boolean } | null {
  const bin = (command.split(/[\\/]/).pop() ?? command).replace(/\.(cmd|exe)$/i, "");
  if (!RUNNERS.has(bin)) return null;
  let rest = [...args];
  if ((bin === "pnpm" || bin === "yarn") && rest[0] === "dlx") rest = rest.slice(1);
  else if (bin === "pipx" && rest[0] === "run") rest = rest.slice(1);
  else if (bin === "bun" && rest[0] === "x") rest = rest.slice(1);
  else if ((bin === "docker" || bin === "podman") && rest[0] === "run") rest = rest.slice(1);
  else if (bin === "pnpm" || bin === "yarn" || bin === "pipx" || bin === "bun" || bin === "docker" || bin === "podman") return null;
  const autoYes = rest.some((a: string) => a === "-y" || a === "--yes");
  const valueFlags = new Set<string>(["-p", "--package", "--from", "-e", "--env", "-v", "--volume", "--name", "--network", "--entrypoint", "-w", "--workdir", "-u", "--user"]);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a.startsWith("-")) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    return { spec: a, autoYes };
  }
  return null;
}

function isPinned(bin: string, spec: string): boolean {
  if (bin === "docker" || bin === "podman") return /@sha256:[a-f0-9]{64}$/.test(spec);
  if (bin === "uvx" || bin === "pipx") return EXACT_PY.test(spec);
  return EXACT_NPM.test(spec);
}

const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i;

interface ServerEntry {
  readonly name: string;
  readonly value: Record<string, unknown>;
}

function mcpServers(file: ScanFile): ServerEntry[] {
  const parsed = parseJsonLoose(file.text);
  if (!parsed.ok || !isRecord(parsed.value)) return [];
  const root = parsed.value;
  const out: ServerEntry[] = [];
  const containers: unknown[] = [root["mcpServers"], root["servers"], isRecord(root["mcp"]) ? root["mcp"]["servers"] : undefined];
  for (const c of containers) {
    if (!isRecord(c)) continue;
    for (const [name, v] of Object.entries(c)) if (isRecord(v)) out.push({ name, value: v });
  }
  return out;
}

const NPX_LINE = /\b(npx|bunx|pnpx|pnpm\s+dlx|yarn\s+dlx|uvx)\s+((?:-{1,2}[\w-]+\s+)*)([^\s"'`;|&]+)/;

function unpinnedPackage(file: ScanFile): RuleHit[] {
  if (file.kind === "mcp-config" || file.kind === "plugin-manifest") {
    const hits: RuleHit[] = [];
    for (const s of mcpServers(file)) {
      const command = asString(s.value["command"]);
      if (command === undefined) continue;
      const args = asStringArray(s.value["args"]);
      const p = packageSpec(command, args);
      if (p === null) continue;
      const bin = (command.split(/[\\/]/).pop() ?? command).replace(/\.(cmd|exe)$/i, "");
      if (isPinned(bin, p.spec)) continue;
      const line = findLine(file.text, p.spec);
      hits.push({
        line,
        evidence: lineText(file.text, line) || `${command} ${args.join(" ")}`,
        message: `MCP server "${s.name}" runs ${p.spec} without an exact version${p.autoYes ? " and auto-confirms the install" : ""}`,
      });
    }
    return hits;
  }
  if (isProse(file.kind)) return [];
  return eachLine(file, (line: string, i: number) => {
    const m = NPX_LINE.exec(line);
    if (m === null) return null;
    const runner = (m[1] ?? "").split(/\s+/)[0] ?? "";
    const spec = m[3] ?? "";
    if (spec.startsWith("$") || spec.startsWith("./") || spec.startsWith("../")) return null;
    if (isPinned(runner === "uvx" ? "uvx" : "npx", spec)) return null;
    const autoYes = /(?:^|\s)(?:-y|--yes)(?:\s|$)/.test(m[2] ?? "");
    if (runner === "npx" && !autoYes) return null;
    return { line: i + 1, evidence: line, message: `${runner} runs ${spec} without an exact version${autoYes ? " and auto-confirms the install" : ""}` };
  });
}

function remoteServer(file: ScanFile): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const s of mcpServers(file)) {
    const urls: string[] = [];
    const u = asString(s.value["url"]) ?? asString(s.value["serverUrl"]) ?? asString(s.value["httpUrl"]);
    if (u !== undefined) urls.push(u);
    for (const a of asStringArray(s.value["args"])) if (/^https?:\/\//i.test(a)) urls.push(a);
    for (const url of urls) {
      let host = "";
      let scheme = "";
      try {
        const parsed = new URL(url);
        host = parsed.hostname;
        scheme = parsed.protocol;
      } catch {
        const line = findLine(file.text, url);
        hits.push({ line, evidence: lineText(file.text, line), severity: "medium", message: `MCP server "${s.name}" has an unparseable URL` });
        continue;
      }
      if (LOCAL_HOST.test(host)) continue;
      const line = findLine(file.text, url);
      hits.push(
        scheme === "http:"
          ? { line, evidence: lineText(file.text, line), severity: "high", message: `MCP server "${s.name}" is remote over cleartext HTTP (${host})` }
          : { line, evidence: lineText(file.text, line), message: `MCP server "${s.name}" is remote (${host}); its tools can change after you approve it` },
      );
    }
  }
  return hits;
}

const INSTALL_HOOKS: ReadonlyMap<string, Severity> = new Map<string, Severity>([
  ["preinstall", "medium"],
  ["install", "medium"],
  ["postinstall", "medium"],
  ["preuninstall", "medium"],
  ["postuninstall", "medium"],
  ["prepare", "low"],
]);

function installScripts(file: ScanFile): RuleHit[] {
  const parsed = parseJsonLoose(file.text);
  if (!parsed.ok || !isRecord(parsed.value)) return [];
  const scripts = parsed.value["scripts"];
  if (!isRecord(scripts)) return [];
  const hits: RuleHit[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    const sev = INSTALL_HOOKS.get(name);
    if (sev === undefined || typeof cmd !== "string") continue;
    const line = findLine(file.text, `"${name}"`);
    hits.push({ line, evidence: lineText(file.text, line), severity: sev, message: `npm runs the "${name}" script automatically` });
  }
  return hits;
}

// ---------- obfuscation ----------

const BASE64_RUN = /[A-Za-z0-9+/]{200,}={0,2}/;
const HEX_RUN = /(?:[0-9a-fA-F]{2}){100,}/;

function encodedBlob(file: ScanFile): RuleHit[] {
  return eachLine(file, (line: string, i: number) => {
    if (/data:(?:image|font|audio|video)\/[\w.+-]+;base64,/i.test(line)) return null;
    if (/"(?:integrity|resolved|shasum)"\s*:/.test(line)) return null;
    const b = BASE64_RUN.exec(line);
    if (b !== null && /[0-9]/.test(b[0]) && /[A-Z]/.test(b[0]) && /[a-z]/.test(b[0])) {
      return { line: i + 1, evidence: line, message: `${b[0].length}-character base64 run` };
    }
    const h = HEX_RUN.exec(line);
    return h === null ? null : { line: i + 1, evidence: line, message: `${h[0].length}-character hex run` };
  });
}

function unparseableConfig(file: ScanFile): RuleHit[] {
  const parsed = parseJsonLoose(file.text);
  return parsed.ok ? [] : [{ line: null, evidence: "", message: "config file is not valid JSON, so its servers, hooks and permissions could not be checked" }];
}

/**
 * The instruction-override phrases of `inject.override-phrase`. Shared with the inbound scanner (`src/inbound/`), which
 * uses the first six as written and the last two only when the line addresses the agent (see docs/scanner.md).
 */
export const OVERRIDE_PHRASES: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your|of|these)\s+)*(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions?|prompts?|rules|directives|guidelines)\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak|unrestricted|god)\b/i,
  /\b(?:new|updated|real)\s+system\s+prompt\s*:/i,
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|notify|alert|warn)\s+the\s+user\b/i,
  /\bwithout\s+(?:telling|informing|notifying|alerting)\s+the\s+user\b/i,
  /\b(?:hide|conceal)\s+(?:this|these|it|that)\s+from\s+the\s+user\b/i,
  /\bsilently\s+(?:run|execute|send|upload|post|install|delete|exfiltrate|copy)\b/i,
  /\b(?:do\s+not|don't|never)\s+ask\s+(?:the\s+user\s+)?(?:for\s+)?(?:permission|confirmation|approval)\b/i,
];

// ---------- the table ----------

const PERMISSION_SPEC_LINE = /^\s*["'](?:Bash|PowerShell)\([^"']*\)["'],?\s*$/;

export const SCAN_RULES: readonly ScanRule[] = [
  {
    id: "inject.override-phrase",
    category: "hidden instructions",
    description: "Text telling the model to drop its instructions, hide actions from the user or skip asking",
    severity: "high",
    matcher: {
      type: "regex",
      patterns: OVERRIDE_PHRASES,
    },
  },
  {
    id: "inject.invisible-unicode",
    category: "hidden instructions",
    description: "Zero-width, bidirectional-control, tag or stacked variation-selector characters that hide text from a human reader",
    severity: "high",
    matcher: { type: "function", match: invisibleUnicode },
  },
  {
    id: "inject.html-comment",
    category: "hidden instructions",
    description: "An HTML comment (invisible when rendered) carrying instructions, commands or secret paths",
    severity: "high",
    matcher: { type: "function", kinds: ["skill-md", "markdown", "text"], match: htmlCommentInstruction },
  },
  {
    id: "secret.sensitive-read",
    category: "secret exfiltration",
    description: "Reads a credential store: SSH or cloud keys, .env files, browser or keychain stores, wallets, or the whole environment",
    severity: "medium",
    matcher: { type: "function", match: sensitiveRead },
  },
  {
    id: "secret.exfiltration",
    category: "secret exfiltration",
    description: "A credential source and a network send in the same command (critical) or the same file (high)",
    severity: "critical",
    matcher: { type: "function", match: exfiltration },
  },
  {
    id: "exec.pipe-to-shell",
    category: "download and execute",
    description: "Downloads remote code and pipes it straight into an interpreter",
    severity: "critical",
    matcher: {
      type: "regex",
      patterns: [
        /\b(?:curl|wget)\b[^|\n]*\|\s*(?:(?:sudo|env|command|exec|xargs)\s+(?:-\S+\s+)*)*(?:\S*\/)?(?:ba|z|da|k|fi)?sh\b/i,
        /\b(?:curl|wget)\b[^|\n]*\|\s*(?:(?:sudo|env|command|exec|xargs)\s+(?:-\S+\s+)*)*(?:\S*\/)?(?:python[0-9.]*|perl|ruby|node|php)\b/i,
        /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b[^\n]*\|\s*(?:iex|Invoke-Expression)\b/i,
        /\b(?:iex|Invoke-Expression)\b[^\n]*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b/i,
        /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/i,
        /\bsource\s+<\(\s*(?:curl|wget)\b/i,
        /\b(?:sh|bash|zsh|python[0-9.]*|perl|ruby|node)\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b/i,
        /\beval\s+["']?\$\(\s*(?:curl|wget)\b/i,
      ],
      unless: [/\|\s*python[0-9.]*\s+-m\s+json\.tool\b/],
    },
  },
  {
    id: "exec.download-then-run",
    category: "download and execute",
    description: "Downloads a file and runs or marks it executable in the same command",
    severity: "high",
    matcher: {
      type: "regex",
      patterns: [
        /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n]*(?:\s-[a-zA-Z]*[oO]|--output|-OutFile)\s*\S+[^\n]*(?:&&|;|\|\|)\s*(?:sudo\s+)?(?:(?:ba|z)?sh\s|chmod\s+(?:[ugoa]*\+x|[0-7]*[1357]\b)|\.\/|python[0-9.]*\s|node\s|powershell|pwsh|Start-Process|msiexec)/i,
      ],
    },
  },
  {
    id: "exec.decode-and-run",
    category: "download and execute",
    description: "Decodes base64 or similar and executes the result",
    severity: "critical",
    matcher: {
      type: "regex",
      patterns: [
        /\bbase64\s+(?:-d|--decode|-D)\b[^\n]*\|\s*(?:sudo\s+)?(?:(?:ba|z|da)?sh|python[0-9.]*|perl|node|ruby)\b/i,
        /\b(?:eval|exec|Function)\s*\(\s*(?:atob|Buffer\.from|base64\.b64decode|b64decode|decodeURIComponent|unescape|codecs\.decode|bytes\.fromhex|zlib\.decompress)\b/i,
        /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:e|ec|en|enc|enco|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i,
        /FromBase64String[^\n]*(?:\biex\b|Invoke-Expression|\.Invoke\(|Assembly\]::Load)/i,
        /(?:\biex\b|Invoke-Expression)[^\n]*FromBase64String/i,
      ],
    },
  },
  {
    id: "exec.reverse-shell",
    category: "download and execute",
    description: "Opens an interactive shell to a remote host",
    severity: "critical",
    matcher: {
      type: "regex",
      patterns: [
        /\/dev\/(?:tcp|udp)\/[^\s/]+\/\d+/,
        /\b(?:nc|ncat|netcat)\b[^\n]*\s-(?:e|c)\s+\S*(?:sh|cmd)\b/i,
        /\bsocat\b[^\n]*\bexec:/i,
        /\bbash\s+-i\s+>&/,
        /\bmkfifo\b[^\n]*\b(?:nc|ncat)\b/,
      ],
    },
  },
  {
    id: "destroy.recursive-delete",
    category: "destructive",
    description: "Recursive delete of the root, a system folder or the home folder (critical), or of a bare variable, wide glob or home subfolder (high)",
    severity: "critical",
    matcher: { type: "function", match: destructiveDelete },
  },
  {
    id: "destroy.disk",
    category: "destructive",
    description: "Formats, wipes or overwrites a disk, or forks without bound",
    severity: "critical",
    matcher: {
      type: "regex",
      patterns: [
        /\bmkfs(?:\.\w+)?\s+[^\n]*\/dev\//,
        /\bdd\b[^\n]*\bof=\/dev\/(?:sd|hd|nvme|disk|rdisk|mmcblk|xvd)/,
        /\bdiskutil\s+(?:eraseDisk|eraseVolume|zeroDisk|secureErase|partitionDisk)\b/i,
        /\bformat(?:\.com)?\s+[A-Za-z]:(?:\s|$)/,
        /\b(?:Format-Volume|Clear-Disk|Initialize-Disk)\b/i,
        /\bwipefs\s+-a\b/,
        /\bshred\b[^\n]*\/dev\//,
        /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
      ],
      unless: [PERMISSION_SPEC_LINE],
    },
  },
  {
    id: "destroy.history-or-data",
    category: "destructive",
    description: "Rewrites git history, discards work, or drops database objects",
    severity: "high",
    matcher: {
      type: "regex",
      patterns: [
        /\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b|\s\+[\w/-]+)/,
        /\bgit\s+reset\s+--hard\b/,
        /\bgit\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*/,
        /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
        /\bTRUNCATE\s+TABLE\b/i,
      ],
      unless: [PERMISSION_SPEC_LINE],
    },
  },
  {
    id: "destroy.online",
    category: "destructive",
    description: "Deletes something online: a repository, bucket, cloud resource, cluster object or published package",
    severity: "high",
    matcher: {
      type: "regex",
      patterns: [
        /\bgh\s+repo\s+delete\b/,
        /\baws\s+s3\s+rb\b/,
        /\baws\s+s3\s+rm\b[^\n]*--recursive\b/,
        /\bgcloud\b[^\n]*\bdelete\b/,
        /\bkubectl\s+delete\b/,
        /\bterraform\s+destroy\b/,
        /\bnpm\s+unpublish\b/,
        /\baz\s+(?:group|vm|storage\s+account)\s+delete\b/,
        /\bcurl\b[^\n]*(?:-X\s*DELETE|--request\s+DELETE)\b/,
      ],
      unless: [PERMISSION_SPEC_LINE],
    },
  },
  {
    id: "persist.shell-profile",
    category: "persistence",
    description: "Writes to a shell or PowerShell startup profile",
    severity: "high",
    matcher: {
      type: "regex",
      patterns: [
        /(?:>>?|\btee\b|\bAdd-Content\b|\bSet-Content\b|\bOut-File\b|appendFile(?:Sync)?\s*\(|writeFile(?:Sync)?\s*\()[^\n]*(?:\.bashrc|\.bash_profile|\.bash_login|\.zshrc|\.zprofile|\.zshenv|\.zlogin|\.profile\b|config\.fish|\$PROFILE\b|PowerShell_profile\.ps1)/i,
        /(?:\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.zshenv|\.profile)\b[^\n]*["']a\+?["']/,
      ],
    },
  },
  {
    id: "persist.scheduled-or-login",
    category: "persistence",
    description: "Installs a cron job, LaunchAgent, systemd unit, scheduled task, Run key or autostart entry",
    severity: "high",
    matcher: {
      type: "regex",
      patterns: [
        /\|\s*crontab(?:\s|$)/,
        /\bcrontab\s+-[er]\b/,
        /(?:>>?|\btee\b)[^\n]*\/(?:etc\/cron|var\/spool\/cron)/,
        /(?:>|\bcp\b|\bmv\b|\btee\b|\bln\b|writeFile|Copy-Item|\binstall\s)[^\n]*Launch(?:Agents|Daemons)/,
        /\blaunchctl\s+(?:load|bootstrap|enable|submit)\b/,
        /\bsystemctl\s+(?:--user\s+)?enable\b/,
        /(?:>|\bcp\b|\bmv\b|\btee\b|writeFile)[^\n]*\.config\/(?:systemd\/user|autostart)\//,
        /\bschtasks(?:\.exe)?\s+\/create\b/i,
        /\bRegister-ScheduledTask\b/i,
        /\\CurrentVersion\\Run(?:Once)?\b/i,
      ],
    },
  },
  {
    id: "persist.agent-config-write",
    category: "persistence",
    description: "Writes into an agent's own configuration, hooks, skills or MCP list, or into git hooks",
    severity: "high",
    matcher: {
      type: "regex",
      kinds: CODE_KINDS,
      patterns: [
        /(?:>>?|\btee\b|\bcp\b|\bmv\b|\bln\s+-s|writeFile(?:Sync)?|appendFile(?:Sync)?|Set-Content|Add-Content|Out-File|Copy-Item|\.write_text\()[^\n]*(?:\.claude[\\/](?:settings[^\s"']*\.json|hooks|agents|commands|skills)\b|\.claude[\\/]CLAUDE\.md|\.codex[\\/](?:config\.toml|skills)|\.gemini[\\/](?:settings\.json|extensions)|\.mcp\.json|\.git[\\/]hooks[\\/]|\.cursor[\\/](?:mcp\.json|rules))/,
        /(?:\.claude[\\/]settings[^\s"']*\.json|\.codex[\\/]config\.toml|\.gemini[\\/]settings\.json|\.mcp\.json|\.git[\\/]hooks[\\/]\S*)["']?\s*,\s*["'][wa]\+?["']/,
      ],
    },
  },
  {
    id: "perm.hook-auto-approve",
    category: "over-broad permissions",
    description: "A hook or script that answers the agent's permission check with allow",
    severity: "critical",
    matcher: { type: "function", match: hookAutoApprove },
  },
  {
    id: "perm.unsafe-agent-mode",
    category: "over-broad permissions",
    description: "Turns off the agent's permission prompts or sandbox (skip-permissions flags, bypassPermissions, danger-full-access)",
    severity: "critical",
    matcher: { type: "function", match: unsafeAgentMode },
  },
  {
    id: "perm.broad-allow",
    category: "over-broad permissions",
    description: "Grants unscoped tools: allow lists with *, Bash or Bash(*), skill allowed-tools likewise, approval never, or auto-trust of all MCP servers",
    severity: "high",
    matcher: { type: "function", kinds: ["skill-md", "markdown", "settings-json", "plugin-manifest", "json", "toml"], match: broadPermissions },
  },
  {
    id: "priv.escalation",
    category: "privilege",
    description: "Runs as administrator or root, sets setuid bits or makes files world-writable",
    severity: "medium",
    matcher: {
      type: "regex",
      kinds: CODE_KINDS,
      patterns: [
        /(?:^|[\s;&|("'`])sudo\s+(?!-[lvkK]\b)\S/,
        /(?:^|[\s;&|("'`])doas\s+\S/,
        /\bchmod\s+(?:-R\s+)?(?:[ugoa]*\+s|[2467][0-7]{3})\b/,
        /\bchmod\s+(?:-R\s+)?777\b/,
        /with\s+administrator\s+privileges/i,
        /\bStart-Process\b[^\n]*-Verb\s+RunAs\b/i,
      ],
    },
  },
  {
    id: "mcp.unpinned-package",
    category: "supply chain",
    description: "An MCP server or script that runs a package through npx, uvx or docker without an exact version or digest",
    severity: "medium",
    matcher: { type: "function", match: unpinnedPackage },
  },
  {
    id: "mcp.remote-server",
    category: "supply chain",
    description: "A remote MCP server: over cleartext HTTP (high) or HTTPS (medium); a remote server's tools cannot be pinned",
    severity: "medium",
    matcher: { type: "function", kinds: ["mcp-config", "plugin-manifest", "json", "settings-json"], match: remoteServer },
  },
  {
    id: "npm.install-script",
    category: "supply chain",
    description: "package.json scripts that npm runs automatically on install or uninstall (prepare is reported as low)",
    severity: "medium",
    matcher: { type: "function", kinds: ["package-json"], match: installScripts },
  },
  {
    id: "plugin.hook-command",
    category: "inventory",
    description: "A hook command that will run automatically; listed so a reviewer sees everything that runs",
    severity: "low",
    matcher: { type: "function", kinds: ["hooks-config", "settings-json", "plugin-manifest", "json"], match: hookCommands },
  },
  {
    id: "obfusc.encoded-blob",
    category: "obfuscation",
    description: "A long base64 or hex run outside an image data URI or lockfile hash",
    severity: "medium",
    matcher: { type: "function", match: encodedBlob },
  },
  {
    id: "obfusc.dynamic-code",
    category: "obfuscation",
    description: "Builds and runs code at runtime or spells strings out character by character",
    severity: "medium",
    matcher: {
      type: "regex",
      kinds: CODE_KINDS,
      patterns: [
        /(?<![\w$])eval\s*\(/,
        /(?<![\w$.])exec\s*\(\s*(?!["'`])[A-Za-z_]/,
        /\bnew\s+Function\s*\(/,
        /\bexec\s*\(\s*compile\s*\(/,
        /String\.fromCharCode\s*\(\s*(?:\d+\s*,\s*){8,}/,
        /(?:\\x[0-9a-fA-F]{2}){16,}/,
        /(?:\\u[0-9a-fA-F]{4}){16,}/,
        /\[char\]\s*(?:0x)?\d+\s*\+\s*\[char\]/i,
        /\bchr\(\d+\)\s*\+\s*chr\(\d+\)\s*\+\s*chr\(/,
        /-join\s*\(?\s*\[char\[\]\]/i,
        /\$\{IFS\}/,
        /\brev\s*\|\s*(?:ba|z)?sh\b/,
      ],
    },
  },
  {
    id: "scan.unparseable-config",
    category: "scanner",
    description: "A config file that is not valid JSON, so its servers, hooks and permissions could not be checked",
    severity: "medium",
    matcher: { type: "function", kinds: CONFIG_KINDS, match: unparseableConfig },
  },
  { id: "scan.symlink-escape", category: "scanner", description: "A symlink whose target lies outside the scanned folder (not followed)", severity: "high", matcher: { type: "walker" } },
  { id: "scan.symlink", category: "scanner", description: "A symlink inside the scanned folder (not followed, not scanned)", severity: "low", matcher: { type: "walker" } },
  { id: "scan.binary-file", category: "scanner", description: "A binary file that is not a known media type and cannot be read as text", severity: "medium", matcher: { type: "walker" } },
  { id: "scan.file-too-large", category: "scanner", description: "A file over the per-file size cap, not scanned", severity: "medium", matcher: { type: "walker" } },
  { id: "scan.limit-reached", category: "scanner", description: "The file-count, total-bytes or depth cap was reached; the rest was not scanned", severity: "medium", matcher: { type: "walker" } },
  { id: "scan.unreadable", category: "scanner", description: "A path that could not be read (missing, permission denied)", severity: "medium", matcher: { type: "walker" } },
  { id: "scan.special-file", category: "scanner", description: "A FIFO, socket or device file (never opened)", severity: "medium", matcher: { type: "walker" } },
  { id: "scan.rule-error", category: "scanner", description: "A rule threw while checking a file; the file counts as not checked", severity: "medium", matcher: { type: "walker" } },
];

export function ruleById(id: string, rules: readonly ScanRule[] = SCAN_RULES): ScanRule | undefined {
  return rules.find((r: ScanRule) => r.id === id);
}
