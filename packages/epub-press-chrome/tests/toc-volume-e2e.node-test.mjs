// Offline end-to-end acceptance for the volume carry-over (plan todo 7).
//
// What this file proves that the unit + shape suites cannot: the 211 real labels of the
// shipped book, put through the *whole* pipeline (Readability -> detectChapterTitles ->
// buildTocEntries -> buildNavTree -> toc.ncx template), come back as a 216-node, two-level
// outline — and the carry-over still governs a page that yields no titles at all, until the
// host changes. Every number below is pinned by the plan; a deviation is a finding to report,
// not a constant to edit.
//
//   node --test tests/toc-volume-e2e.node-test.mjs
//   TOC_TREE_DUMP=1 node --test tests/toc-volume-e2e.node-test.mjs   (print parents and their spans)
//
// Fixture contract (tests/fixtures/toc/volume-carryover-e2e.html) — read before editing it:
//  * 211 blocks, one per real label from the shipped book:
//      <p id="toc-h-N">标题<br />　　正文行1<br />　　正文行2…</p>
//    Text after the <br /> separators is *required*. Three shapes were measured and all three
//    lose the three 篇章 singletons (第二篇 雪上伤篇 第一章 / 第三篇 月下仙篇 第一章 /
//    第三篇 月下仙篇 番外卷淡黛嫣然 第一章夏日), whose kind is 'seq:篇章' and 'seq:篇卷章':
//    their ordinals are [1,1] / [1] so applyRecurrence (toc.js:221-238) leaves groupSize at 1,
//    and they then need the firstLine bonus (toc.js:210-211) to reach the score-4 gate.
//      <p>标题</p>                  -> 208  (no firstLine at all: 2+1=3)
//      <p>标题<br />正文</p>         -> 208  (brCount 1, no +2)
//      <p>标题<br /><br /></p>       -> 209  (Readability swallows the trailing empty <br />)
//      this fixture                -> 211
//    That is why the pre-flight test below detects on the *extracted* content: detecting
//    straight off the raw fixture reads 211 even for the degenerate shapes, because
//    Readability is where the shape is lost.
//  * Body line counts per block are the real per-block <br /> counts of the shipped
//    chapter2.xhtml divided by 10 (5..29, median 10, real 52..293 median 103), so the
//    distribution's spread survives; the *text* is synthetic — no original wording, and the
//    real book body is 1.02 MB, which no repo should carry.
//  * Add or drop a label and 211 / 216 / the four child counts move together.
//  * The label list itself is NOT read out of the fixture: tests/fixtures/toc/
//    volume-carryover-e2e-labels.txt holds the shipped 211 labels (the first 211 lines of
//    .omo/toc-analysis/labels.txt), one per line, and is pinned by digest. The fixture has to
//    match that file row for row, so editing the fixture cannot quietly redefine the book.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser, NodeFilter } from 'linkedom';
import JSZip from 'jszip';

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
const { detectChapterTitles } = await import('../scripts/toc.js');
const { extractFromHtml } = await import('@extractus/article-extractor');

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'toc');
// The e2e fixture is 192 KB and is read from three places (the block probe, the built book and
// the Readability test), so each name is read once per run and cached.
const FIXTURES = new Map();
// How many times each name actually reached the disk, so the cache itself is asserted on and
// cannot be bypassed by a later readFileSync(join(FIX, ...)) without a test noticing.
const FIXTURE_READS = new Map();
function fixture(name) {
  if (!FIXTURES.has(name)) {
    FIXTURE_READS.set(name, (FIXTURE_READS.get(name) || 0) + 1);
    FIXTURES.set(name, readFileSync(join(FIX, name), 'utf8'));
  }
  return FIXTURES.get(name);
}
const E2E = 'volume-carryover-e2e.html';
// tests/fixtures/toc/volume-carryover-e2e-labels.txt — the 211 shipped labels, one per line,
// checked in as the independent copy of what the fixture claims. See LABELS below.
const LABELS_TXT = 'volume-carryover-e2e-labels.txt';
const URLS = {
  [E2E]: 'https://serial.example.com/book/fenghua-xingyue',
  'volume-carryover.html': 'https://serial.example.com/book/taihou-pian',
  'ibbs-forum-13chapters.html': 'https://www.ibbs.pro/thread/68805aecf30dda264d164fe9',
  'uaa-reader-h1.html': 'https://www.uaa.com/novel/chapter?id=234639',
};

