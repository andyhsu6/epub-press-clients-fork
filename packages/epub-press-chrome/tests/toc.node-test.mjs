// EPUB output verification for the table-of-contents pipeline.
//
// Why this file exists: node-strip-test.mjs only imports generateTxt and
// tests/generater-test.js only asserts blob type + size>0, so nothing in the
// repo ever looked inside a generated .epub. XML well-formedness here is
// checked with python's expat on purpose — linkedom silently accepts both an
// unbound namespace prefix and a bare '&', and xmllint accepts the prefix,
// while real Chromium (i.e. every reader that parses these files) rejects both.
//
//   node --test tests/toc.node-test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser, NodeFilter, parseHTML } from 'linkedom';
import JSZip from 'jszip';

// 副本须同步修 — 规范副本 (named-class 形): this shim block is byte-equal in exactly the three files
// that carry this note (tests/toc.node-test.mjs, tests/toc-volume-carryover.node-test.mjs,
// tests/toc-volume-e2e.node-test.mjs), which are each other's sync targets. Every other copy —
// tests/toc-matrix.node-test.mjs, tests/pagination-merge.node-test.mjs,
// tests/pagination-stop-reason.node-test.mjs, node-strip-test.mjs, tools/toc-level-lock.mjs — is a
// 变体形 (file-specific: its own comment lines, an inline anonymous XMLSerializer, and/or a
// different globalThis.fetch line — each variant's own note names its case), so align it
// with this block first and only then diff it; each of those five carries a note pointing back here.
class BrowserLikeDOMParser extends DOMParser {
  parseFromString(html, type) {
    if (type === 'text/html' && typeof html === 'string' && !/^\s*(<!DOCTYPE|<html)/i.test(html)) {
      return super.parseFromString(`<html><body>${html}</body></html>`, type);
    }
    return super.parseFromString(html, type);
  }
}
class XMLSerializer {
  serializeToString(node) { return node.toString(); }
}
globalThis.DOMParser = BrowserLikeDOMParser;
globalThis.NodeFilter = NodeFilter;
globalThis.XMLSerializer = XMLSerializer;
// Pagination probing is expected to fail; the code catches and stops.
globalThis.fetch = async () => { throw new Error('no network in tests'); };

const { generateEpub } = await import('../scripts/generater.js');
const { detectChapterTitles, cleanChapterTitle, parseOrdinal } = await import('../scripts/toc.js');

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'toc');
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');

const URLS = {
  'multi-heading.html': 'https://blog.example.com/post/feng-yu-chen',
  'ibbs-forum-13chapters.html': 'https://www.ibbs.pro/thread/68805aecf30dda264d164fe9',
  'uaa-reader-h1.html': 'https://www.uaa.com/novel/chapter?id=234639',
  'long-title-lines.html': 'https://serial.example.com/book/7',
  'standalone-p-titles.html': 'https://serial.example.com/book/biancheng',
};

const cache = new Map();
const detectCache = new Map();
async function detectOn(name) {
  if (detectCache.has(name)) return detectCache.get(name);
  const { extractFromHtml } = await import('@extractus/article-extractor');
  const article = await extractFromHtml(fixture(name), URLS[name]);
  const result = await detectChapterTitles(article.content || '');
  detectCache.set(name, result);
  return result;
}
async function build(fixtureNames, title = 'Test Book') {
  const key = fixtureNames.join('|') + '#' + title;
  if (cache.has(key)) return cache.get(key);
  const blob = await generateEpub({
    title,
    includeImages: false,
    sections: fixtureNames.map((n) => ({ url: URLS[n], html: fixture(n) })),
  });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const files = {};
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith('.ncx') && !name.endsWith('.opf') && !name.endsWith('.xhtml')) continue;
    files[name] = await zip.file(name).async('string');
  }
  cache.set(key, files);
  return files;
}

