import * as fs from "node:fs";
import * as path from "node:path";
import { classifyFile, isMediaFile, isProbablyBinary } from "./classify.js";
import { walkerFinding } from "./engine.js";
import type { ScanFinding, ScanRule, ScanFile, ScanLimits, Severity } from "./types.js";

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxFileBytes: 1024 * 1024,
  maxFiles: 2000,
  maxTotalBytes: 32 * 1024 * 1024,
  maxDepth: 24,
};

export const SKIPPED_DIRECTORIES: readonly string[] = [".git"];

export interface WalkResult {
  readonly files: ScanFile[];
  readonly findings: ScanFinding[];
  readonly filesSkipped: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
}

const O_NOFOLLOW: number = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function errText(e: unknown): string {
  if (typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return e instanceof Error ? e.message : String(e);
}

function readCapped(abs: string, cap: number): Uint8Array {
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    const buf = Buffer.alloc(Math.min(cap + 1, Math.max(st.size, 0) + 1));
    let total = 0;
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, total);
      if (n === 0) break;
      total += n;
    }
    return buf.subarray(0, total);
  } finally {
    fs.closeSync(fd);
  }
}

function isExecutableMagic(b: Uint8Array): boolean {
  const h = Array.from(b.subarray(0, 4));
  const hex = h.map((x: number) => x.toString(16).padStart(2, "0")).join("");
  return hex === "7f454c46" || hex === "cffaedfe" || hex === "cefaedfe" || hex === "feedface" || hex === "feedfacf" || hex === "cafebabe" || (h[0] === 0x4d && h[1] === 0x5a);
}

class Walker {
  readonly files: ScanFile[] = [];
  readonly findings: ScanFinding[] = [];
  filesSeen = 0;
  filesSkipped = 0;
  bytesRead = 0;
  truncated = false;
  private readonly rootAbs: string;
  private readonly limits: ScanLimits;
  private readonly rules: readonly ScanRule[];

  constructor(rootAbs: string, limits: ScanLimits, rules: readonly ScanRule[]) {
    this.rootAbs = rootAbs;
    this.limits = limits;
    this.rules = rules;
  }

  private add(ruleId: string, rel: string, message: string, severity?: Severity): void {
    const f = walkerFinding(ruleId, rel, message, this.rules);
    this.findings.push(severity === undefined ? f : { ...f, severity });
  }

  private stop(rel: string, message: string): void {
    if (!this.truncated) this.add("scan.limit-reached", rel, message);
    this.truncated = true;
  }

  visitFile(abs: string, rel: string, size: number): void {
    if (this.truncated) return;
    this.filesSeen++;
    if (this.filesSeen > this.limits.maxFiles) {
      this.stop(rel, `more than ${this.limits.maxFiles} files; the rest were not scanned`);
      return;
    }
    if (size > this.limits.maxFileBytes) {
      this.filesSkipped++;
      this.add("scan.file-too-large", rel, `${size} bytes is over the ${this.limits.maxFileBytes}-byte cap`);
      return;
    }
    if (this.bytesRead + size > this.limits.maxTotalBytes) {
      this.stop(rel, `total size passed ${this.limits.maxTotalBytes} bytes; the rest were not scanned`);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = readCapped(abs, this.limits.maxFileBytes);
    } catch (e: unknown) {
      this.filesSkipped++;
      this.add("scan.unreadable", rel, `could not read: ${errText(e)}`);
      return;
    }
    if (bytes.length > this.limits.maxFileBytes) {
      this.filesSkipped++;
      this.add("scan.file-too-large", rel, `grew past the ${this.limits.maxFileBytes}-byte cap while being read`);
      return;
    }
    this.bytesRead += bytes.length;
    if (isProbablyBinary(bytes)) {
      this.filesSkipped++;
      if (isMediaFile(rel) && !isExecutableMagic(bytes)) return;
      if (isExecutableMagic(bytes)) this.add("scan.binary-file", rel, "executable binary (ELF, Mach-O or PE); cannot be reviewed as text", "high");
      else this.add("scan.binary-file", rel, "binary content that is not a known media type");
      return;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    this.files.push({ path: rel, kind: classifyFile(rel, text), text });
  }

  visitDir(abs: string, rel: string, depth: number): void {
    if (this.truncated) return;
    if (depth > this.limits.maxDepth) {
      this.stop(rel, `folder depth passed ${this.limits.maxDepth}; deeper folders were not scanned`);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e: unknown) {
      this.add("scan.unreadable", rel === "" ? "." : rel, `could not list folder: ${errText(e)}`);
      return;
    }
    entries.sort((a: fs.Dirent, b: fs.Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (this.truncated) return;
      const childAbs = path.join(abs, ent.name);
      const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isSymbolicLink()) {
        this.visitSymlink(childAbs, childRel);
      } else if (ent.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(ent.name)) continue;
        this.visitDir(childAbs, childRel, depth + 1);
      } else if (ent.isFile()) {
        let size = 0;
        try {
          size = fs.lstatSync(childAbs).size;
        } catch (e: unknown) {
          this.add("scan.unreadable", childRel, `could not stat: ${errText(e)}`);
          continue;
        }
        this.visitFile(childAbs, childRel, size);
      } else {
        this.add("scan.special-file", childRel, "FIFO, socket or device file; not opened");
      }
    }
  }

  visitSymlink(abs: string, rel: string): void {
    let target = "";
    try {
      target = fs.readlinkSync(abs);
    } catch (e: unknown) {
      this.add("scan.unreadable", rel, `could not read symlink: ${errText(e)}`);
      return;
    }
    const resolved = path.resolve(path.dirname(abs), target);
    const inside = path.relative(this.rootAbs, resolved);
    const escapes = inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside);
    if (escapes) {
      this.add("scan.symlink-escape", rel, `points outside the scanned folder to ${target}`);
    } else {
      this.add("scan.symlink", rel, `points to ${toPosix(inside) || "."} inside the folder; not followed`);
    }
  }
}

export function walk(input: string, limits: ScanLimits, rules: readonly ScanRule[]): WalkResult {
  let rootAbs: string;
  try {
    rootAbs = fs.realpathSync(path.resolve(input));
  } catch (e: unknown) {
    return {
      files: [],
      findings: [walkerFinding("scan.unreadable", ".", `could not open ${input}: ${errText(e)}`, rules)],
      filesSkipped: 0,
      bytesRead: 0,
      truncated: false,
    };
  }
  const w = new Walker(rootAbs, limits, rules);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(rootAbs);
  } catch (e: unknown) {
    w.findings.push(walkerFinding("scan.unreadable", ".", `could not stat ${input}: ${errText(e)}`, rules));
    return { files: w.files, findings: w.findings, filesSkipped: 0, bytesRead: 0, truncated: false };
  }
  if (st.isDirectory()) w.visitDir(rootAbs, "", 0);
  else if (st.isFile()) w.visitFile(rootAbs, path.basename(rootAbs), st.size);
  else w.findings.push(walkerFinding("scan.special-file", ".", "not a regular file or folder; not opened", rules));
  return { files: w.files, findings: w.findings, filesSkipped: w.filesSkipped, bytesRead: w.bytesRead, truncated: w.truncated };
}