// ─── structural reads: a real XML parser, never a hand-written tokenizer ──────
// Copied, symbol for symbol, from the "structural reads" block of
// tests/toc-volume-carryover.node-test.mjs (WELL_FORMED_PROBE, NAVMAP_PROBE, runPython,
// assertWellFormed, parseNavMap, walk) on purpose: sharing it would make the two suites fall over
// together, and the ncx carries the daisy namespace, so every element name has to be matched on
// local-name. THE TWO COPIES ARE ONE THING: any change here has to be made in that file too, or
// the suites drift apart and stop proving the same shape.
const WELL_FORMED_PROBE = 'import sys,xml.etree.ElementTree as E;E.fromstring(sys.stdin.buffer.read())';
// navMap -> nested JSON, one node per navPoint: {id, src, text, order, depth, children}.
// text/src come back entity-decoded by the parser itself. Flush-left: python -c is
// whitespace-sensitive, so not one of these lines may be indented from JS.
const NAVMAP_PROBE = `
import json, sys, xml.etree.ElementTree as E

def local(tag):
    return tag.rsplit('}', 1)[-1]

def child(el, name):
    return next((c for c in el if local(c.tag) == name), None)

def navpoints(el):
    return [c for c in el if local(c.tag) == 'navPoint']

try:
    root = E.fromstring(sys.stdin.buffer.read())
except E.ParseError as exc:
    print('not well-formed: ' + str(exc), file=sys.stderr)
    sys.exit(2)

navmap = child(root, 'navMap')
if navmap is None:
    print('no navMap element (is the ncx namespace bound?)', file=sys.stderr)
    sys.exit(3)

def convert(el, depth):
    label = child(el, 'navLabel')
    text = child(label, 'text') if label is not None else None
    content = child(el, 'content')
    play = el.get('playOrder')
    return {
        'id': el.get('id'),
        'src': content.get('src') if content is not None else None,
        'text': (text.text or '').strip() if text is not None else None,
        'order': int(play) if play is not None and play.isdigit() else None,
        'depth': depth,
        'children': [convert(c, depth + 1) for c in navpoints(el)],
    }

dtb = ''
head = child(root, 'head')
if head is not None:
    for m in head:
        if local(m.tag) == 'meta' and m.get('name') == 'dtb:depth':
            dtb = m.get('content') or ''

json.dump({'dtbDepth': dtb, 'navPoints': [convert(n, 0) for n in navpoints(navmap)]},
          sys.stdout, ensure_ascii=False)
`;

function runPython(name, script, xml, clause) {
  const r = spawnSync('python3', ['-c', script], { input: Buffer.from(xml, 'utf8') });
  // A missing interpreter comes back as r.error with status null, so it has to be handled
  // before anything touches r.stderr — otherwise the failure is an opaque TypeError.
  if (r.error) assert.fail(`${name}: python3 probe unavailable (${r.error.code})`);
  if (r.status !== 0) {
    const err = ((r.stderr || '').toString().trim().split('\n').pop()) || 'parse failed';
    assert.fail(`${name} ${clause} -> ${err}\n--- head ---\n${xml.slice(0, 260)}`);
  }
  return (r.stdout || '').toString();
}

function assertWellFormed(name, xml) {
  runPython(name, WELL_FORMED_PROBE, xml, 'is not well-formed XML');
}