function assertWellFormed(name, xml) {
  // timeout: 15000, the same ceiling navRows below uses — far above the ~50ms these probes take and
  // far below a test run worth waiting for. A wedged interpreter comes back as r.error
  // (code ETIMEDOUT) with status null.
  const r = spawnSync('python3',
    ['-c', 'import sys,xml.etree.ElementTree as E;E.fromstring(sys.stdin.buffer.read())'],
    { input: Buffer.from(xml, 'utf8'), timeout: 15000 });
  // A missing (or timed-out) interpreter comes back as r.error with status null, so it has to be
  // handled before anything touches r.stderr — otherwise the failure is an opaque TypeError.
  if (r.error) assert.fail(`${name}: python3 probe unavailable (${r.error.code})`);
  if (r.status !== 0) {
    const err = (r.stderr.toString() || '').trim().split('\n').pop() || 'parse failed';
    assert.fail(`${name} is not well-formed XML -> ${err}\n--- head ---\n${xml.slice(0, 260)}`);
  }
}

const textOf = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);

describe('generated EPUB parts are well-formed XML', () => {
  test('every opf / ncx / xhtml parses strictly, with no parsererror payload', async () => {
    const files = await build(['multi-heading.html']);
    assert.ok(Object.keys(files).length > 0, 'expected some xml parts');
    for (const [name, xml] of Object.entries(files)) {
      assertWellFormed(name, xml);
      assert.ok(!/parsererror/.test(xml), `${name} contains a parsererror payload`);
    }
  });

  test('a book title containing & survives every template interpolation', async () => {
    const files = await build(['multi-heading.html'], '风与尘 & 其他故事');
    assertWellFormed('OEBPS/content.opf', files['OEBPS/content.opf']);
    assertWellFormed('OEBPS/toc.ncx', files['OEBPS/toc.ncx']);
    for (const [name, xml] of Object.entries(files)) assertWellFormed(name, xml);
  });
});

describe('detectChapterTitles', () => {
  test('chinese and arabic ordinals parse', () => {
    assert.equal(parseOrdinal('十三'), 13);
    assert.equal(parseOrdinal('一百二十三'), 123);
    assert.equal(parseOrdinal('三十一'), 31);
    assert.equal(parseOrdinal('13'), 13);
  });

  test('a chapter title crammed into one <p> of <br> lines is found for every chapter', async () => {
    const { entries, content } = await detectOn('ibbs-forum-13chapters.html');
    assert.equal(entries.length, 13, `expected 13 chapters, got ${JSON.stringify(entries.map((e) => e.text))}`);
    assert.equal(entries[0].text, '第一卷太后篇第一章');
    assert.equal(entries[12].text, '第一卷太后篇第十三章');
    assert.equal(new Set(entries.map((e) => e.id)).size, 13, 'anchor ids must be unique');
    for (const e of entries) {
      assert.ok(content.includes(`id="${e.id}"`), `anchor ${e.id} was not written back into the content`);
    }
    for (const e of entries) assert.ok(!/发表于|十步杀一人/.test(e.text), `noise leaked: ${e.text}`);
  });

  test('a normal article gets a real hierarchy, not one flat list', async () => {
    const { entries } = await detectOn('multi-heading.html');
    assert.ok(entries.length >= 4, `expected subheadings, got ${entries.length}`);
    assert.equal(entries[0].level, 0, 'the article head should sit at the top level');
    assert.ok(entries.some((e) => e.level > 0), 'subheadings must sit deeper than the head');
    assert.ok(entries.some((e) => e.text === '一、离乡'), 'numbered subheadings must be picked up');
    assert.ok(entries.some((e) => e.text === '槐花'), 'h5 headings must be detected');
    assert.ok(entries.some((e) => e.text === '后记'), 'h6 headings must be detected');
  });

  test('a title alone in a short <p> is found even when it appears only once', async () => {
    const { entries } = await detectOn('standalone-p-titles.html');
    const texts = entries.map((e) => e.text);
    assert.ok(texts.includes('序章'), `序章 missing: ${JSON.stringify(texts)}`);
    assert.ok(texts.includes('第一章 摆渡'), `第一章 摆渡 missing: ${JSON.stringify(texts)}`);
    assert.ok(texts.includes('第二章 书信'), `<strong>-wrapped title missing: ${JSON.stringify(texts)}`);
    assert.ok(texts.includes('尾声'), `尾声 missing: ${JSON.stringify(texts)}`);
  });

  test('single-child labels and dialogue lines are not promoted into the contents', async () => {
    const prose = '　　正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文，说完这段还要再说一段才够长。'.repeat(4);
    const { entries } = await detectChapterTitles(
      `<p>${prose}</p><p>「驾！」</p><p>「将军！」</p><p>分享</p><p>目录</p><p>加入书签</p><p>返回列表</p><p>${prose}</p>`);
    assert.equal(entries.length, 0, `noise became TOC entries: ${JSON.stringify(entries.map((e) => e.text))}`);
  });

  test('repeating title shape is what catches chapters whose title line is too long', async () => {
    const { entries } = await detectOn('long-title-lines.html');
    assert.equal(entries.length, 4, `expected 4 chapters, got ${JSON.stringify(entries.map((e) => e.text.slice(0, 20)))}`);
    assert.deepEqual(entries.map((e) => (e.text.match(/^第.章/) || [''])[0]), ['第一章', '第二章', '第三章', '第四章']);
  });

  test('a heading that duplicates the page title is gone, but the title still cleans to a chapter name', async () => {
    const { entries } = await detectOn('uaa-reader-h1.html');
    assert.equal(entries.length, 0, 'Readability deletes the duplicated h1; detection must not invent one');
    const { extractFromHtml } = await import('@extractus/article-extractor');
    const article = await extractFromHtml(fixture('uaa-reader-h1.html'), URLS['uaa-reader-h1.html']);
    assert.equal(cleanChapterTitle(article.title, 'Test Book'), '第1章');
  });
});

