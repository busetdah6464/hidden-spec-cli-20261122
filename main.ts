// main.ts is mend, the CLI SPEC.md specifies: it applies an edit that an AI model wrote to a tree of text
// files. Models write edits in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE
// blocks, the V4A patch format, and text-editor tool calls as JSON. Each format is read as SPEC.md says, and
// every file is changed or nothing is. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 (the command line, the output and exit codes, safe paths, format detection,
// JSON edits and the all-or-nothing write) follow the kit starter's implementation. Sections 5 to 8
// (matching lines at three tiers, unified diffs, SEARCH/REPLACE blocks and V4A patches) are written here
// from SPEC.md, sentence by sentence.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A text file as lines, with its own line break and whether it ends with one (SPEC.md section 3). */
interface Doc {
  lines: string[];
  br: '\r\n' | '\n';
  ends: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const parts = text.split(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.ends ? d.br : '');
}

const trimT = (s: string): string => s.replace(/[ \t]+$/, '');
const trimB = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Line equality at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimT(a) === trimT(b);
  return trimB(a) === trimB(b);
}

function occursAt(O: string[], lines: string[], i: number, tier: number): boolean {
  for (let k = 0; k < O.length; k++) {
    if (!lineEq(O[k]!, lines[i + k]!, tier)) return false;
  }
  return true;
}

/** Positions at which O occurs in lines at the given tier, at or after `from`. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    if (occursAt(O, lines, i, tier)) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs in lines at or after `from`, or -1 when it occurs at none. */
function findTier(O: string[], lines: string[], strict: boolean, from = 0): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (occurrences(O, lines, t, from).length > 0) return t;
  }
  return -1;
}

/** One line of N: a context line (written as the file's own line) or a new line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/**
 * Render N at a match (SPEC.md section 5): a context line is written as the file's own matched line, never
 * the patch's. At tier 2 every other line of N is re-indented: let F be the leading spaces and tabs of the
 * file's first matched line and P those of O's first line; a line of N that is not empty and not only
 * whitespace, and starts with P, has that P replaced by F. At tiers 0 and 1 the lines of N are as they are.
 */
function renderN(N: NLine[], O: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return N.map((e) => (e.ctx ? fileLines[pos + e.oIdx]! : e.text));
  const p = leadWs(O[0]!);
  const f = leadWs(fileLines[pos]!);
  return N.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIdx]!;
    const t = e.text;
    if (t === '' || t.trim() === '') return t;
    return t.startsWith(p) ? f + t.slice(p.length) : t;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move pairs of edits that succeeded, in order: [old path, new path]. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

/** One line of a hunk body. `empty` is true when the patch line itself was empty. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  empty: boolean;
}

interface Hunk {
  /** The hunk's old start A (1-based), from `@@ -A[,B] +C[,D] @@`. */
  a: number;
  body: BodyLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;

/** The path of a `--- ` or `+++ ` header line: text after the four characters, up to the first tab, with
 *  surrounding spaces removed; `/dev/null` means no file; a leading `a/` or `b/` is removed from either. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseDiffGit(line: string, lineno: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineno}`);
  const sep = rest.indexOf(' b/');
  if (sep < 0) throw new Exit2(`error: parse ${lineno}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineno}`);
  return [x, y];
}

/**
 * Apply one hunk to a file's lines. `d` is the sum over this section's hunks applied so far of (N's length
 * minus O's length). When O is not empty, of the occurrences at the tier where O is found, the hunk takes
 * the one whose 0-based position is nearest to A - 1 + d; of two equally near, the earlier. When O is empty,
 * N is inserted after the first A + d lines (all of them when the file has fewer).
 */