// The root sentinel is JS-side only, so depth-first rows can name a top-level node's parent.
// `name` is what a failing probe is reported as: pass the part you are reading.
function parseNavMap(name, xml) {
  const out = runPython(`${name} navMap`, NAVMAP_PROBE, xml, 'has no usable navMap');
  assert.ok(out.trim().startsWith('{'), `the navMap probe returned no JSON:\n${out.slice(0, 200)}`);
  const probe = JSON.parse(out);
  assert.ok(Array.isArray(probe.navPoints), 'the navMap probe returned no node list');
  const check = (node) => {
    // The probe reports text: null for a navPoint with no navLabel/text. Naming the node here
    // is the difference between "navpoint-37 lost its label" and a TypeError three layers down.
    assert.notEqual(node.text, null, `navpoint-${node.order} has no navLabel`);
    node.children.forEach(check);
    return node;
  };
  return {
    dtbDepth: probe.dtbDepth,
    root: { id: null, src: null, text: '(root)', order: null, depth: -1, children: probe.navPoints.map(check) },
  };
}

// Every node as { node, depth, parent }, depth-first, so assertions can name the place
// a label sits in rather than just its presence. Top-level rows get the root sentinel as
// their parent, which reads as '(root)'.
function walk(node, depth = 0, parent = null, out = []) {
  for (const child of node.children) {
    // The probe's own depth must agree with the nesting walked here, which is what proves
    // the JSON really is nested rather than a flat list wearing a depth field.
    assert.equal(child.depth, depth, `navpoint-${child.order}: probe depth ${child.depth} at walk depth ${depth}`);
    out.push({ node: child, depth, parent });
    walk(child, depth + 1, child, out);
  }
  return out;
}

// One built book: every xhtml/ncx/opf part of the zip plus the parsed navMap.
// generateEpub rewrites the book it is handed in place, so each run gets its own literal.
async function unpack(title, sections) {
  const blob = await generateEpub({ title, includeImages: false, sections });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const parts = {};
  for (const name of Object.keys(zip.files)) {
    if (!/\.(ncx|opf|xhtml)$/.test(name)) continue;
    // zip.file() hands back null for anything it cannot resolve (a directory entry, a path the
    // generator dropped), so it cannot be chained into .async().
    const entry = zip.file(name);
    assert.ok(entry, `${name} is listed in the archive but zip.file() cannot read it back`);
    parts[name] = await entry.async('string');
  }
  const ncx = parts['OEBPS/toc.ncx'];
  assert.ok(ncx, 'no toc.ncx was produced');
  assertWellFormed('OEBPS/toc.ncx', ncx);
  const nav = parseNavMap('OEBPS/toc.ncx', ncx);
  const rows = walk(nav.root, 0, nav.root);
  const shape = () => `dtb:depth=${nav.dtbDepth} navPoints=${rows.length}\n`
    + nav.root.children.map((c) => `- ${c.text} (${c.children.length})`).join('\n');
  const dump = () => rows.map((r) => `${'  '.repeat(r.depth + 1)}- ${r.node.text} [${r.node.src}]`).join('\n');
  return { parts, ncx, nav, rows, shape, dump };
}

// The fixture's own claim about itself, read with an HTML parser: per block, the title line, the
// <br /> count and the body lines. Compared against the label list below, never the other way
// round — the list is the yardstick the tree assertions are measured with.
function fixtureBlocks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll('p'))
    .filter((p) => /^toc-h-\d+$/.test(p.getAttribute('id') || ''))
    .map((p) => {
      let title = '';
      const after = [];
      let seen = 0;
      for (const node of Array.from(p.childNodes)) {
        if (node.nodeName === 'BR') { seen += 1; continue; }
        if (seen === 0) title += node.textContent;
        else after.push((node.textContent || '').trim());
      }
      return { id: p.getAttribute('id'), title: title.trim(), brs: seen, body: after };
    });
}

const BLOCKS = fixtureBlocks(fixture(E2E));