// Structural reads must also go through a real XML parser: an HTML parser ignores
// self-closing foreign elements like <content/>, which corrupts the parent chain.
function xmlNumber(xml, pyProgram) {
  const r = spawnSync('python3', ['-c', pyProgram],
    { input: Buffer.from(xml, 'utf8'), timeout: 15000 });
  // Same reason as in assertWellFormed: a missing or timed-out interpreter sets r.error and leaves
  // r.stderr null, so it has to be handled before anything reads it.
  if (r.error) assert.fail(`python3 probe unavailable (${r.error.code})`);
  if (r.status !== 0) assert.fail(`probe failed: ${r.stderr.toString().trim().split('\n').pop()}`);
  return Number(r.stdout.toString().trim());
}
const NCX_PROBE = (expr) => [
  'import sys,xml.etree.ElementTree as E',
  'r=E.fromstring(sys.stdin.buffer.read())',
  "N='{http://www.daisy.org/z3986/2005/ncx/}'",
  'def dep(e,l=0):',
  '    return max([l]+[dep(c,l+(1 if c.tag==N+"navPoint" else 0)) for c in e])',
  expr,
].join('\n');

// The whole navMap as depth-first {depth, text} rows, so an assertion can name the place a
// label sits instead of only its presence. Same parser as the well-formedness gate on purpose:
// the parent chain is exactly what an HTML tokenizer gets wrong. Flush-left — python -c is
// whitespace-sensitive, so not one of these lines may be indented from JS.
// 副本须同步修 (探针家族): this probe is the 降形 of NAVMAP_PROBE, the navMap reader the two volume
// suites copy from each other (tests/toc-volume-carryover.node-test.mjs,
// tests/toc-volume-e2e.node-test.mjs). Same expat parse and same depth-first navPoint walk, with the
// rows narrowed to {depth, text} — no id, no src, no playOrder, no dtb:depth — because this file
// names a place in the outline instead of following a link. It is a third copy rather than a shared
// import for the same reason those two are two: a broken probe must not take every suite down at
// once. So when a rule the family shares changes — the flush-left discipline, the entity-decoded
// navLabel/text read, the walk's depth counting, or the caller-side r.error / exit-code /
// stdout-head handling — carry it into NAVMAP_PROBE (and its runPython) in both files too. What
// deliberately differs is only the reporting of a missing navMap: NAVMAP_PROBE says so in python
// through exit codes 2/3, this 降形 lets the probe die and names it from navRows' status branch.
const NAV_ROWS_PROBE = [
  'import json, sys, xml.etree.ElementTree as E',
  'r = E.fromstring(sys.stdin.buffer.read())',
  "N = '{http://www.daisy.org/z3986/2005/ncx/}'",
  'rows = []',
  'def walk(el, d = 0):',
  '    for p in el:',
  '        if p.tag == N + "navPoint":',
  '            t = p.find(N + "navLabel/" + N + "text")',
  "            rows.append({'depth': d, 'text': ((t.text if t is not None else '') or '').strip()})",
  '            walk(p, d + 1)',
  'walk(r.find(N + "navMap"))',
  'json.dump(rows, sys.stdout, ensure_ascii=False)',
].join('\n');

