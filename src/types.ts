export type Decision = 'allow' | 'ask' | 'deny';

export const DECISIONS: readonly Decision[] = ['allow', 'ask', 'deny'];

export function decisionRank(d: Decision): number {
  return d === 'deny' ? 2 : d === 'ask' ? 1 : 0;
}

export function strictest(a: Decision, b: Decision): Decision {
  return decisionRank(b) > decisionRank(a) ? b : a;
}

export function isDecision(v: unknown): v is Decision {
  return v === 'allow' || v === 'ask' || v === 'deny';
}

export type ShellKind = 'posix' | 'powershell' | 'cmd';

/**
 * Text an action carries for content checks (0.14.0): capped at `ACTION_TEXT_MAX_BYTES` UTF-8 bytes; over the cap the first
 * and last halves are kept. Arguments and messages are redacted first; write content (0.15.0) is not, so a content rule
 * sees what lands on disk. Never written to the audit log or the session history.
 */
export interface ActionText {
  /** The text (redacted for arguments and messages), at most the cap, measured in UTF-8 bytes. */
  text: string;
  /** The UTF-8 size of the text before redaction and the cut. */
  bytes: number;
  /** True when the text was over the cap and only its first and last halves are kept. */
  cut: boolean;
}

/** One replacement an edit tool asks for (0.18.0): `old` becomes `new`, once or at every place `old` occurs (`all`). */
export interface ReplaceEdit {
  old: ActionText;
  new: ActionText;
  all: boolean;
}

/**
 * What a write does to the file already at its path (0.18.0), from the fields the host documents:
 * - `whole`: `content` is the whole new file (Write, write_file, a patch's Add File);
 * - `replace`: each edit's old text is replaced by its new text (Edit, replace, opencode edit);
 * - `lines`: a patch's Update File; `removed` holds the lines it takes out (each `-` line), `content` the lines it adds;
 * - `delete`: a patch's Delete File.
 */
export type WriteChange = { kind: 'whole' } | { kind: 'replace'; edits: ReplaceEdit[] } | { kind: 'lines'; removed: ActionText } | { kind: 'delete' };

export type Action =
  | { kind: 'exec'; command: string; shell: ShellKind; tool: string }
  | { kind: 'read'; path: string; tool: string }
  | {
      kind: 'write';
      path: string;
      tool: string;
      /** What the write puts in the file, from the host's documented field (0.15.0). Absent when the host gives none. */
      content?: ActionText;
      /**
       * How `content` relates to the file already there (0.18.0), read only by the document guard, in memory: never
       * written to the audit log or the session history. Absent when the host does not say.
       */
      change?: WriteChange;
    }
  | { kind: 'fetch'; url: string; tool: string }
  | {
      kind: 'other';
      tool: string;
      /** The call's arguments as compact JSON, each value redacted, capped (0.14.0). Absent when the host sent none. */
      args?: ActionText;
      /** The text handed to another agent: a child agent's prompt or a message to another agent or session (0.14.0). */
      message?: ActionText;
      /**
       * Every key, string and number of the call's input, one per line, NOT redacted, capped (0.16.0). Read only by
       * detectors, in memory: never written to the audit log or the session history and never put in a reason.
       */
      raw?: ActionText;
      /**
       * Every string and number of the call's input with the keys that lead to it (0.20.0), NOT redacted, at most
       * `ACTION_TEXT_MAX_VALUES` of them. Read only by the outbound guard, in memory: never written to the audit log or the
       * session history and never put in a reason.
       */
      leaves?: readonly ArgLeaf[];
    };

/** One value of a tool call's input and the keys (and list positions, as strings) that lead to it (0.20.0). */
export interface ArgLeaf {
  path: readonly string[];
  value: string;
}

export interface Verdict {
  decision: Decision;
  rule: string;
  reason: string;
}

export interface SessionState {
  toolCalls: number;
  tokens: number;
  /** Tokens at the last judged call: the budget asks when the count passes a soft step between two judged calls. */
  prevTokens: number;
  /** Spend from the user's price table, in hundredths of its currency (cents for dollars); absent until priced usage arrives. */
  cost?: number;
  prevCost?: number;
}

export const EMPTY_STATE: SessionState = Object.freeze({ toolCalls: 0, tokens: 0, prevTokens: 0 });

/** A model's price per million tokens, in one currency the user chooses. */
export interface ModelPrice {
  input: number;
  output: number;
}

export interface Limit {
  soft: number;
  hard: number;
  step: number;
}

