// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Same answers as makefun-site's build(), byte for byte, written as one
// dependency-free ES module. The speed comes from avoiding the reference's
// repeated work, not from different answers:
//   - Markdown is rendered in a single pass straight into an output array
//     (no lex-then-render token objects, no per-character escape calls).
//   - Templates render into a shared output array (no intermediate strings
//     per include), with per-run memoised slugs, dates and link targets.
//   - Front matter is scanned line by line without splitting the file.
//   - Word counting, slug building and HTML escaping are hand-rolled scans
//     with fast paths for the common (plain ASCII, no specials) case.
//
// Every rule below mirrors the reference implementation's behaviour
// (README.md of makefun-site 1.0.0); where the two could differ, the
// reference's answer is the answer, so the checks here are written to
// match its code exactly, including its edge cases.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INCLUDE_DEPTH = 8;

const ESCMAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Fast when nothing needs escaping. */
function esc(s) {
  let out = '';
  let start = 0;
  ESC_RE.lastIndex = 0;
  let m;
  while ((m = ESC_RE.exec(s)) !== null) {
    out += s.slice(start, m.index);
    out += ESCMAP[m[0]];
    start = m.index + 1;
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

/** The slug of `text`, exactly as the reference builds it (NFKD, combining
 *  marks dropped, A-Z lowered, each run of other characters one '-', cut to
 *  64 with a trailing '-' dropped, 'untitled' when nothing is left).
 *  ASCII text skips the normalisation step, which is the identity there. */
function slugRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e < out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

function slugify(ctx, text) {
  let r = ctx.slugCache.get(text);
  if (r === undefined) {
    r = slugRaw(text);
    ctx.slugCache.set(text, r);
  }
  return r;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(ctx, date) {
  let r = ctx.dateCache.get(date);
  if (r === undefined) {
    r = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    ctx.dateCache.set(date, r);
  }
  return r;
}

/** Whether char code `c` is whitespace in JavaScript's \s sense. */
function isSpace(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
      c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, '/'-separated) from the directory `dir` of a source,
 *  or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
    }
    let y = 0;
    let mo = 0;
    let d = 0;
    if (ok) {
      y = +raw.slice(0, 4);
      mo = +raw.slice(5, 7);
      d = +raw.slice(8, 10);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
    }
    if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',');
    for (let i = 0; i < tags.length; i++) tags[i] = tags[i].trim();
    for (const t of tags) {
      if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    let ok = raw.length > 0;
    for (let i = 0; i < raw.length && ok; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
    }
    return ok ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    let ok = raw.length > 0 && raw.length <= 64;
    let prevDash = true;
    for (let i = 0; i < raw.length && ok; i++) {
      const c = raw.charCodeAt(i);
      if (c === 45) {
        if (prevDash) ok = false;
        prevDash = true;
      } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
      else ok = false;
    }
    if (prevDash) ok = false;
    return ok ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  let eol = text.indexOf('\n');
  const firstEnd = eol === -1 ? text.length : eol;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  // Find the closing '---' line first: an unclosed front matter is refused
  // whatever its lines hold.
  let p = eol === -1 ? text.length : eol + 1;
  let closeLine = -1;
  let closeEol = -1;
  let idx = 1;
  while (p < text.length) {
    eol = text.indexOf('\n', p);
    const end = eol === -1 ? text.length : eol;
    if (end - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) {
      closeLine = idx;
      closeEol = eol;
      break;
    }
    if (eol === -1) break;
    p = eol + 1;
    idx++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  p = text.indexOf('\n') + 1;
  for (let i = 1; i < closeLine; i++) {
    eol = text.indexOf('\n', p);
    const end = eol === -1 ? text.length : eol;
    const line = text.slice(p, end);
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${i + 1} is not "key: value"` };
      let r = raw.length;
      while (r > 0) {
        const c = raw.charCodeAt(r - 1);
        if (c === 32 || c === 9) r--;
        else break;
      }
      if (r < raw.length) raw = raw.slice(0, r);
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (eol === -1) break;
    p = eol + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEol === -1 ? '' : text.slice(closeEol + 1) };
}

// ---------------------------------------------------------------- Markdown

const isBlank = (line) => {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
};

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  for (; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let j = n;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === j) return null;
  return { depth: n, text: line.slice(j, end) };
}

function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** A bullet item's text (after '- ' or '* '), or null. */
function bulletMatch(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null. */
function orderedMatch(line) {
  let j = 0;
  while (j < line.length && j < 9) {
    const c = line.charCodeAt(j);
    if (c >= 48 && c <= 57) j++;
    else break;
  }
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: line.slice(0, j), rest: line.slice(j + 2) };
}

/** A list's first line, or null: { ordered, start, rest }. */
function listStart(line) {
  const b = bulletMatch(line);
  if (b !== null) return { ordered: false, start: 1, rest: b };
  const o = orderedMatch(line);
  if (o !== null) return { ordered: true, start: Number(o.num), rest: o.rest };
  return null;
}

/** A line of two or more spaces then a non-space: a list item's continuation. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !isSpace(line.charCodeAt(j));
}

/** A link target's href, from the source's directory (ctx.dir). Resolved
 *  targets are memoised per directory; a broken target is memoised as null
 *  but still reported for every source that links to it, since the report
 *  names the source. */
function linkHref(ctx, target) {
  const key = ctx.dir + '\0' + target;
  let r = ctx.linkCache.get(key);
  if (r !== undefined) {
    if (r === null) ctx.broken.add(`broken-link ${ctx.srcPath} -> ${target}`);
    return r === null ? target : r;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) {
    r = target;
  } else {
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(ctx.dir, rel);
    const url = path === null ? undefined : ctx.bySource.get(path);
    if (url !== undefined) r = url + frag;
    else if (path !== null && ctx.staticPaths.has(path)) r = `${ctx.base}/${path}${frag}`;
    else {
      ctx.broken.add(`broken-link ${ctx.srcPath} -> ${target}`);
      r = null;
    }
  }
  ctx.linkCache.set(key, r);
  return r === null ? target : r;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** `s` rendered inline, appended to `out` (plain runs escaped in bulk). */
function inline(s, ctx, out) {
  let i = 0;
  let run = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      if (run < i) out.push(esc(s.slice(run, i)));
      out.push(esc(s[i + 1]));
      i += 2;
      run = i;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (run < i) out.push(esc(s.slice(run, i)));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (run < i) out.push(esc(s.slice(run, i)));
          out.push('<strong>');
          inline(s.slice(i + 2, j), ctx, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (run < i) out.push(esc(s.slice(run, i)));
        out.push('<em>');
        inline(s.slice(i + 1, j), ctx, out);
        out.push('</em>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (run < i) out.push(esc(s.slice(run, i)));
        out.push('<a href="', esc(linkHref(ctx, target)), '">');
        inline(s.slice(i + 1, k), ctx, out);
        out.push('</a>');
        i = m + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (run < s.length) out.push(esc(s.slice(run)));
}

/**
 * `src` rendered: blocks appended to `out`, and { toc, excerpt } returned.
 * The HTML is the blocks joined, each followed by '\n'.
 */
function renderMarkdown(src, ctx, out) {
  const lines = src.split('\n');
  const toc = [];
  let excerpt = '';
  let excerptSet = false;
  const ids = new Set();
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      out.push('<pre><code');
      if (lang !== '') out.push(' class="language-', esc(lang), '"');
      out.push('>');
      while (i < n && !isFenceClose(lines[i])) {
        out.push(esc(lines[i]), '\n');
        i++;
      }
      if (i < n) i++;
      out.push('</code></pre>\n');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(ctx, hd.text), ids);
      const tmp = [];
      inline(hd.text, ctx, tmp);
      const html = tmp.join('');
      out.push('<h', String(hd.depth), ' id="', id, '">', html, '</h', String(hd.depth), '>\n');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        parts.push(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (const l of parts) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inline(kept.join('\n'), ctx, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const ls = listStart(line);
    if (ls !== null) {
      const ordered = ls.ordered;
      const items = [[trimLine(ls.rest)]];
      i++;
      while (i < n) {
        const m = ordered ? orderedMatch(lines[i]) : bulletMatch(lines[i]);
        if (m !== null) {
          items.push([trimLine(ordered ? m.rest : m)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      out.push(ordered && ls.start !== 1 ? `<ol start="${ls.start}">` : (ordered ? '<ol>' : '<ul>'), '\n');
      for (const item of items) {
        out.push('<li>');
        inline(item.join('\n'), ctx, out);
        out.push('</li>\n');
      }
      out.push(ordered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    out.push('<p>');
    const mark = out.length;
    inline(body.join('\n'), ctx, out);
    if (!excerptSet) {
      excerptSet = true;
      excerpt = out.slice(mark).join('');
    }
    out.push('</p>\n');
  }
  return { toc, excerpt };
}

// ---------------------------------------------------------------- Templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function spacesOnly(src, a, b) {
  for (let j = a; j < b; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = spacesOnly(src, lineStart, open) && spacesOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }), appended to `out`. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
function linkOf(ctx, s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(ctx, s.data.date) };
}

/** A post's card, as lists show it. */
function cardOf(ctx, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(ctx, s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(ctx, s) {
  const c = cardOf(ctx, s);
  c.slug = s.slug;
  c.content = s.html;
  c.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
  c.newer = linkOf(ctx, s.newer ?? null);
  c.older = linkOf(ctx, s.older ?? null);
  c.is_post = s.post;
  return c;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const ctx = {
    slugCache: new Map(),
    dateCache: new Map(),
    linkCache: new Map(),
    broken: new Set(),
    dir: '',
    srcPath: '',
    bySource: new Map(),
    staticPaths: new Set(),
    base: '',
    templates: new Map(),
  };
  let base = input.site.base_url;
  let be = base.length;
  while (be > 0 && base.charCodeAt(be - 1) === 47) be--;
  ctx.base = be === base.length ? base : base.slice(0, be);
  base = ctx.base;
  const report = [];

  // Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out.
  const names = Object.keys(input.templates).sort();
  for (const name of names) {
    try {
      ctx.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // Sources, in code-unit order of path; line ends made '\n'.
  const files = [...input.files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the drop rules, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!ctx.templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each slug unique in its directory, in source order.
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(ctx, s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    ctx.bySource.set(s.path, s.url);
  }

  // Markdown, its links resolved to the pages and static files they name.
  for (const f of statics) ctx.staticPaths.add(f.path);
  for (const s of kept) {
    ctx.dir = dirOf(s.path);
    ctx.srcPath = s.path;
    const out = [];
    const md = renderMarkdown(s.body, ctx, out);
    s.html = out.join('');
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // Collections: the posts, newest date first, then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => {
    if (x.data.date < y.data.date) return 1;
    if (x.data.date > y.data.date) return -1;
    return x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0;
  });
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met in the posts' order.
  for (const s of kept) {
    const names = s.data.tags ?? [];
    const seen = new Set();
    const list = [];
    for (const name of names) {
      const slug = slugify(ctx, name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      list.push({ name, slug });
    }
    s.tagList = list;
  }
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const t of p.tagList) {
      let tag = bySlug.get(t.slug);
      if (tag === undefined) {
        tag = { name: t.name, slug: t.slug, url: `${base}/tags/${t.slug}/`, posts: [] };
        bySlug.set(t.slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = s.tagList.map((t) => bySlug.get(t.slug) ?? { name: t.name, slug: t.slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));

  // Layouts: every page, the index pages and the tag pages.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(ctx, p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // One shared root scope for site/tags/recent; each render adds its own
  // vars as a child scope. (Render vars are page/posts/pager/tag, which
  // never collide with the root names, and lookups walk the chain exactly
  // as they would one merged object.)
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const output = {};
  const render = (name, vars) => {
    const nodes = ctx.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: rootScope }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(ctx, s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted,
  // then the counts.
  const lines = [...report, ...ctx.broken].sort();
  let nPages = 0;
  for (const s of kept) if (!s.post) nPages++;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