function navRows(name, xml) {
  const r = spawnSync('python3', ['-c', NAV_ROWS_PROBE],
    { input: Buffer.from(xml, 'utf8'), timeout: 15000 });
  // A missing interpreter (or a hung one) comes back as r.error with status null, so it has to
  // be handled before anything touches r.stderr — otherwise the failure is an opaque TypeError.
  if (r.error) assert.fail(`${name}: python3 probe unavailable (${r.error.code})`);
  if (r.status !== 0) {
    const err = ((r.stderr || '').toString().trim().split('\n').pop()) || 'parse failed';
    assert.fail(`${name} has no usable navMap -> ${err}\n--- head ---\n${xml.slice(0, 260)}`);
  }
  const out = (r.stdout || '').toString();
  // A probe that died mid-write leaves truncated stdout; naming it beats a bare SyntaxError.
  let rows;
  try {
    rows = JSON.parse(out);
  } catch (e) {
    assert.fail(`${name} navMap probe returned no JSON (${e.message}, exit ${r.status})`
      + `\n--- stdout head ---\n${out.slice(0, 260)}`);
  }
  assert.ok(Array.isArray(rows),
    `${name} navMap probe returned ${out.slice(0, 200)}, not a list of navPoints`);
  return rows;
}

// An indented print of rows, for the messages that must show the tree they just rejected.
const shapeOf = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}- ${r.text}`).join('\n');

// tests/fixtures/toc/ibbs-forum-13chapters.html declares 第一卷太后篇 inside every one of its 13
// chapter labels, so the outline that page yields is that single volume parent plus the 13
// chapters it now holds. The ordinals are the ones the detector assertions above pin.
const IBBS_VOLUME = '第一卷太后篇';
const IBBS_CHAPTERS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三']
  .map((n) => `第${n}章`);

describe('reader table of contents', () => {
  test('a mixed-level article produces genuinely nested navPoints', async () => {
    const files = await build(['multi-heading.html']);
    const ncx = files['OEBPS/toc.ncx'];
    assertWellFormed('OEBPS/toc.ncx', ncx);
    assert.ok(xmlNumber(ncx, NCX_PROBE('print(dep(r.find(N+"navMap")))')) >= 2,
      'navPoints are not nested at all despite a mixed-level article');
    const depth = (ncx.match(/name="dtb:depth"\s+content="(\d+)"/) || [])[1];
    assert.ok(Number(depth) >= 2, `dtb:depth should reflect the nesting, got ${depth}`);
    const labels = textOf(ncx, 'text').map((l) => l.trim());
    assert.ok(labels.indexOf('一、离乡') > labels.indexOf('风与尘'), 'a child must follow its parent');
  });

  test('a volume named inline on all 13 chapters stays one parent, with no invented siblings', async () => {
    const files = await build(['ibbs-forum-13chapters.html']);
    const ncx = files['OEBPS/toc.ncx'];
    assertWellFormed('OEBPS/toc.ncx', ncx);
    const rows = navRows('OEBPS/toc.ncx', ncx);
    // 15 = 1 volume parent + 13 chapter rows + the template's References row. Counted once
    // through this file's own navPoint tally, once through the depth-first walk below. The message
    // names the tally, because that is the value being compared here; rows.length comes from a
    // different probe, and a walk that stopped descending would print a number this assertion
    // never looked at.
    const navPoints = xmlNumber(ncx, NCX_PROBE('print(sum(1 for e in r.iter(N+"navPoint")))'));
    assert.equal(navPoints, 15,
      `expected 1 volume parent + 13 chapters + References, got ${navPoints} navPoints:\n${shapeOf(rows)}`);
    assert.equal(xmlNumber(ncx, NCX_PROBE('print(dep(r.find(N+"navMap")))')), 2,
      `the 13 chapters must nest one step under the volume they name, not beside it:\n${shapeOf(rows)}`);
    const depth = (ncx.match(/name="dtb:depth"\s+content="(\d+)"/) || [])[1];
    assert.equal(Number(depth), 2,
      `a volume/chapter outline is two levels deep, dtb:depth says ${depth}:\n${shapeOf(rows)}`);
    // Each part pinned by position: the volume opens the navMap, its 13 chapters are the next
    // 13 rows at depth 1, and References is the only other top-level row — so no parent was
    // invented for the chapters, and no chapter escaped the volume that was declared for it.
    assert.deepEqual(rows.map((r) => ({ depth: r.depth, text: r.text })),
      [{ depth: 0, text: IBBS_VOLUME }]
        .concat(IBBS_CHAPTERS.map((text) => ({ depth: 1, text })))
        .concat([{ depth: 0, text: 'References' }]),
      `depth-first shape of the navMap must be the volume, its 13 chapters, then References:\n${shapeOf(rows)}`);
  });

  test('entities and inline tags keep the spaces around them in the body', async () => {
    const files = await build(['multi-heading.html']);
    const body = files['OEBPS/chapter2.xhtml'];
    // Scoped to the anchored heading: the chapter template also injects a
    // <h2> with the page title, and that copy never passes through the
    // text-node cleaning step this test is guarding.
    assert.match(body, /<h\d id="toc-h-0">风与尘 &amp; 其他故事<\/h\d>/,
      `spacing around & was destroyed in the body: ${(body.match(/<h\d[^>]*>[^<]{0,40}/g) || ['(none)']).join(' / ')}`);
  });

  test('every TOC link resolves to an anchor that exists in its chapter file', async () => {
    for (const name of ['ibbs-forum-13chapters.html', 'multi-heading.html', 'long-title-lines.html']) {
      const files = await build([name]);
      const links = [...files['OEBPS/toc.ncx'].matchAll(/<content src="([^"#]+)#([^"]+)"\/>/g)]
        .map((m) => ({ file: `OEBPS/${m[1]}`, id: m[2] }));
      assert.ok(links.length >= 4, `${name}: TOC produced no fragment links`);
      for (const { file, id } of links) {
        assert.ok(files[file], `${name}: ${file} referenced by the TOC does not exist`);
        assert.match(files[file], new RegExp(`id="${id}"`),
          `${name}: TOC entry #${id} points at an anchor missing from ${file}`);
      }
    }
  });

  test('a forum page holding 13 chapters yields one volume row and its 13 bare chapter rows', async () => {
    const files = await build(['ibbs-forum-13chapters.html']);
    const rows = navRows('OEBPS/toc.ncx', files['OEBPS/toc.ncx']);
    const texts = rows.map((r) => r.text);
    // All 13 labels declare the same volume and the carry-over reuses the parent it opened,
    // so 第一卷太后篇 is in the outline exactly once — not once per label.
    assert.equal(texts.filter((t) => t === IBBS_VOLUME).length, 1,
      `${IBBS_VOLUME} must become one parent, got ${texts.filter((t) => t === IBBS_VOLUME).length}:\n${shapeOf(rows)}`);
    // decision-table case 5 (see scripts/toc.js:72) moved the prefix out of the child, so no row
    // below the volume still reads 第一卷太后篇第X章.
    assert.deepEqual(texts.filter((t) => t !== IBBS_VOLUME && t.startsWith(IBBS_VOLUME)), [],
      `a chapter row still carries the inline volume prefix:\n${shapeOf(rows)}`);
    // The 13 chapters themselves, in the order the page declares them, one step under the parent.
    assert.deepEqual(rows.slice(1, 1 + IBBS_CHAPTERS.length),
      IBBS_CHAPTERS.map((text) => ({ depth: 1, text })),
      `expected 第一章…第十三章 as the volume's own rows, in order:\n${shapeOf(rows)}`);
    // Parent before child, structurally, and pinned by this assertion together with the
    // slice(1, 14) deepEqual just above: the volume is the navMap's first row and the 13 chapters
    // are rows 1..13, so every chapter's index in `texts` is at least 1 and a reader walking the
    // file meets the volume before any of its chapters. A separate "min chapter index > 0"
    // assertion used to sit here; those two strictly imply it — there is no ordering it could fail
    // while they hold — so it was dropped as a duplicate, not as a property given up.
    assert.equal(texts.indexOf(IBBS_VOLUME), 0,
      `the volume must be the first navPoint of the navMap:\n${shapeOf(rows)}`);
  });

  test('post metadata lines never become TOC entries', async () => {
    const files = await build(['ibbs-forum-13chapters.html']);
    for (const l of textOf(files['OEBPS/toc.ncx'], 'text')) {
      assert.ok(!/发表于|十步杀一人/.test(l), `noise entry leaked into TOC: ${l.trim()}`);
    }
  });

  test('a reader page whose h1 duplicates the title still yields a clean chapter name', async () => {
    const files = await build(['uaa-reader-h1.html']);
    const labels = textOf(files['OEBPS/toc.ncx'], 'text').map((l) => l.trim());
    assert.ok(labels.includes('第1章'), `expected cleaned 第1章, got ${JSON.stringify(labels)}`);
    assert.ok(!labels.some((l) => /UAA小说/.test(l)), `site suffix leaked into TOC: ${JSON.stringify(labels)}`);
  });

  test('the synthetic TOC page is never its own entry nor a References row', async () => {
    const files = await build(['multi-heading.html']);
    const labels = textOf(files['OEBPS/toc.ncx'], 'text').map((l) => l.trim());
    assert.ok(!labels.includes('目录'), 'toc.ncx lists the generated TOC page itself');
    assert.ok(!/目录/.test(files['OEBPS/references.xhtml'] || ''), 'references.xhtml lists the TOC page');
  });

  test('playOrder values stay unique and contiguous over 1..N', async () => {
    const files = await build(['ibbs-forum-13chapters.html', 'uaa-reader-h1.html']);
    const orders = (files['OEBPS/toc.ncx'].match(/playOrder="(\d+)"/g) || [])
      .map((s) => Number(s.match(/\d+/)[0]));
    assert.ok(orders.length > 0, 'no navPoints at all');
    assert.deepEqual(orders, orders.map((_, i) => i + 1),
      `playOrder must be 1..N in depth-first order, got ${JSON.stringify(orders)}`);
  });
});

describe('TXT export does not regress', () => {
  test('txt carries the title, the body and the source url', async () => {
    const { generateTxt } = await import('../scripts/generater.js');
    const blob = await generateTxt({
      title: 'T', includeImages: false,
      sections: [{ url: URLS['multi-heading.html'], html: fixture('multi-heading.html') }],
    });
    const txt = await blob.text();
    assert.ok(/风与尘/.test(txt), 'title missing from txt');
    assert.ok(/长途车上挤满了人/.test(txt), 'body missing from txt');
    assert.ok(/blog\.example\.com/.test(txt), 'source url missing from txt');
    assert.ok(!/<p>/.test(txt), 'raw markup leaked into txt');
  });
});
