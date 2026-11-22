// main.ts is mend, the CLI SPEC.md specifies. The kit's starting point covered sections 1 to 4, 9 and 10 of
// SPEC.md; this build adds the three remaining readers — unified diffs (section 6), SEARCH/REPLACE blocks
// (section 7) and V4A patches (section 8) — and the three-tier line matching they share (section 5), plus the
// R rows a successful move prints. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): the hand-over and runner.ts stay as the kit has them.

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
  readonly moves: Array<{ old: string; new: string }> = [];
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

// ---------------------------------------------------------------------------
// Section 3 helpers: a file's text, its line break and its lines.
// ---------------------------------------------------------------------------

class TextFile {
  readonly br: string;
  lines: string[];
  endsBreak: boolean;
  constructor(text: string) {
    const nl = text.indexOf('\n');
    this.br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
    if (text === '') {
      this.lines = [];
      this.endsBreak = false;
      return;
    }
    this.lines = text.split(this.br);
    this.endsBreak = text.endsWith(this.br);
    if (this.endsBreak) this.lines.pop();
  }
  serialize(endsBreak: boolean): string {
    if (this.lines.length === 0) return '';
    return this.lines.join(this.br) + (endsBreak ? this.br : '');
  }
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

/** Trailing spaces and tabs removed (tier 1). */
const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
/** Leading and trailing spaces and tabs removed (tier 2). */
const trimST = (s: string): string => rtrimST(s.replace(/^[ \t]+/, ''));
/** The leading spaces and tabs of a line (for the tier-2 re-indent). */
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(o: string, f: string, tier: number): boolean {
  if (tier === 0) return o === f;
  if (tier === 1) return rtrimST(o) === rtrimST(f);
  return trimST(o) === trimST(f);
}

/** Every position where O's lines match the file's lines at `tier`; occurrences may overlap. */
function occurrencesOf(O: string[], file: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  outer: for (let i = 0; i + O.length <= file.length; i++) {
    for (let j = 0; j < O.length; j++) if (!lineEq(O[j]!, file[i + j]!, tier)) continue outer;
    out.push(i);
  }
  return out;
}

/** The first tier at which O occurs in the file, with its positions; null when O occurs at no tier. */
function findAtTiers(O: string[], file: string[], strict: boolean): { tier: number; positions: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions = occurrencesOf(O, file, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier; -1 when none. */
function findAnchor(file: string[], from: number, anchor: string, strict: boolean): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    for (let i = Math.max(0, from); i < file.length; i++) if (lineEq(anchor, file[i]!, tier)) return i;
  }
  return -1;
}

/** The first occurrence of O at or after `from` at the first tier with one; an end-of-file chunk takes
 * only an occurrence that ends at the file's last line. */
function findFrom(O: string[], file: string[], from: number, strict: boolean, eof: boolean): { at: number; tier: number } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions = occurrencesOf(O, file, tier).filter((p) => p >= from && (!eof || p + O.length === file.length));
    if (positions.length > 0) return { at: positions[0]!, tier };
  }
  return null;
}

/** A line of N that is not a context line, as it is written: at tier 2 it is re-indented, else as it is. */
function reindent(text: string, tier: number, oFirst: string, fileFirst: string): string {
  if (tier !== 2) return text;
  if (text.trim() === '') return text;
  const F = leadST(fileFirst);
  const P = leadST(oFirst);
  if (text.startsWith(P)) return F + text.slice(P.length);
  return text;
}

interface Piece {
  text: string;
  kind: 'ctx' | 'minus' | 'plus' | 'back';
}

/** O is the body's context and minus lines, N its context and plus lines, each in body order; an entry of N
 * that is a context line records its index in O, so it is written as the file's own matched line. */
function buildON(body: Piece[]): { O: string[]; n: Array<{ text: string; oIdx: number }> } {
  const O: string[] = [];
  const n: Array<{ text: string; oIdx: number }> = [];
  for (const p of body) {
    if (p.kind === 'ctx') {
      n.push({ text: p.text, oIdx: O.length });
      O.push(p.text);
    } else if (p.kind === 'minus') {
      O.push(p.text);
    } else if (p.kind === 'plus') {
      n.push({ text: p.text, oIdx: -1 });
    }
  }
  return { O, n };
}

/** Whether a `\` line follows the body's last context or plus line. */
function backAfterLastCtxOrPlus(body: Piece[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'plus') return k + 1 < body.length && body[k + 1]!.kind === 'back';
  }
  return false;
}