export type RuleDecision = 'ask' | 'deny';

export interface RuleMatch {
  tool?: string;
  command?: string;
  path?: string;
  /**
   * A content pattern (0.15.0) over the text the action carries: a write's content, an `other` action's arguments and
   * message. Case-insensitive, `^`/`$` at line boundaries, matched in linear time (`src/rules/pattern.ts`).
   */
  content?: string;
  /**
   * Named detectors (0.16.0, `src/rules/detectors.ts`): one name or a list; the rule matches when any of them finds its
   * pattern in the text the action carries (write content, a command, a URL, a tool's arguments read unredacted).
   */
  detector?: string | string[];
  /** `true` (0.16.0): the rule matches only when the action reaches the network, as the taint guard computes it. */
  network?: true;
}

export interface Rule {
  id: string;
  match: RuleMatch;
  decision: RuleDecision;
  reason: string;
  hard: boolean;
}

/** The reviewer's wire protocol. `anthropic` is the 0.3 name of `anthropic-messages`; `fake` is a dry run that sends nothing. */
export type ReviewerProviderName = 'anthropic' | 'anthropic-messages' | 'openai-chat' | 'gemini' | 'fake';

export interface ReviewerCompat {
  /** openai-chat only: max_tokens (default) or max_completion_tokens. */
  token_param?: 'max_tokens' | 'max_completion_tokens';
  /** openai-chat only: system (default) or developer. */
  system_role?: 'system' | 'developer';
}

export interface ReviewerBylaws {
  enabled: boolean;
  provider: ReviewerProviderName;
  model: string;
  api_key_env: string;
  timeout_ms: number;
  on_escalate: RuleDecision;
  /** Where requests go; the protocol's public endpoint when absent. https, or http to this machine only. */
  base_url?: string;
  /** key (default): send the key named by api_key_env; none: send no key (a local server). */
  auth?: 'key' | 'none';
  compat?: ReviewerCompat;
}

export interface SandboxBylaws {
  network: { allow_hosts: string[] };
  /**
   * `protected_paths` (0.17.0): path globs from the project root, or `test-lock` for the paths that pack protects by
   * rule, made read-only inside the sandbox. User-level file only; absent by default.
   */
  write: { allow: string[]; protected_paths?: string[] };
  read: { deny: string[] };
}

/** Scanning of inbound content (tool results, fetched pages, submitted prompts) for hidden instructions. */
export interface InboundBylaws {
  enabled: boolean;
  /** For a prompt with hidden characters: allow records only, ask warns the user, deny blocks the prompt. A tool result is never blocked; with notify on, allow keeps it silent. */
  decision: Decision;
  /** Send the model (and the user) a short notice for each finding in a tool result. Off by default: a notice is re-sent with every later model call, so it costs tokens; the default is to taint and audit silently and speak only when a later action is stopped. */
  notify: boolean;
  /** Most bytes of one result or prompt that are scanned (the first and last half); the rest is not scanned. */
  max_bytes: number;
  /**
   * Opt-in (user-level file only): send the lines a weak finding in a tool result flagged (at most 1,000 characters,
   * redacted, cached by hash) to the reviewer's provider, which may only confirm them as an injection and so raise later
   * decisions. Off by default: no tokens are spent.
   */
  judge?: boolean;
}

/**
 * The document guard (0.18.0): asks before a write or command deletes a document, empties a file, removes more than
 * `shrink_percent` of a document (and at least `min_removed_bytes`), or removes a heading. A project file may lower the
 * share and the byte floor, add extensions and drop exclusions; it can never loosen the user's file (ADR 0010).
 */
export interface DocumentBylaws {
  decision: Decision;
  /** A write that leaves a document smaller by more than this percent of its size asks (1 to 100). */
  shrink_percent: number;
  /** A shrink smaller than this many bytes never counts as sharp (a small rewrite); emptying a file always does. */
  min_removed_bytes: number;
  /** File name extensions (lower case, no dot) that make a file a document. */
  extensions: string[];
  /** Globs (the `merge.always_review` grammar, from the project folder) of files the guard leaves alone. */
  exclude: string[];
}

/** What the delete guard does with a plain delete that `openmorals trash` can take (0.21.0): refuse it with the trash command named, or ask. */
export type DeleteSteer = 'trash' | 'ask';

export const DELETE_STEERS: readonly DeleteSteer[] = ['trash', 'ask'];