// tests/fixtures/toc/volume-carryover-e2e-labels.txt is the shipped book's outline as the
// analysis pass recorded it: the first 211 lines of .omo/toc-analysis/labels.txt, one label per
// line, terminated lines and no trailing blank one. The fixture was generated *from* that list,
// so the two files agreeing is the drift detector — the fixture's own title line is the thing
// under test, never the yardstick. Pinned here by digest because the list is the one number this
// whole suite is about:
//   sha256( the 211 lines joined with '\n', with NO trailing '\n' ) , first 16 hex chars
//   python3 - <<'PY'                                   # from the repo root
//   import hashlib
//   L = open('.omo/toc-analysis/labels.txt').read().split('\n')[:211]
//   print(hashlib.sha256('\n'.join(L).encode()).hexdigest()[:16])
//   PY                                                # -> f9690d68dfc023df
//   The committed fixture hashes to that same value with the same recipe: swap the file above
//   for 'packages/epub-press-chrome/tests/fixtures/toc/volume-carryover-e2e-labels.txt' and drop
//   the [:211], and the digest printed is identical.
// One character changed in that txt turns three things red: the verbatim comparison against
// the fixture, the digest, and the detected-label deepEqual further down.
const LABELS_SHA256_16 = 'f9690d68dfc023df';
const LABELS = fixture(LABELS_TXT).split('\n');
if (LABELS[LABELS.length - 1] === '') LABELS.pop(); // the last line's terminator, not a 212th row

// What "the split moved the volume prefix out of the child" means exactly: no child row may
// still *start* with 第X卷/部/辑/篇. Anchored on purpose — 篇 belongs to the set (toc.js:92-98
// scans 卷/部/辑/篇 as volume markers) and an unanchored probe would flag a chapter title that
// merely mentions a volume mid-line. The \s* mirrors SEQ_RE (toc.js:51); the ordinal class is the
// subset of CN_CHARS (toc.js:15) these books actually use, no 〇/两/traditional digit appears in
// the 211 labels. tests/toc-volume-carryover.node-test.mjs keeps the matching copy of this guard
// — change one, change the other.
const VOLUME_PREFIX_RE = /^第\s*[零一二三四五六七八九十百千0-9]+\s*[卷部辑篇]/;

// The four volumes of the shipped book, in the order the labels declare them, with how many
// of the 211 rows each one ends up holding. Derived from the label list: 1-76, 77-116,
// 117-205, 206-211.
const WANT_PARENTS = [
  ['第一卷太后篇', 76, '第一章', '第七十六章'],
  ['第二篇 雪上伤篇', 40, '第一章', '第四十章'],
  ['第三篇 月下仙篇', 89, '第一章', '第八十九章'],
  ['第三篇 月下仙篇 番外卷淡黛嫣然', 6, '第一章夏日', '第六章荡仙'],
];

// ─── the three books this suite reads, built once ────────────────────────────
const main = await unpack('风花雪月楼', [{ url: URLS[E2E], html: fixture(E2E) }]);

// (a) a volume whose children are 回 (level 2), then a page that yields no titles at all.
// Both sections share a host, which is what lets the volume carry over.
const prose = '　　这一段是为测试合成的中性正文，长度足以让抽取器认定这就是文章主体，不含任何原作文字。';
const huiPage = `<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>残编合订 - 某连载</title></head>\n<body><div class="content">
<p>第一卷残编第一回<br />${Array(6).fill(prose).join('<br />')}</p>
<p>${prose.repeat(4)}</p>
<p>第一卷残编第二回<br />${Array(6).fill(prose).join('<br />')}</p>
<p>${prose.repeat(4)}</p>
</div></body></html>\n`;
const noTitlePage = `<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>残编补遗</title></head>\n<body><div class="content">
<p>${prose.repeat(4)}</p><p>${prose.repeat(4)}</p><p>${prose.repeat(4)}</p>
</div></body></html>\n`;
const carryOn = await unpack('残编合订本', [
  { url: 'https://serial.example.com/book/carry-on', html: huiPage },
  { url: 'https://serial.example.com/book/carry-on-buyi', html: noTitlePage },
]);

// (b) same shape, but the second page comes from another host.
const hostBreak = await unpack('太后篇论坛合订', [
  { url: URLS['ibbs-forum-13chapters.html'], html: fixture('ibbs-forum-13chapters.html') },
  { url: URLS['uaa-reader-h1.html'], html: fixture('uaa-reader-h1.html') },
]);