/** Replace O at `at` in the file's lines with N: context lines from the file, the rest per the tier. */
function writeN(lines: string[], at: number, O: string[], n: Array<{ text: string; oIdx: number }>, tier: number): string[] {
  const out = lines.slice(0, at);
  const first = lines[at] ?? '';
  for (const e of n) out.push(e.oIdx >= 0 ? lines[at + e.oIdx]! : reindent(e.text, tier, O[0] ?? '', first));
  out.push(...lines.slice(at + O.length));
  return out;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: Piece[];
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld?: string | null;
  pairNew?: string | null;
  renameOld?: string | null;
  renameNew?: string | null;
  createMode: boolean;
  deleteMode: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: text after the four characters, up to the first tab, with
 * surrounding spaces removed; /dev/null means no file; a leading a/ or b/ is removed. */
function pairPath(line: string): string | null {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  raw = raw.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) raw = raw.slice(2);
  return raw;
}

function closeBody(h: Hunk | null): void {
  if (h === null) return;
  while (h.body.length > 0 && h.body[h.body.length - 1]!.kind === 'ctx' && h.body[h.body.length - 1]!.text === '') h.body.pop();
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const parse = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  const gitForm = /^diff --git a\/(.+?) b\/(.+)$/;
  const hunkForm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hunk: Hunk | null = null;
  const newSection = (l: string, i: number): UniSection => {
    const m = gitForm.exec(l);
    if (m === null) parse(i + 1);
    return { gitOld: m![1]!, gitNew: m![2]!, createMode: false, deleteMode: false, hunks: [] };
  };
  const resolve = (s: UniSection): { old: string | null; new: string | null } => ({
    old: s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.gitOld,
    new: s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.gitNew,
  });
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const next = i + 1 < lines.length ? lines[i + 1]! : '';
    if (cur === null) {
      if (l.startsWith('diff --git ')) {
        cur = newSection(l, i);
        hunk = null;
      } else if (l.startsWith('--- ') && next.startsWith('+++ ')) {
        cur = { gitOld: null, gitNew: null, createMode: false, deleteMode: false, hunks: [] };
        cur.pairOld = pairPath(l);
        cur.pairNew = pairPath(next);
        i += 1;
        hunk = null;
      } else if (l.startsWith('@@')) {
        parse(i + 1); // a hunk before any section
      }
      continue;
    }
    if (hunk === null) {
      // the section's header
      if (l.startsWith('diff --git ')) {
        sections.push(cur);
        cur = newSection(l, i);
      } else if (l.startsWith('--- ')) {
        if (!next.startsWith('+++ ')) parse(i + 2); // the line after it
        cur.pairOld = pairPath(l);
        cur.pairNew = pairPath(next);
        i += 1;
      } else if (l.startsWith('@@')) {
        const m = hunkForm.exec(l);
        if (m === null) parse(i + 1);
        hunk = { a: parseInt(m![1]!, 10), body: [] };
        cur.hunks.push(hunk);
      } else if (l.startsWith('new file mode')) {
        cur.createMode = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.deleteMode = true;
      } else if (l.startsWith('rename from ')) {
        if (cur.pairOld === undefined) cur.renameOld = l.slice('rename from '.length);
      } else if (l.startsWith('rename to ')) {
        if (cur.pairNew === undefined) cur.renameNew = l.slice('rename to '.length);
      }
      // index, modes, similarity and any other line are ignored
      continue;
    }
    // inside a hunk's body
    if (l.startsWith('--- ') && next.startsWith('+++ ')) {
      closeBody(hunk);
      sections.push(cur);
      cur = { gitOld: null, gitNew: null, createMode: false, deleteMode: false, hunks: [] };
      cur.pairOld = pairPath(l);
      cur.pairNew = pairPath(next);
      i += 1;
      hunk = null;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      closeBody(hunk);
      sections.push(cur);
      cur = newSection(l, i);
      hunk = null;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = hunkForm.exec(l);
      if (m === null) parse(i + 1);
      closeBody(hunk);
      hunk = { a: parseInt(m![1]!, 10), body: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (l.startsWith(' ')) hunk!.body.push({ text: l.slice(1), kind: 'ctx' });
    else if (l.startsWith('-')) hunk!.body.push({ text: l.slice(1), kind: 'minus' });
    else if (l.startsWith('+')) hunk!.body.push({ text: l.slice(1), kind: 'plus' });
    else if (l.startsWith('\\')) hunk!.body.push({ text: l, kind: 'back' });
    else if (l === '') hunk!.body.push({ text: '', kind: 'ctx' });
    else {
      closeBody(hunk);
      hunk = null; // the body ends; a line that is not part of a section header is ignored
    }
  }
  if (cur !== null) {
    closeBody(hunk);
    sections.push(cur);
  }
  return sections.map((s) => {
    const { old, new: newPath } = resolve(s);
    const create = s.createMode || old === null;
    const del = !create && (s.deleteMode || newPath === null);
    if (create) {
      if (newPath === null) {
        return (tree: Tree) => {
          throw new Fail('unsafe', '/dev/null');
        };
      }
      const target = newPath;
      const plus: string[] = [];
      let ends = true;
      for (const h of s.hunks) for (const p of h.body) if (p.kind === 'plus') plus.push(p.text);
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const b = s.hunks[hi]!.body;
        for (let k = b.length - 1; k >= 0; k--) {
          if (b[k]!.kind === 'plus') {
            ends = !(k + 1 < b.length && b[k + 1]!.kind === 'back');
            break outer;
          }
        }
      }
      return (tree: Tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (ends ? '\n' : ''));
      };
    }
    if (del) {
      const target = old!;
      return (tree: Tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      };
    }
    const applyTo = (tf: TextFile): boolean => {
      let d = 0;
      let ends = tf.endsBreak;
      for (const h of s.hunks) {
        const { O, n } = buildON(h.body);
        let at: number;
        let tier = 0;
        if (O.length > 0) {
          const found = findAtTiers(O, tf.lines, strict);
          if (found === null) throw new Fail('no-match', old!);
          const t = h.a - 1 + d;
          at = found.positions[0]!;
          for (const p of found.positions) if (Math.abs(p - t) < Math.abs(at - t)) at = p;
          tier = found.tier;
        } else {
          at = Math.max(0, Math.min(h.a + d, tf.lines.length));
        }
        const runsToEnd = O.length > 0 ? at + O.length === tf.lines.length : at === tf.lines.length;
        tf.lines = writeN(tf.lines, at, O, n, tier);
        if (runsToEnd) ends = !backAfterLastCtxOrPlus(h.body);
        d += n.length - O.length;
      }
      return ends;
    };
    if (old !== newPath) {
      const from = old!;
      const to = newPath!;
      return (tree: Tree) => {
        if (!safe(from)) throw new Fail('unsafe', from);
        if (!safe(to)) throw new Fail('unsafe', to);
        const text = tree.get(from);
        if (text === null) throw new Fail('missing', from);
        if (tree.get(to) !== null) throw new Fail('exists', to);
        const tf = new TextFile(text);
        const ends = applyTo(tf);
        tree.now.set(to, tf.serialize(ends));
        tree.now.set(from, null);
        tree.moves.push({ old: from, new: to });
      };
    }
    const path = old!;
    return (tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      const text = tree.get(path);
      if (text === null) throw new Fail('missing', path);
      const tf = new TextFile(text);
      const ends = applyTo(tf);
      tree.now.set(path, tf.serialize(ends));
    };
  });
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const parse = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1; // the index of the previous block's >>>>>>> REPLACE line
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t) || t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) parse(searchLine + 1); // the first block with no path
    const p = path;
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) parse(searchLine + 1);
    const oldLines = lines.slice(searchLine + 1, sep!);
    const newLines = lines.slice(sep! + 1, end!);
    prevPath = p;
    prevEnd = end!;
    i = end!;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const tf = new TextFile(text);
      const found = findAtTiers(oldLines, tf.lines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const n = newLines.map((t) => ({ text: t, oIdx: -1 }));
      tf.lines = writeN(tf.lines, found.positions[0]!, oldLines, n, found.tier);
      tree.now.set(p, tf.serialize(tf.endsBreak));
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: Piece[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  fileLines: string[];
  chunks: Chunk[];
  line: number;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const parse = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') parse(first < 0 ? 1 : first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') parse(lines.length + 1);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const s: V4aSection = { kind: 'add', path: l.slice('*** Add File: '.length).trim(), moveTo: null, fileLines: [], chunks: [], line: i };
      i += 1;
      const collected: Array<{ text: string; blank: boolean }> = [];
      while (i < last) {
        const t = lines[i]!;
        if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) break;
        if (t.startsWith('+')) collected.push({ text: t.slice(1), blank: false });
        else if (blank(t)) collected.push({ text: '', blank: true }); // an empty line of the file
        else parse(i + 1);
        i += 1;
      }
      while (collected.length > 0 && collected[collected.length - 1]!.blank) collected.pop(); // blank lines at the end of the section are not part of it
      s.fileLines = collected.map((c) => c.text);
      sections.push(s);
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      sections.push({ kind: 'delete', path: l.slice('*** Delete File: '.length).trim(), moveTo: null, fileLines: [], chunks: [], line: i });
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const s: V4aSection = { kind: 'update', path: l.slice('*** Update File: '.length).trim(), moveTo: null, fileLines: [], chunks: [], line: i };
      i += 1;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        s.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      let chunk: Chunk | null = null;
      while (i < last) {
        const t = lines[i]!;
        if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) break;
        if (t.startsWith('@@')) {
          chunk = { anchor: t.slice(2).trim(), eof: false, body: [] };
          s.chunks.push(chunk);
          i += 1;
          continue;
        }
        if (t.trim() === '*** End of File') {
          if (chunk === null) parse(i + 1);
          chunk!.eof = true;
          chunk = null;
          i += 1;
          continue;
        }
        if (blank(t)) {
          // a blank line is an empty context line of the open chunk; with none open it starts the first
          // chunk, and after an *** End of File it is skipped
          if (chunk === null) {
            if (s.chunks.length === 0) {
              chunk = { anchor: null, eof: false, body: [] };
              s.chunks.push(chunk);
            } else {
              i += 1;
              continue;
            }
          }
          chunk!.body.push({ text: t.startsWith(' ') ? t.slice(1) : '', kind: 'ctx' });
          i += 1;
          continue;
        }
        if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (chunk === null) {
            if (s.chunks.length === 0) {
              chunk = { anchor: null, eof: false, body: [] };
              s.chunks.push(chunk);
            } else parse(i + 1); // a body line only starts the first chunk
          }
          chunk!.body.push({ text: t.slice(1), kind: t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'minus' : 'plus' });
          i += 1;
          continue;
        }
        parse(i + 1); // any other line
      }
      if (s.chunks.length > 0) {
        const b = s.chunks[s.chunks.length - 1]!.body;
        while (b.length > 0 && b[b.length - 1]!.kind === 'ctx' && blank(b[b.length - 1]!.text)) b.pop(); // blank lines at the end of the section are not part of it
      }
      if (s.chunks.length === 0 && s.moveTo === null) parse(s.line + 1);
      sections.push(s);
      continue;
    }
    parse(i + 1); // any other line
  }
  return sections.map((s) => {
    if (s.kind === 'add') {
      const p = s.path;
      const content = s.fileLines;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      };
    }
    if (s.kind === 'delete') {
      const p = s.path;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const p = s.path;
    const to = s.moveTo;
    const chunks = s.chunks;
    const applyChunks = (tf: TextFile): void => {
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null && ch.anchor !== '') {
          const a = findAnchor(tf.lines, cursor, ch.anchor, strict);
          if (a < 0) throw new Fail('no-match', p);
          cursor = a + 1;
        }
        const { O, n } = buildON(ch.body);
        let at: number;
        let tier = 0;
        if (O.length > 0) {
          const found = findFrom(O, tf.lines, cursor, strict, ch.eof);
          if (found === null) throw new Fail('no-match', p);
          at = found.at;
          tier = found.tier;
        } else {
          at = ch.eof ? tf.lines.length : Math.max(0, Math.min(cursor, tf.lines.length));
        }
        tf.lines = writeN(tf.lines, at, O, n, tier);
        cursor = at + n.length;
      }
    };
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (to !== null && !safe(to)) throw new Fail('unsafe', to);
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
      const tf = new TextFile(text);
      applyChunks(tf);
      if (to !== null) {
        tree.now.set(to, tf.serialize(tf.endsBreak));
        tree.now.set(p, null);
        tree.moves.push({ old: p, new: to });
      } else {
        tree.now.set(p, tf.serialize(tf.endsBreak));
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits (from the kit's starter).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the output, order and atomicity.
// ---------------------------------------------------------------------------

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveByNew = new Map<string, string>();
  const moveOlds = new Set<string>();
  for (const mv of tree.moves) {
    if (tree.original(mv.old) !== null && tree.now.get(mv.old) === null && tree.original(mv.new) === null && tree.now.get(mv.new) !== null) {
      moveByNew.set(mv.new, mv.old);
      moveOlds.add(mv.old);
    }
  }
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveOlds.has(p)) {
      if (!check) rmSync(p, { force: true });
      continue; // the R row at the new path replaces this D
    }
    if (moveByNew.has(p)) {
      rows.push(`R ${moveByNew.get(p)} -> ${p}`);
      if (!check) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now!);
      }
      continue;
    }
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
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