function applyUnifiedHunk(doc: Doc, h: Hunk, d: number, strict: boolean, path: string): Doc {
  const O: string[] = [];
  const N: NLine[] = [];
  let lastCp = -1; // index in the body of the last context or `+` line
  for (let bi = 0; bi < h.body.length; bi++) {
    const bl = h.body[bi]!;
    if (bl.kind === ' ') {
      O.push(bl.text);
      N.push({ text: bl.text, ctx: true, oIdx: O.length - 1 });
      lastCp = bi;
    } else if (bl.kind === '-') {
      O.push(bl.text);
    } else if (bl.kind === '+') {
      N.push({ text: bl.text, ctx: false, oIdx: -1 });
      lastCp = bi;
    }
  }
  const noNL = lastCp >= 0 && h.body[lastCp + 1]?.kind === '\\';
  let lines = doc.lines;
  let ends = doc.ends;
  if (O.length > 0) {
    const tier = findTier(O, lines, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrences(O, lines, tier, 0);
    const target = h.a - 1 + d;
    let best = occ[0]!;
    for (const p of occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const repl = renderN(N, O, lines, best, tier);
    lines = [...lines.slice(0, best), ...repl, ...lines.slice(best + O.length)];
    // When a hunk's matched lines run to the end of the file, the result ends with a line break unless a
    // `\` line follows the hunk's last context or `+` line; when they do not, the file's final break stays.
    if (best + O.length === doc.lines.length) ends = !noNL;
  } else {
    const at = Math.min(h.a + d, lines.length);
    const repl = N.map((e) => e.text);
    lines = [...lines.slice(0, at), ...repl, ...lines.slice(at)];
    if (repl.length > 0 && at === doc.lines.length) ends = !noNL;
  }
  return { lines, br: doc.br, ends };
}

function makeUnifiedEdit(oldPath: string, newPath: string, isNew: boolean, isDeleted: boolean, hunks: Hunk[], strict: boolean): Edit {
  return (tree) => {
    const creation = oldPath === '/dev/null' || isNew;
    const deletion = newPath === '/dev/null' || isDeleted;
    if (creation) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let anyPlus = false;
      let lastPlusNoNL = false;
      for (const h of hunks) {
        let lp = -1;
        for (let bi = 0; bi < h.body.length; bi++) {
          if (h.body[bi]!.kind === '+') {
            plus.push(h.body[bi]!.text);
            lp = bi;
          }
        }
        if (lp >= 0) {
          anyPlus = true;
          lastPlusNoNL = h.body[lp + 1]?.kind === '\\';
        }
      }
      // A created file ends with a line break unless a `\` line follows its last `+` line.
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (anyPlus && lastPlusNoNL ? '' : '\n'));
      return;
    }
    if (deletion) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      let doc = parseDoc(cur);
      let d = 0;
      for (const h of hunks) {
        const before = doc.lines.length;
        doc = applyUnifiedHunk(doc, h, d, strict, oldPath);
        d += doc.lines.length - before;
      }
      tree.now.set(oldPath, null);
      tree.now.set(newPath, writeDoc(doc));
      tree.moves.push([oldPath, newPath]);
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const cur = tree.get(oldPath);
    if (cur === null) throw new Fail('missing', oldPath);
    let doc = parseDoc(cur);
    let d = 0;
    for (const h of hunks) {
      const before = doc.lines.length;
      doc = applyUnifiedHunk(doc, h, d, strict, oldPath);
      d += doc.lines.length - before;
    }
    tree.now.set(oldPath, writeDoc(doc));
  };
}

/** Parse one section (header and hunks) starting at `i`; returns the index after the section. */
function parseUnifiedSection(lines: string[], i: number, edits: Edit[], oldPath: string, newPath: string, strict: boolean): number {
  const n = lines.length;
  let isNew = false;
  let isDeleted = false;
  let sawPair = false;
  const hunks: Hunk[] = [];
  // Header: before the first hunk.
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      if (!HUNK_RE.test(line)) throw new Exit2(`error: parse ${i + 1}`);
      break;
    }
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        oldPath = headerPath(line);
        newPath = headerPath(lines[i + 1]!);
        sawPair = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('rename from ') && !sawPair) {
      oldPath = line.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ') && !sawPair) {
      newPath = line.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      isNew = true;
      isDeleted = false;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      isDeleted = true;
      isNew = false;
      i++;
      continue;
    }
    i++;
  }
  // Hunks. Outside bodies, lines that are not part of a section header are ignored.
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      hunks.push(hunk);
      i++;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          hunk.body.push({ kind: ' ', text: '', empty: true });
          i++;
          continue;
        }
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          hunk.body.push({ kind: c, text: b.slice(1), empty: false });
          i++;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.empty) hunk.body.pop();
      continue;
    }
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    i++;
  }
  edits.push(makeUnifiedEdit(oldPath, newPath, isNew, isDeleted, hunks, strict));
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [op, np] = parseDiffGit(line, i + 1);
      i++;
      i = parseUnifiedSection(lines, i, edits, op, np, strict);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const op = headerPath(line);
      const np = headerPath(lines[i + 1]!);
      i += 2;
      i = parseUnifiedSection(lines, i, edits, op, np, strict);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseDoc(cur);
    const tier = findTier(oldLines, doc.lines, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrences(oldLines, doc.lines, tier, 0);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const pos = occ[0]!;
    const repl = renderN(
      newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })),
      oldLines,
      doc.lines,
      pos,
      tier,
    );
    const lines = [...doc.lines.slice(0, pos), ...repl, ...doc.lines.slice(pos + oldLines.length)];
    tree.now.set(path, writeDoc({ lines, br: doc.br, ends: doc.ends }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = 0; // index after the previous block's `>>>>>>> REPLACE` line
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      // The path is the nearest line before the SEARCH line, and after the previous block's REPLACE
      // line (or the start of the patch), that is not blank and, its surrounding whitespace removed,
      // does not start with three backticks.
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j]!;
        if (blank(t)) continue;
        const tr = t.trim();
        if (tr.startsWith('```')) continue;
        path = tr;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
      edits.push(makeSearchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
      prevPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** The chunk's anchor, or null when the `@@` line carried no text. */
  anchor: string | null;
  lines: BodyLine[];
  /** True when a `*** End of File` line ended this chunk. */
  eof: boolean;
}

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function makeV4aAdd(path: string, contentLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    // The file is the section's lines, ended by a line break.
    tree.now.set(path, contentLines.length === 0 ? '' : contentLines.join('\n') + '\n');
  };
}