const TREE_DUMP = process.env.TOC_TREE_DUMP !== undefined
  && process.env.TOC_TREE_DUMP !== '' && process.env.TOC_TREE_DUMP !== '0';
if (TREE_DUMP) {
  for (const [label, book] of [['tests/fixtures/toc/' + E2E, main],
    ['case (a) 回-level volume + zero-title page', carryOn],
    ['case (b) host change clears the carry-over', hostBreak]]) {
    console.log(`// ACTUAL tree — ${label}`);
    console.log(book.shape());
    console.log(book.dump());
  }
}

describe('the 211 real labels survive the whole pipeline', () => {
  test('the checked-in label list is the shipped book, verbatim, and hashes to the pinned digest', () => {
    const raw = fixture(LABELS_TXT);
    assert.ok(raw.endsWith('\n') && !raw.endsWith('\n\n'),
      'the label list must end in exactly one line terminator — no trailing blank line');
    assert.equal(LABELS.length, 211, `expected 211 shipped labels, got ${LABELS.length}`);
    for (const [i, label] of LABELS.entries()) {
      assert.ok(label.trim().length > 0 && label.trim() === label,
        `label line ${i + 1} is empty or padded: ${JSON.stringify(label)}`);
    }
    // The fixture's own title line is the thing under test, so it is compared to the list and
    // never used to derive it: one row of either file drifting is a named mismatch here.
    assert.equal(LABELS.length, BLOCKS.length,
      `the list holds ${LABELS.length} labels, the fixture ${BLOCKS.length} blocks`);
    const drifted = LABELS.map((label, i) => [i + 1, label, BLOCKS[i].title, BLOCKS[i].id])
      .filter(([, label, title]) => label !== title).slice(0, 5);
    assert.equal(drifted.length, 0,
      `fixture title lines that are not the shipped label, in order ([line, list, fixture]):\n`
      + drifted.map(([n, l, t, id]) => `${n} ${id}: ${JSON.stringify(l)} != ${JSON.stringify(t)}`).join('\n'));
    assert.equal(createHash('sha256').update(LABELS.join('\n'), 'utf8').digest('hex').slice(0, 16),
      LABELS_SHA256_16,
      `the 211-label digest moved off ${LABELS_SHA256_16}: the list and the shipped book `
      + 'are no longer the same book (recipe above the constant)');
    // The spans the plan quotes, 1-76 / 77-116 / 117-205 / 206-211, restated against the list:
    // each pinned parent is the head of its own label, and each pinned first/last child is the
    // tail of the opening label / the whole closing one. WANT_PARENTS then cannot drift from the
    // book without this line firing, independently of the tree built below.
    const SPANS = [[0, 75], [76, 115], [116, 204], [205, 210]];
    assert.equal(SPANS.reduce((n, [a, b]) => n + (b - a + 1), 0), 211,
      'the four declared spans must tile the label list exactly once');
    for (const [i, [text, count, first, last]] of WANT_PARENTS.entries()) {
      const [start, end] = SPANS[i];
      assert.equal(end - start + 1, count, `span ${i} must hold ${count} labels`);
      assert.ok(LABELS[start].startsWith(text),
        `label ${start + 1} ${JSON.stringify(LABELS[start])} does not open with the parent ${text}`);
      assert.equal(LABELS[start].slice(text.length).trim(), first,
        `the tail of label ${start + 1} must be the pinned first child ${first}`);
      assert.equal(LABELS[end], last, `label ${end + 1} must be the pinned last child ${last}`);
    }
  });

  test('the fixture keeps the shipped block shape: id, title line, then real body', () => {
    assert.equal(BLOCKS.length, 211, `expected 211 toc-h blocks, got ${BLOCKS.length}`);
    assert.deepEqual(BLOCKS.map((b) => b.id), Array.from({ length: 211 }, (_, i) => `toc-h-${i}`),
      'the blocks must be numbered 0..210 in document order');
    for (const b of BLOCKS) {
      assert.ok(b.title, `${b.id} has no title line`);
      assert.ok(b.title.length <= 40, `${b.id} title is past TITLE_MAX_LEN: ${b.title}`);
      assert.ok(b.brs >= 2, `${b.id} has ${b.brs} <br /> — the shape that loses the 篇章 singletons`);
      assert.ok(b.body.length >= 2 && b.body.every(Boolean),
        `${b.id} must carry non-empty text after every <br />, got ${JSON.stringify(b.body.slice(0, 3))}`);
    }
  });

  test('detectChapterTitles still finds all 211 after Readability has had its say', async () => {
    const article = await extractFromHtml(fixture(E2E), URLS[E2E]);
    assert.ok(article && article.content, 'Readability returned no article for the fixture');
    const { entries } = detectChapterTitles(article.content);
    assert.equal(entries.length, 211,
      `Readability ate ${(211 - entries.length)} labels:\n${JSON.stringify(entries.slice(-4).map((e) => e.text))}`);
    assert.deepEqual(entries.map((e) => e.text), LABELS,
      'the label set that reaches the outline must be the checked-in list, in order');
    // Third and last use site of the 192 KB fixture; the two before it (the block probe and the
    // built book) must have been served from the same read.
    assert.equal(FIXTURE_READS.get(E2E), 1,
      `the e2e fixture reached the disk ${FIXTURE_READS.get(E2E)} times, not once`);
  });
});