/** How strict a steer is: a refusal (`trash`) is stricter than an ask, so a project file may set `trash` over the user's `ask`, never the reverse. */
export function steerRank(s: DeleteSteer): number {
  return s === 'trash' ? 2 : 1;
}

/**
 * The delete guard (0.21.0): a plain delete of any existing file (`rm`, `unlink`, `del`, `erase`, `Remove-Item`, `git rm`
 * without `--cached`, a patch's file delete, an MCP delete naming a path). With `steer: trash` a target the trash can take
 * is refused with the `openmorals trash` command named; any other target gets `decision`; a path built at run time is
 * refused. `decision: allow` switches the guard off. A project file may only tighten both (ADR 0010).
 */
export interface DeleteBylaws {
  decision: Decision;
  steer: DeleteSteer;
}

/** What the replace guard does with a whole-file replacement outside git (0.24.0): nothing (`off`, the default), or refuse it until a copy is kept (`keep`). */
export type ReplaceSteer = 'off' | 'keep';

export const REPLACE_STEERS: readonly ReplaceSteer[] = ['off', 'keep'];

/** How strict a replace steer is: `keep` is stricter than `off`, so a project file may switch it on, never off. */
export function replaceRank(s: ReplaceSteer | undefined): number {
  return s === 'keep' ? 2 : 1;
}

/**
 * The replace guard (0.24.0), off by default: with `steer: keep`, replacing the whole content of an existing, non-empty
 * file with no `.git` above it is refused until a copy of that content is in the project trash (`openmorals trash --copy`).
 * Absent from the defaults, so a default policy is unchanged; a project file may switch it on, never off.
 */
export interface ReplaceBylaws {
  steer: ReplaceSteer;
}

/** The kinds of private data the outbound guard looks for in what leaves (0.20.0), each found by named detectors. */
export type DataClass = 'card' | 'bank' | 'national_id' | 'health' | 'email' | 'phone';

export const DATA_CLASSES: readonly DataClass[] = ['card', 'bank', 'national_id', 'health', 'email', 'phone'];

/** One data class (0.20.0): what happens when it is typed into a form or sent to a site outside `sites`. */
export interface DataClassBylaws {
  decision: Decision;
  /** Host names this class may go to without asking (a name covers the names under it). */
  sites: string[];
}

/**
 * The outbound guard (0.20.0): where a form, message or link sends data. Each ask has its own setting; the two denies
 * (a password or code typed into a look-alike of one of your sites, a code from a message typed into another site) can
 * be turned into asks, never off, and only in the user-level file.
 */
export interface OutboundBylaws {
  /** A password, passcode or one-time code typed into a site that is not in `sites`, an unknown page, or a page opened from an untrusted link; or a password or token in a URL. */
  credential: Decision;
  /** A destination that looks like one of `sites` or `protect` without being it, a name that mixes scripts or poses as an ASCII name, or user@host. */
  lookalike: Decision;
  /** A URL whose host is a public IP address instead of a name. */
  ip_host: Decision;
  /** A javascript:, data:, vbscript: or file: URL, an executable or macro-document download, a link-local (cloud metadata) address, or a private address that came from untrusted output. */
  dangerous_target: Decision;
  /** A link whose shown text names another site than the one it opens, followed or sent. */
  link_mismatch: Decision;
  /** A blind copy, a new outside recipient on a reply, or an address that appeared only inside untrusted output. */
  recipient: Decision;
  /** A password, passcode or one-time code typed into a look-alike of one of `sites` or `protect`. */
  lookalike_credential: RuleDecision;
  /** A one-time code seen in a message typed into a site that message did not name. */
  code_relay: RuleDecision;
  /** How long a code seen in a message is remembered, in minutes (1 to 60). */
  code_minutes: number;
}

/** A class of change that may merge without a person reading it (ADR 0013). */
export type MergeClass = 'tighten-only' | 'reproduced';

export const MERGE_CLASSES: readonly MergeClass[] = ['tighten-only', 'reproduced'];

/**
 * What `openmorals diff-class` may call review-free. Absent means nothing is switched on. Only the user-level file can
 * add a class; a project file can only remove one and add `always_review` paths (the user floor, ADR 0010).
 */
export interface MergeBylaws {
  review_free: MergeClass[];
  /** Globs of paths whose changes always need review (regulated, clinical, or simply important). */
  always_review: string[];
  /**
   * Globs of declared boundary paths (bounded contexts, public interfaces). A change under one with no decision record
   * under docs/adr/ gets an `integrity.boundary-no-adr` reason. A project file can add entries, never drop the user's.
   */
  boundary_paths?: string[];
}

