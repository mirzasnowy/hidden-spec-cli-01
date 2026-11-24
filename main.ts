// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** A file as lines: its line break, its lines, and whether it ends with one (SPEC.md section 3). */
interface FileDoc {
  br: string;
  lines: string[];
  final: boolean;
}
function splitDoc(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** Moves a successful move edit made, for the R lines of section 2. Reset at the start of run(). */
const moves: Array<[string, string]> = [];

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
/** A line at a tier (SPEC.md section 5): 0 exact, 1 trailing spaces/tabs dropped, 2 both ends dropped. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trailWs(s);
  return trailWs(s.replace(/^[ \t]+/, ''));
}
/** Positions where O occurs in lines at a tier. */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at least once. */
function firstTier(lines: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, O, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line (written as the file's own line) or a new line (from the patch). */
interface NItem {
  text: string;
  ctx: boolean;
  oIdx: number;
}
/** The lines N writes for a match at matchPos (section 5): context lines are the file's own, other lines are
 * re-indented at tier 2. */
function buildReplacement(fileLines: string[], matchPos: number, O: string[], items: NItem[], tier: number): string[] {
  const out: string[] = [];
  if (tier === 2) {
    const F = leadWs(fileLines[matchPos] ?? '');
    const P = leadWs(O[0] ?? '');
    for (const it of items) {
      if (it.ctx) {
        out.push(fileLines[matchPos + it.oIdx]!);
        continue;
      }
      const t = it.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
      else out.push(t);
    }
  } else {
    for (const it of items) {
      if (it.ctx) out.push(fileLines[matchPos + it.oIdx]!);
      else out.push(it.text);
    }
  }
  return out;
}
/** Replace O at matchPos with the lines N writes; newFinal is the result's final-break flag. */
function applyHunk(doc: FileDoc, O: string[], items: NItem[], matchPos: number, tier: number, newFinal: boolean): FileDoc {
  const rep = buildReplacement(doc.lines, matchPos, O, items, tier);
  return { br: doc.br, lines: [...doc.lines.slice(0, matchPos), ...rep, ...doc.lines.slice(matchPos + O.length)], final: newFinal };
}
/** Insert N lines at pos; newFinal is the result's final-break flag. */
function insertAt(doc: FileDoc, pos: number, N: string[], newFinal: boolean): FileDoc {
  return { br: doc.br, lines: [...doc.lines.slice(0, pos), ...N, ...doc.lines.slice(pos)], final: newFinal };
}
/** Whether a `\` line follows the last context or `+` line of a hunk body (section 6). */
function backslashAfterLastCP(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]![0];
    if (c === ' ' || c === '+') last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.startsWith('\\');
}
/** The lines of a hunk body as items: context and `-` lines are O, context and `+` lines are N. */
function hunkItems(body: string[]): { O: string[]; items: NItem[] } {
  const O: string[] = [];
  const items: NItem[] = [];
  for (const l of body) {
    const c = l[0];
    if (c === ' ' || l === '') {
      const oIdx = O.length;
      O.push(l === '' ? '' : l.slice(1));
      items.push({ text: l === '' ? '' : l.slice(1), ctx: true, oIdx });
    } else if (c === '-') {
      O.push(l.slice(1));
    } else if (c === '+') {
      items.push({ text: l.slice(1), ctx: false, oIdx: -1 });
    }
  }
  return { O, items };
}
/** The `+` lines of a hunk body, in order. */
function plusLines(body: string[]): string[] {
  const out: string[] = [];
  for (const l of body) if (l[0] === '+') out.push(l.slice(1));
  return out;
}
/** A path as a patch wrote it, after the leading a/ or b/ a unified diff adds (section 6). */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
/** A path from a `--- ` or `+++ ` line: after the four characters, up to the first tab, spaces removed. */
function headerPath(l: string): string {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

/** One unified hunk: the old start line (1-based) and its body lines. */
interface UHunk {
  A: number;
  body: string[];
}
/** One unified section: its paths (null is /dev/null) and its hunks. */
interface USection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}
/** Whether a `\` line follows the last `+` line of a creation's hunks (section 6). */
function creationFinal(hunks: UHunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const b = hunks[hi]!.body;
    for (let j = b.length - 1; j >= 0; j--) {
      if (b[j]![0] === '+') return !(b[j + 1] !== undefined && b[j + 1]!.startsWith('\\'));
    }
  }
  return true;
}
/** One unified section as an edit (section 6). */
function sectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) plus.push(...plusLines(h.body));
      const final = creationFinal(sec.hunks);
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (sec.isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const op = oldP!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    const isMove = newP !== null && newP !== op;
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let doc = splitDoc(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { O, items } = hunkItems(h.body);
      if (O.length === 0) {
        const N = items.map((it) => it.text);
        let pos = h.A + d;
        if (pos < 0) pos = 0;
        if (pos > doc.lines.length) pos = doc.lines.length;
        const newFinal = pos === doc.lines.length ? !backslashAfterLastCP(h.body) : doc.final;
        doc = insertAt(doc, pos, N, newFinal);
        d += N.length;
      } else {
        const found = firstTier(doc.lines, O, strict);
        if (found === null) throw new Fail('no-match', op);
        const target = h.A - 1 + d;
        let best = found.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.pos) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const atEnd = best + O.length === doc.lines.length;
        const newFinal = atEnd ? !backslashAfterLastCP(h.body) : doc.final;
        doc = applyHunk(doc, O, items, best, found.tier, newFinal);
        d += items.length - O.length;
      }
    }
    const out = joinDoc(doc);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(newP!, out);
      moves.push([op, newP!]);
    } else {
      tree.now.set(op, out);
    }
  };
}
/** The unified diffs of a patch as edits (section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;
  let cur: {
    diffOld: string | null;
    diffNew: string | null;
    dashOld: string | null | undefined;
    dashNew: string | null | undefined;
    renOld: string | null | undefined;
    renNew: string | null | undefined;
    newFile: boolean;
    delFile: boolean;
    hunks: UHunk[];
  } | null = null;
  let state: 'out' | 'header' | 'body' | 'posthunk' = 'out';
  let body: string[] = [];
  let curA = 0;
  const flushHunk = (): void => {
    if (cur === null) return;
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    cur.hunks.push({ A: curA, body });
    body = [];
  };
  const flushSection = (): void => {
    if (cur === null) return;
    const oldPath = cur.dashOld !== undefined ? cur.dashOld : cur.renOld !== undefined ? cur.renOld : cur.diffOld;
    const newPath = cur.dashNew !== undefined ? cur.dashNew : cur.renNew !== undefined ? cur.renNew : cur.diffNew;
    sections.push({
      oldPath: oldPath ?? null,
      newPath: newPath ?? null,
      isCreate: cur.newFile || oldPath === null,
      isDelete: cur.delFile || newPath === null,
      hunks: cur.hunks,
    });
    cur = null;
  };
  const startDiffSection = (x: string, y: string): void => {
    cur = { diffOld: x, diffNew: y, dashOld: undefined, dashNew: undefined, renOld: undefined, renNew: undefined, newFile: false, delFile: false, hunks: [] };
    state = 'header';
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (state === 'body') {
      if (l.startsWith('diff --git ')) {
        flushHunk();
        flushSection();
        const rest = l.slice('diff --git '.length);
        const parts = rest.split(' ');
        if (parts.length !== 2 || !parts[0]!.startsWith('a/') || !parts[1]!.startsWith('b/') || parts[0]!.length <= 2 || parts[1]!.length <= 2) throw new Exit2(`error: parse ${i + 1}`);
        startDiffSection(parts[0]!.slice(2), parts[1]!.slice(2));
        i++;
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        flushHunk();
        flushSection();
        cur = { diffOld: null, diffNew: null, dashOld: null, dashNew: null, renOld: undefined, renNew: undefined, newFile: false, delFile: false, hunks: [] };
        const o = headerPath(l);
        const nw = headerPath(lines[i + 1]!);
        cur.dashOld = o === '/dev/null' ? null : stripAB(o);
        cur.dashNew = nw === '/dev/null' ? null : stripAB(nw);
        state = 'header';
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) {
        flushHunk();
        const m = hunkRe.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        curA = parseInt(m[1]!, 10);
        body = [];
        i++;
        continue;
      }
      const c = l[0];
      if (c === ' ' || c === '-' || c === '+' || c === '\\' || l === '') {
        body.push(l);
        i++;
        continue;
      }
      flushHunk();
      state = 'posthunk';
      continue;
    }
    if (state === 'out') {
      if (l.startsWith('diff --git ')) {
        const rest = l.slice('diff --git '.length);
        const parts = rest.split(' ');
        if (parts.length !== 2 || !parts[0]!.startsWith('a/') || !parts[1]!.startsWith('b/') || parts[0]!.length <= 2 || parts[1]!.length <= 2) throw new Exit2(`error: parse ${i + 1}`);
        startDiffSection(parts[0]!.slice(2), parts[1]!.slice(2));
        i++;
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = { diffOld: null, diffNew: null, dashOld: null, dashNew: null, renOld: undefined, renNew: undefined, newFile: false, delFile: false, hunks: [] };
        const o = headerPath(l);
        const nw = headerPath(lines[i + 1]!);
        cur.dashOld = o === '/dev/null' ? null : stripAB(o);
        cur.dashNew = nw === '/dev/null' ? null : stripAB(nw);
        state = 'header';
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) {
        if (hunkRe.exec(l) !== null) throw new Exit2(`error: parse ${i + 1}`);
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (l.startsWith('diff --git ')) {
        flushSection();
        const rest = l.slice('diff --git '.length);
        const parts = rest.split(' ');
        if (parts.length !== 2 || !parts[0]!.startsWith('a/') || !parts[1]!.startsWith('b/') || parts[0]!.length <= 2 || parts[1]!.length <= 2) throw new Exit2(`error: parse ${i + 1}`);
        startDiffSection(parts[0]!.slice(2), parts[1]!.slice(2));
        i++;
        continue;
      }
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          const o = headerPath(l);
          const nw = headerPath(lines[i + 1]!);
          cur.dashOld = o === '/dev/null' ? null : stripAB(o);
          cur.dashNew = nw === '/dev/null' ? null : stripAB(nw);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        cur.renOld = stripAB(l.slice('rename from '.length).trim());
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renNew = stripAB(l.slice('rename to '.length).trim());
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.delFile = true;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        const m = hunkRe.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        curA = parseInt(m[1]!, 10);
        body = [];
        state = 'body';
        i++;
        continue;
      }
      i++;
      continue;
    }
    // posthunk
    if (l.startsWith('diff --git ')) {
      flushSection();
      const rest = l.slice('diff --git '.length);
      const parts = rest.split(' ');
      if (parts.length !== 2 || !parts[0]!.startsWith('a/') || !parts[1]!.startsWith('b/') || parts[0]!.length <= 2 || parts[1]!.length <= 2) throw new Exit2(`error: parse ${i + 1}`);
      startDiffSection(parts[0]!.slice(2), parts[1]!.slice(2));
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      flushSection();
      cur = { diffOld: null, diffNew: null, dashOld: null, dashNew: null, renOld: undefined, renNew: undefined, newFile: false, delFile: false, hunks: [] };
      const o = headerPath(l);
      const nw = headerPath(lines[i + 1]!);
      cur.dashOld = o === '/dev/null' ? null : stripAB(o);
      cur.dashNew = nw === '/dev/null' ? null : stripAB(nw);
      state = 'header';
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      curA = parseInt(m[1]!, 10);
      body = [];
      state = 'body';
      i++;
      continue;
    }
    i++;
  }
  if (state === 'body') flushHunk();
  flushSection();
  return sections.map((s) => sectionEdit(s, strict));
}

/** One SEARCH/REPLACE block as an edit (section 7). */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = splitDoc(before);
    const found = firstTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length !== 1) throw new Fail('ambiguous', path);
    const items: NItem[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const out = applyHunk(doc, oldLines, items, found.pos[0]!, found.tier, doc.final);
    tree.now.set(path, joinDoc(out));
  };
}
/** The SEARCH/REPLACE blocks of a patch as edits (section 7). */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j >= searchFrom; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
  }
  return edits;
}