describe('the rebuilt outline is the shipped book with volumes carried', () => {
  test('navPoint count is 211 chapters + 4 volume parents + References', () => {
    assert.equal(main.rows.length, 216, `expected 4 parents + 211 chapters + References:\n${main.shape()}`);
    assert.equal(main.nav.root.children.length, 5,
      `exactly the 4 volumes and the template References row may sit at the top:\n${main.shape()}`);
    assert.equal(main.rows.filter((r) => r.depth === 0 && r.node.text !== 'References').length, 4,
      `expected 4 volume parents:\n${main.shape()}`);
  });

  test('dtb:depth says the outline really is two levels deep', () => {
    assert.equal(Number(main.nav.dtbDepth), 2,
      `dtb:depth must be 2 for a volume/chapter outline, got ${main.nav.dtbDepth}\n${main.shape()}`);
    assert.equal(Math.max(...main.rows.map((r) => r.depth)), 1,
      `nothing may sit deeper than one step under a volume:\n${main.shape()}`);
  });

  test('the four declared volumes are the parents, each holding its own rows', () => {
    const parents = main.nav.root.children.filter((c) => c.text.trim() !== 'References');
    assert.deepEqual(parents.map((p) => p.text.trim()), WANT_PARENTS.map(([t]) => t),
      `the parents, in order, are the four declared volumes:\n${main.shape()}`);
    let seen = 0;
    for (const [index, [text, count, first, last]] of WANT_PARENTS.entries()) {
      const node = parents[index];
      assert.equal(node.text.trim(), text, `parent ${index} should be ${text}`);
      assert.equal(node.children.length, count,
        `${text} must hold ${count} chapter rows, got ${node.children.length}:\n${main.shape()}`);
      assert.equal(node.children[0].text.trim(), first, `${text}: first child`);
      assert.equal(node.children[node.children.length - 1].text.trim(), last, `${text}: last child`);
      for (const child of node.children) {
        assert.equal(child.depth, 1, `${child.text} must sit one step under ${text}`);
        // Row 5 of the decision table moved the volume prefix out of the child.
        assert.ok(!VOLUME_PREFIX_RE.test(child.text),
          `child still carries an inline volume prefix: ${child.text}`);
        assert.ok(child.text.trim(), `empty navLabel under ${text}`);
      }
      seen += node.children.length;
    }
    assert.equal(seen, 211, 'the four parents together hold every detected row');
  });

  test('a non-volume prefix never becomes a parent node', () => {
    // Row 4: ?第二章 keeps its ? and stays a chapter of the volume in force.
    assert.equal(main.rows.filter((r) => r.node.text.trim() === '?').length, 0,
      `a "?" parent node was invented:\n${main.shape()}`);
    const want = LABELS.filter((l) => l.startsWith('?')).length;
    const q = main.rows.filter((r) => r.node.text.trim().startsWith('?'));
    assert.ok(want > 0, 'the fixture holds no ?-prefixed label at all');
    assert.equal(q.length, want,
      `every one of the ${want} "?第X章" rows must survive verbatim, got ${q.length}:\n${main.shape()}`);
    for (const r of q) {
      assert.equal(r.depth, 1, `${r.node.text} must stay a chapter row`);
      assert.equal(r.parent.text.trim(), '第三篇 月下仙篇',
        `${r.node.text} must sit under the volume in force, not adopt anything`);
      assert.deepEqual(r.node.children, [], `${r.node.text} must not adopt anything`);
    }
  });

  test('every navPoint link resolves inside the book that was written', () => {
    const links = main.rows.map((r) => r.node.src);
    assert.equal(links.length, 216);
    let withAnchor = 0;
    for (const src of links) {
      assert.ok(src, 'a navPoint has no content src');
      const [file, id] = src.split('#');
      const name = file.startsWith('OEBPS/') ? file : `OEBPS/${file}`;
      assert.ok(main.parts[name], `${name} referenced by the TOC does not exist`);
      if (id) {
        withAnchor += 1;
        assert.match(main.parts[name], new RegExp(`id="${id}"`), `${src} points at a missing anchor`);
      }
    }
    // The References row is the template's own and points at a file, not an anchor.
    assert.equal(withAnchor, 215, 'every chapter and volume row must anchor into chapter2.xhtml');
  });

  test('playOrder stays 1..216 in depth-first order', () => {
    assert.deepEqual(main.rows.map((r) => r.node.order),
      Array.from({ length: main.rows.length }, (_, i) => i + 1),
      `playOrder must be contiguous depth-first:\n${main.shape()}`);
  });
});