export interface Bylaws {
  version: 1;
  guards: {
    destructive: { decision: Decision; allow_targets: string[] };
    'online-delete': { decision: Decision };
    secrets: { read: Decision; write: Decision; send: Decision; hard: boolean };
    'self-protect': { decision: Decision };
    budget: { tool_calls: Limit; tokens: Limit; cost?: Limit; prices?: Record<string, ModelPrice> };
    loop: { decision: Decision };
    taint: {
      decision: Decision;
      trusted_hosts: string[];
      /**
       * Globs (0.16.0, the `merge.always_review` grammar) of files that hold private data: reading one, or a command naming
       * one, marks the session as holding private data, like a secret file. A project file can add entries, never drop one.
       * Absent by default (so the bylaws digest of a default setup is unchanged).
       */
      private_paths?: string[];
    };
    inbound: InboundBylaws;
    /** The document guard (0.18.0). In the defaults; a policy built without it gets the defaults, never no guard. */
    document?: DocumentBylaws;
    /** The outbound guard (0.20.0). In the defaults; a policy built without it gets the defaults, never no guard. */
    outbound?: OutboundBylaws;
    /** The delete guard (0.21.0). In the defaults; a policy built without it gets the defaults, never no guard. */
    delete?: DeleteBylaws;
    /** The replace guard (0.24.0). Absent by default (off); see `ReplaceBylaws`. */
    replace?: ReplaceBylaws;
  };
  rules: Rule[];
  audit: { enabled: boolean };
  reviewer: ReviewerBylaws;
  sandbox: SandboxBylaws;
  merge?: MergeBylaws;
  /**
   * The deferred ask (0.19.0): with true, a deletion or document ask in an attended session is held for the person (denied
   * with a reason, queued, approved later on a channel the agent cannot type into) instead of asked. Under --unattended such
   * asks are held whatever this says. Absent by default (so the bylaws digest of a default setup is unchanged); a project
   * file can switch it on, never off.
   */
  defer?: boolean;
  /**
   * Your own sites (0.20.0): host names of the places you sign in to and send data to. A password or code goes to one of
   * them without asking; a name that looks like one of them is a look-alike. User-level file only; absent by default.
   */
  sites?: string[];
  /**
   * Sites whose look-alikes are judged as look-alikes of a `sites` entry are (0.23.0): opening one asks, typing a password
   * or code into one is refused. Never an exemption: a password or code typed into a `protect` entry itself still asks.
   * The person's own entries (the user-level file, or a file loaded on its own). Absent by default.
   */
  protect?: string[];
  /**
   * The `protect` entries a project file added on top of the person's (0.23.0), set only by the merge `resolveBylaws`
   * makes (no file can name this key). Each is matched on its own: a host under one is never exempt from the others, and
   * a host under one of the person's own `sites` or `protect` entries is never judged a look-alike of one.
   */
  project_protect?: string[];
  /** Per data class (0.20.0): what to do when it leaves, and where it may go. User-level file only; the defaults apply to a class left out. */
  data_classes?: Partial<Record<DataClass, DataClassBylaws>>;
  /**
   * The `disclaimer:` texts of the files in force (0.25.0), the user-level file's first: text for the person, written once
   * per session into the audit log. Never shown to the agent and never read by a guard, so it changes no decision. Absent
   * when no file has one (so the bylaws digest of a default setup is unchanged).
   */
  disclaimers?: string[];
}

/** One setting in which a candidate policy is looser than its baseline. */
export interface Loosening {
  field: string;
  candidate: string;
  baseline: string;
}

/**
 * A resolved policy. With a project file, `source` is that file, `floorSource` is the user-level
 * file (or `<defaults>`) it may only tighten, and `ignored` lists the project settings that would
 * have loosened the floor and were dropped. An invalid file still carries the strictest valid
 * policy that could be read as `floor`, so failing closed never falls below the user's settings.
 * `keptRest` (0.25.0): only the file's `principles:` or `disclaimer:` was wrong, so its `floor` is the rest of the file,
 * held at least as strict as what it was read over; every other guard and rule of the file stays in force.
 */
export type BylawsLoad =
  | { ok: true; bylaws: Bylaws; source: string; floorSource?: string; ignored?: Loosening[] }
  | { ok: false; error: string; source: string; floor?: Bylaws; keptRest?: true };