function makeV4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/**
 * Apply one V4A chunk. The cursor starts at line 0. A chunk with an anchor first finds the first line at
 * or after the cursor equal to the anchor at the first tier where one is; the cursor moves past it. The
 * chunk takes the first occurrence of O at or after the cursor, at the first tier with one; an end-of-file
 * chunk takes only an occurrence that ends at the file's last line. When O is empty, N is inserted at the
 * cursor, or at the end of the file for an end-of-file chunk. The cursor then moves to just after the
 * lines written.
 */
function applyV4aChunk(doc: Doc, chunk: V4aChunk, cursor: number, strict: boolean, path: string): { doc: Doc; cursor: number } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const bl of chunk.lines) {
    if (bl.kind === ' ') {
      O.push(bl.text);
      N.push({ text: bl.text, ctx: true, oIdx: O.length - 1 });
    } else if (bl.kind === '-') {
      O.push(bl.text);
    } else if (bl.kind === '+') {
      N.push({ text: bl.text, ctx: false, oIdx: -1 });
    }
  }
  let lines = doc.lines;
  let cur = cursor;
  if (chunk.anchor !== null) {
    const tier = findTier([chunk.anchor], lines, strict, cur);
    if (tier < 0) throw new Fail('no-match', path);
    cur = occurrences([chunk.anchor], lines, tier, cur)[0]! + 1;
  }
  if (O.length === 0) {
    const at = chunk.eof ? lines.length : cur;
    const repl = N.map((e) => e.text);
    lines = [...lines.slice(0, at), ...repl, ...lines.slice(at)];
    return { doc: { lines, br: doc.br, ends: doc.ends }, cursor: at + repl.length };
  }
  const tier = findTier(O, lines, strict, cur);
  if (tier < 0) throw new Fail('no-match', path);
  let occ = occurrences(O, lines, tier, cur);
  if (chunk.eof) occ = occ.filter((p) => p + O.length === lines.length);
  if (occ.length === 0) throw new Fail('no-match', path);
  const pos = occ[0]!;
  const repl = renderN(N, O, lines, pos, tier);
  lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + O.length)];
  return { doc: { lines, br: doc.br, ends: doc.ends }, cursor: pos + repl.length };
}

function makeV4aUpdate(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = parseDoc(cur);
    let cursor = 0;
    for (const ch of chunks) {
      const r = applyV4aChunk(doc, ch, cursor, strict, path);
      doc = r.doc;
      cursor = r.cursor;
    }
    const out = writeDoc(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) j++;
      const raw = lines.slice(i + 1, j);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const content: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l === '') {
          content.push('');
          continue;
        }
        if (l.startsWith('+')) {
          content.push(l.slice(1));
          continue;
        }
        throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(makeV4aAdd(path, content));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) j++;
      for (let k = i + 1; k < j; k++) {
        if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(makeV4aDelete(path));
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) j++;
      const raw = lines.slice(i + 1, j);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const base = i + 1; // 0-based index of raw[0]
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (; idx < raw.length; idx++) {
        const l = raw[idx]!;
        const lineno = base + idx + 1;
        if (l.startsWith('@@')) {
          if (cur) chunks.push(cur);
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, lines: [], eof: false };
          continue;
        }
        if (l === '*** End of File') {
          if (cur) {
            cur.eof = true;
            chunks.push(cur);
            cur = null;
          }
          continue;
        }
        if (l.startsWith('***')) throw new Exit2(`error: parse ${lineno}`);
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (!cur) {
            // Only the first chunk may start at a body line.
            if (chunks.length > 0) throw new Exit2(`error: parse ${lineno}`);
            cur = { anchor: null, lines: [], eof: false };
          }
          cur.lines.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1), empty: l === '' });
          continue;
        }
        throw new Exit2(`error: parse ${lineno}`);
      }
      if (cur) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(makeV4aUpdate(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Command line, output and exit codes (SPEC.md sections 1, 2 and 10)  */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line for each path whose state changed, in byte order of the paths (UTF-8). A file moved by a move
  // edit that succeeded, when <old> existed before the patch and does not after it, and <new> did not exist
  // before it and does after it, is `R <old> -> <new>` instead of its `D` and `A` lines, sorting by <new>.
  const rowByKey = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowByKey.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rowByKey.delete(oldP);
      rowByKey.delete(newP);
      rowByKey.set(newP, `R ${oldP} -> ${newP}`);
    }
  }
  const rows = [...rowByKey.entries()]
    .sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
    .map(([, line]) => line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