describe('carry-over across sections, measured on the tree', () => {
  test('(a) a title-less page lands at the child level of the 回 volume it follows', () => {
    const rows = carryOn.rows;
    const volume = rows.filter((r) => r.node.text.trim() === '第一卷残编');
    assert.equal(volume.length, 1, `one 残编 parent:\n${carryOn.shape()}`);
    assert.equal(volume[0].depth, 0);
    assert.deepEqual(volume[0].node.children.map((c) => c.text.trim()),
      ['第一回', '第二回', '残编补遗'],
      `the title-less page must join the 回 rows, one step under the volume:\n${carryOn.shape()}`);
    const [fallback] = rows.filter((r) => r.node.text.trim() === '残编补遗');
    assert.ok(fallback, `no fallback row at all:\n${carryOn.shape()}`);
    assert.equal(fallback.depth, 1,
      'a level-2 fallback under level-2 回 rows stays one step down; a level 0 or 1 fallback '
      + 'would have climbed back out to the top level');
    assert.equal(fallback.parent.text.trim(), '第一卷残编',
      'the fallback must be carried by the volume, not stand beside it');
  });

  test('(b) a different host clears the carry-over, so the fallback stays top level', () => {
    const rows = hostBreak.rows;
    const volume = rows.filter((r) => r.node.text.trim() === '第一卷太后篇');
    assert.equal(volume.length, 1, `the ibbs page must still open exactly one volume:\n${hostBreak.shape()}`);
    assert.equal(volume[0].node.children.length, 13,
      `and hold only its own 13 chapters:\n${hostBreak.shape()}`);
    const [fallback] = rows.filter((r) => r.node.text.trim() === '第1章');
    assert.ok(fallback, `the uaa page produced no fallback row:\n${hostBreak.shape()}`);
    assert.equal(fallback.depth, 0,
      'a level-2 fallback from the ibbs volume would have nested the foreign page inside it');
    assert.equal(fallback.parent.text, '(root)',
      'the uaa fallback must not be adopted by the ibbs volume');
    assert.equal(rows.length, 16, `1 volume + 13 + 1 fallback + References:\n${hostBreak.shape()}`);
    assert.equal(Number(hostBreak.nav.dtbDepth), 2, `the ibbs half is still two levels:\n${hostBreak.shape()}`);
  });
});