/** One V4A chunk: its anchor (null is none), its body lines, and whether it ends at the file's end. */
interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}
/** One V4A Add File section as an edit (section 8). */
function v4aAddEdit(path: string, flines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, flines.length === 0 ? '' : flines.join('\n') + '\n');
  };
}
/** One V4A Delete File section as an edit (section 8). */
function v4aDelEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}
/** One V4A Update File section as an edit (section 8). */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = splitDoc(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let anchorAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const pos = occurrences(doc.lines, [ch.anchor], t).filter((p) => p >= cursor);
          if (pos.length > 0) {
            anchorAt = pos[0]!;
            break;
          }
        }
        if (anchorAt < 0) throw new Fail('no-match', path);
        cursor = anchorAt + 1;
      }
      const { O, items } = hunkItems(ch.body);
      if (O.length === 0) {
        const N = items.map((it) => it.text);
        const pos = ch.eof ? doc.lines.length : cursor;
        doc = insertAt(doc, pos, N, doc.final);
        cursor = pos + N.length;
      } else {
        const tiers = strict ? [0] : [0, 1, 2];
        let found: { tier: number; pos: number[] } | null = null;
        for (const t of tiers) {
          const pos = occurrences(doc.lines, O, t).filter((p) => p >= cursor);
          if (pos.length > 0) {
            found = { tier: t, pos };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        let candidates = found.pos;
        if (ch.eof) candidates = candidates.filter((p) => p + O.length === doc.lines.length);
        if (candidates.length === 0) throw new Fail('no-match', path);
        const at = candidates[0]!;
        doc = applyHunk(doc, O, items, at, found.tier, doc.final);
        cursor = at + items.length;
      }
    }
    const out = joinDoc(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}
/** The V4A sections of a patch as edits (section 8). */
function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const l = lines[i]!;
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secLine = i + 1;
    i++;
    if (kind === 'add') {
      const raw: string[] = [];
      while (i < last) {
        const t = lines[i]!;
        if (isSectionStart(t)) break;
        if (t === '' || t.startsWith('+')) {
          raw.push(t);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const flines = raw.map((t) => (t === '' ? '' : t.slice(1)));
      edits.push(v4aAddEdit(path, flines));
    } else if (kind === 'del') {
      edits.push(v4aDelEdit(path));
    } else {
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let firstChunk = true;
      while (i < last) {
        const t = lines[i]!;
        if (isSectionStart(t)) break;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          i++;
          const body: string[] = [];
          let eof = false;
          while (i < last) {
            const b = lines[i]!;
            if (b === '*** End of File') {
              eof = true;
              i++;
              break;
            }
            if (isSectionStart(b) || b.startsWith('@@')) break;
            const c = b[0];
            if (c === ' ' || c === '-' || c === '+' || b === '') {
              body.push(b);
              i++;
              continue;
            }
            throw new Exit2(`error: parse ${i + 1}`);
          }
          chunks.push({ anchor: anchor === '' ? null : anchor, body, eof });
          firstChunk = false;
          continue;
        }
        if (t === '*** End of File') throw new Exit2(`error: parse ${i + 1}`);
        if (blank(t) && !firstChunk && chunks.length > 0) {
          i++;
          continue;
        }
        if (firstChunk) {
          const c = t[0];
          if (c === ' ' || c === '-' || c === '+' || t === '') {
            const body: string[] = [];
            let eof = false;
            while (i < last) {
              const b = lines[i]!;
              if (b === '*** End of File') {
                eof = true;
                i++;
                break;
              }
              if (isSectionStart(b) || b.startsWith('@@')) break;
              const cc = b[0];
              if (cc === ' ' || cc === '-' || cc === '+' || b === '') {
                body.push(b);
                i++;
                continue;
              }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            chunks.push({ anchor: null, body, eof });
            firstChunk = false;
            continue;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (chunks.length > 0) {
        const lastCh = chunks[chunks.length - 1]!;
        while (lastCh.body.length > 0 && lastCh.body[lastCh.body.length - 1]!.trim() === '') lastCh.body.pop();
        if (lastCh.body.length === 0 && lastCh.anchor === null && !lastCh.eof) chunks.pop();
        else break;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

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
  moves.length = 0;
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const suppressed = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const [old, nw] of moves) {
    const wasOld = tree.original(old);
    const nowOld = tree.now.get(old);
    const wasNew = tree.original(nw);
    const nowNew = tree.now.get(nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: nw, text: `R ${old} -> ${nw}` });
      suppressed.add(old);
      suppressed.add(nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