// The shipped book itself. Skipped wherever it is not on disk, so the committed suite stays
// reproducible from the repo alone; the numbers below are the frozen baseline and the target.
const REAL_EPUB = '/Users/andyhsu/Downloads/风花雪月楼.epub';
test('smoke, read-only: the shipped ncx is 212 rows at depth 1 and rebuilds to 216 at depth 2',
  { skip: !existsSync(REAL_EPUB) ? `the real book is not at ${REAL_EPUB}` : false }, async () => {
    // A fresh, unique scratch dir per run — never a fixed path, which two concurrent runs would
    // share and which rmSync must then not touch. The directory this deletes is exactly the one
    // mkdtempSync handed back, and nothing else.
    const tmp = mkdtempSync(join(tmpdir(), 'epubpressx-toc-volume-e2e-'));
    try {
      const zip = await JSZip.loadAsync(readFileSync(REAL_EPUB));
      // zip.file() is null for a part the archive does not hold; the .async() chain would then
      // be an opaque TypeError instead of a named part.
      const ncxEntry = zip.file('OEBPS/toc.ncx');
      assert.ok(ncxEntry, `the shipped book has no OEBPS/toc.ncx: ${REAL_EPUB}`);
      const chapterEntry = zip.file('OEBPS/chapter2.xhtml');
      assert.ok(chapterEntry, `the shipped book has no OEBPS/chapter2.xhtml: ${REAL_EPUB}`);
      const orig = await ncxEntry.async('string');
      const chapter = await chapterEntry.async('string');
      // Nothing under Downloads is ever written; both files are copied out for inspection.
      writeFileSync(join(tmp, 'original-toc.ncx'), orig);

      assertWellFormed('the shipped toc.ncx', orig);
      const before = parseNavMap('the shipped toc.ncx', orig);
      const beforeRows = walk(before.root, 0, before.root);
      assert.equal(beforeRows.length, 212, 'frozen baseline: 211 chapters + References');
      assert.equal(Number(before.dtbDepth), 1, 'frozen baseline: the shipped outline is flat');
      assert.equal(before.root.children.filter((c) => c.text.trim() !== 'References').length, 211,
        'frozen baseline: every chapter is a top-level row');

      const rebuilt = await unpack('风花雪月楼', [{
        url: 'https://www.ibbs.pro/thread/68805aecf30dda264d164fe9',
        html: titleShell(chapter, '风花雪月楼'),
      }]);
      writeFileSync(join(tmp, 'rebuilt-toc.ncx'), rebuilt.ncx);
      assert.equal(rebuilt.rows.length, 216, `rebuilt from the real page:\n${rebuilt.shape()}`);
      assert.equal(Number(rebuilt.nav.dtbDepth), 2, `rebuilt from the real page:\n${rebuilt.shape()}`);
      assert.deepEqual(rebuilt.nav.root.children.filter((c) => c.text.trim() !== 'References')
        .map((c) => `${c.text.trim()}=${c.children.length}`),
      WANT_PARENTS.map(([t, n]) => `${t}=${n}`), `rebuilt parents:\n${rebuilt.shape()}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

// The real page is one huge <div> of <p id="toc-h-N"> blocks plus the reader's own page
// heading; only the 211 labelled blocks go into the shell, because the page <h1> would add a
// 212th entry. A bare fragment is not enough: Readability returns null without a document.
function titleShell(xhtml, title) {
  const doc = new DOMParser().parseFromString(xhtml, 'text/html');
  const blocks = Array.from(doc.querySelectorAll('p'))
    .filter((p) => /^toc-h-\d+$/.test(p.getAttribute('id') || ''))
    .map((p) => new XMLSerializer().serializeToString(p));
  assert.equal(blocks.length, 211, 'the shipped page must contribute exactly 211 blocks');
  return `<html><head><title>${title}</title></head><body>${blocks.join('\n')}</body></html>`;
}
