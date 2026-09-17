// Tree-shape acceptance for the volume carry-over (plan todo 6).
//
// Why this file exists separately from toc-volume-split.node-test.mjs: those unit tests
// only prove splitVolumeEntry returns the right pieces for one label. Nothing there can
// see whether buildTocEntries actually (a) reuses ONE parent when the same volume is
// declared again, (b) starts a SECOND parent when a volume key comes back after a
// different one (A→B→A), (c) keeps carrying the last declared volume across chapters that
// name no volume at all, or (d) leaves a chapter marker whose prefix is not a volume
// alone. Those are properties of the tree the reader sees, so they are asserted on the
// navMap of the generated toc.ncx — built from a real fixture through generateEpub.
//
// Decision-table rows referenced below are the ones in scripts/toc.js:splitVolumeEntry.
//
// Fixture contract (tests/fixtures/toc/volume-carryover.html) — read this before editing it:
//  * 13 labels, each a `<p>` of at most TITLE_MAX_LEN (40) chars with its own long body `<p>`
//    after it (the tests/toc-matrix.node-test.mjs:60-62 shape), no `<br>`. Drop that body and
//    the label dies during DETECTION, failing the coverage test rather than a shape one.
//  * Add or remove a label and three things here move together: the want list, every child
//    list deepEqual below, and the 21 = 7 parents + 13 chapters + References total.
//  * Which row of scripts/toc.js:splitVolumeEntry each label proves: 第一卷太后篇第一章 row 5
//    split; 第1卷太后篇第二十一章 arabic and 汉字 ordinals merge; 第五十一章 row 3 bare carry;
//    ?第二章 row 4 (prefix without 卷/部/辑/篇, no split); 第二篇 雪上伤篇 row 5 at 篇 level;
//    第三篇 月下仙篇 番外卷淡黛嫣然 last volume marker wins, text after the chapter kept;
//    第一卷甲篇/第二卷乙篇/第一卷甲篇 dedup is per current volume; 残编第X回 + 第八十八章 回
//    children one step under the volume, next bare chapter escapes back out.
//
//   node --test tests/toc-volume-carryover.node-test.mjs
//   TOC_TREE_DUMP=1 node --test tests/toc-volume-carryover.node-test.mjs   (print the ACTUAL tree)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser, NodeFilter } from 'linkedom';
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

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'toc');
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');
const URLS = {
  'volume-carryover.html': 'https://serial.example.com/book/taihou-pian',
};

// generateEpub rewrites the book it is handed in place (id, pages, tocNavXml, tocNavDepth),
// so the literal stays inside the generator: a second run must never see a dirty book.
const parts = await (async () => {
  const book = {
    title: '太后篇合订本',
    includeImages: false,
    sections: [{ url: URLS['volume-carryover.html'], html: fixture('volume-carryover.html') }],
  };
  const blob = await generateEpub(book);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const files = {};
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith('.ncx') && !name.endsWith('.opf') && !name.endsWith('.xhtml')) continue;
    // zip.file() hands back null for anything it cannot resolve (a directory entry, a path the
    // generator dropped), so it cannot be chained into .async().
    const entry = zip.file(name);
    assert.ok(entry, `${name} is listed in the archive but zip.file() cannot read it back`);
    files[name] = await entry.async('string');
  }
  return files;
})();

const NCX = parts['OEBPS/toc.ncx'];

// Every structural read goes through a real XML parser — python's stdlib ElementTree, i.e.
// expat — because that is what a reader does with the file, and because a hand-written
// tokenizer would mirror the template's layout (attribute order, where the line breaks are)
// and break on a reindent that changed nothing a reader cares about. Well-formedness is
// checked with python on purpose too: linkedom accepts both an unbound prefix and a bare
// '&', while every reader that parses these files rejects both.
// The "structural reads" block of tests/toc-volume-e2e.node-test.mjs keeps the second,
// deliberately unshared copy of everything below (WELL_FORMED_PROBE, NAVMAP_PROBE, runPython,
// assertWellFormed, parseNavMap, walk) so a broken probe cannot take both suites down at once —
// which means the two copies have to be fixed together: change one, change the other, or the
// suites stop proving the same shape.
// The third member of that probe family is NAV_ROWS_PROBE in tests/toc.node-test.mjs: a 降形 of the
// NAVMAP_PROBE below, returning depth-first {depth, text} rows only. Its shared rules sync the
// same way.
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
  // 15s is far above the ~50ms these probes take and far below a test run worth waiting for;
  // a wedged interpreter comes back as r.error (code ETIMEDOUT) and rides the branch below.
  const r = spawnSync('python3', ['-c', script], { input: Buffer.from(xml, 'utf8'), timeout: 15000 });
  // A missing interpreter comes back as r.error with status null, so it has to be handled
  // before anything touches r.stderr — otherwise the failure is an opaque TypeError.
  if (r.error) assert.fail(`${name}: python3 probe unavailable (${r.error.code})`);
  if (r.status !== 0) {
    const err = ((r.stderr || '').toString().trim().split('\n').pop()) || 'parse failed';
    assert.fail(`${name} ${clause} -> ${err}\n--- head ---\n${xml.slice(0, 260)}`);
  }
  // The exit code travels with the stdout, so a caller that parses it can name it too.
  return { out: (r.stdout || '').toString(), status: r.status };
}

function assertWellFormed(name, xml) {
  runPython(name, WELL_FORMED_PROBE, xml, 'is not well-formed XML');
}

// The root sentinel is JS-side only, so depth-first rows can name a top-level node's parent.
// `name` is what a failing probe is reported as: pass the part you are reading.
function parseNavMap(name, xml) {
  const { out, status } = runPython(`${name} navMap`, NAVMAP_PROBE, xml, 'has no usable navMap');
  assert.ok(out.trim().startsWith('{'), `the navMap probe returned no JSON:\n${out.slice(0, 200)}`);
  // Output that starts with '{' and still will not parse means a truncated probe run; naming the
  // exit code and the stdout head is what separates that from a malformed ncx.
  let probe;
  try {
    probe = JSON.parse(out);
  } catch (e) {
    assert.fail(`${name} navMap probe returned unparseable JSON (${e.message}, exit ${status})`
      + `\n--- stdout head ---\n${out.slice(0, 260)}`);
  }
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

// Ordered on purpose: a missing part or a broken ncx has to be reported by these two lines,
// before parseNavMap gets a chance to crash on the same file with a less authoritative word.
assert.ok(NCX, 'no toc.ncx was produced');
assertWellFormed('OEBPS/toc.ncx', NCX);
const NAVMAP = parseNavMap('OEBPS/toc.ncx', NCX);
const tree = NAVMAP.root;

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
const all = walk(tree, 0, tree);
const dump = (node = tree, depth = 0) => node.children
  .map((c) => `${'  '.repeat(depth)}- ${c.text}\n${dump(c, depth + 1)}`).join('');
const shape = () => `navPoints=${all.length}\n${dump()}`;
// All nodes carrying a given label, in document order.
const byText = (text) => all.filter((r) => r.node.text === text);
const childTexts = (node) => node.children.map((c) => c.text);

// What "the split moved the volume prefix out of the child" means exactly: no child row may
// still *start* with 第X卷/部/辑/篇. Anchored on purpose — 篇 belongs to the set (toc.js:92-98
// scans 卷/部/辑/篇 as volume markers) and an unanchored probe would flag a chapter title that
// merely mentions a volume mid-line. The \s* mirrors SEQ_RE (toc.js:51); the ordinal class is the
// subset of CN_CHARS (toc.js:15) these fixtures use, no 〇/两/traditional digit appears in them.
// tests/toc-volume-e2e.node-test.mjs keeps the matching copy of this guard — change one, change
// the other.
const VOLUME_PREFIX_RE = /^第\s*[零一二三四五六七八九十百千0-9]+\s*[卷部辑篇]/;

// '0' is a string, so it has to be ruled out explicitly to mean "off".
const TREE_DUMP = process.env.TOC_TREE_DUMP !== undefined
  && process.env.TOC_TREE_DUMP !== '' && process.env.TOC_TREE_DUMP !== '0';
if (TREE_DUMP) {
  console.log('// ACTUAL tree built from tests/fixtures/toc/volume-carryover.html');
  console.log(shape());
  console.log('dtb:depth =', NAVMAP.dtbDepth);
}

describe('volume carry-over builds a two-level outline', () => {
  test('the produced ncx parses strictly and no navLabel is empty', () => {
    assert.ok(NCX, 'no toc.ncx was produced');
    assertWellFormed('OEBPS/toc.ncx', NCX);
    assert.ok(all.length > 0, `no navPoints at all:\n${shape()}`);
    for (const { node, depth } of all) {
      assert.ok((node.text || '').trim(), `empty navLabel at depth ${depth}:\n${shape()}`);
    }
  });

  test('the fixture really carries every label the shape matrix needs', () => {
    const labels = new Set(all.map((r) => r.node.text));
    for (const want of [
      '第一卷太后篇', '第一章', '第二十一章', '第五十一章',
      '第二篇 雪上伤篇', '?第二章', '第十一章',
      '第三篇 月下仙篇 番外卷淡黛嫣然', '第一章夏日',
      '第一卷甲篇', '第二卷乙篇', '第二章',
      '第一卷残编', '第一回', '第二回', '第八十八章',
    ]) {
      assert.ok(labels.has(want), `label ${want} never reached the outline:\n${shape()}`);
    }
  });

  // table row 5 (split) + the key rule (阿拉伯 / 汉字 ordinals merge) + row 3 (bare chapter
  // carries the volume that was declared earlier).
  test('one declared volume stays a single parent and carries its bare chapters', () => {
    const parents = byText('第一卷太后篇');
    assert.equal(parents.length, 1, `expected exactly one 第一卷太后篇 parent:\n${shape()}`);
    const [{ node }] = parents;
    assert.equal(parents[0].depth, 0, 'the volume parent must sit at the top level');
    assert.deepEqual(childTexts(node), ['第一章', '第二十一章', '第五十一章'],
      `第一卷太后篇 must hold its own chapter, the arabic-ordinal one and the bare one:\n${shape()}`);
    // Nothing may keep the volume prefix inside a child: the split moved it out.
    for (const child of node.children) {
      assert.ok(!VOLUME_PREFIX_RE.test(child.text),
        `child still carries an inline volume prefix: ${child.text}`);
    }
  });

  // table row 4: the prefix holds no volume-level marker, so the label is not split at all.
  test('a chapter marker with a non-volume prefix yields no parent and keeps its own text', () => {
    assert.equal(byText('?').length, 0, `a "?" parent node was invented:\n${shape()}`);
    assert.equal(byText('?第二章').length, 1, `?第二章 must appear verbatim exactly once:\n${shape()}`);
    const [{ node, parent }] = byText('?第二章');
    assert.deepEqual(node.children, [], '?第二章 must not adopt anything');
    assert.equal(parent.text, '第二篇 雪上伤篇',
      `?第二章 must stay a child of the volume in force, not become a parent:\n${shape()}`);
  });

  // table row 5 for a 篇-level volume: a different key starts a new top-level parent.
  test('a new volume heading becomes its own top-level parent', () => {
    const parents = byText('第二篇 雪上伤篇');
    assert.equal(parents.length, 1, `expected one 雪上伤篇 parent:\n${shape()}`);
    assert.equal(parents[0].depth, 0, 'a new volume must close the previous one, not nest in it');
    assert.deepEqual(childTexts(parents[0].node), ['第一章', '?第二章', '第十一章'],
      `雪上伤篇 children wrong:\n${shape()}`);

    const fanwai = byText('第三篇 月下仙篇 番外卷淡黛嫣然');
    assert.equal(fanwai.length, 1, `expected one 月下仙篇 parent:\n${shape()}`);
    assert.equal(fanwai[0].depth, 0, `月下仙篇 must be a top-level parent:\n${shape()}`);
    assert.deepEqual(childTexts(fanwai[0].node), ['第一章夏日'],
      `the child must start at the last chapter marker and keep the text after it:\n${shape()}`);
  });

  // Dedup is per current volume, not global: coming back to a key must open a new parent.
  test('A→B→A produces two parents for A, each with its own child', () => {
    const a = byText('第一卷甲篇');
    assert.equal(a.length, 2, `A→B→A must open A twice:\n${shape()}`);
    assert.deepEqual(a.map((r) => r.depth), [0, 0], 'both A parents must be top level');
    assert.deepEqual(a.map((r) => childTexts(r.node)), [['第一章'], ['第二章']],
      `each A parent must hold only the chapters that followed it:\n${shape()}`);
    assert.equal(byText('第二卷乙篇').length, 1, `B must appear once:\n${shape()}`);
    assert.deepEqual(childTexts(byText('第二卷乙篇')[0].node), ['第一章']);
    const order = all.map((r) => r.node.text);
    assert.ok(order.indexOf('第一卷甲篇') < order.indexOf('第二卷乙篇'),
      'the first A must precede B');
    assert.ok(order.lastIndexOf('第一卷甲篇') > order.indexOf('第二卷乙篇'),
      'the second A must follow B');
  });

  // 回 is a chapter-level marker whose entry level is 2, so the split parent is level 0 and
  // the child level 2. The level is observable structurally: the next bare chapter (level 1)
  // climbs back *out* of the 回 volume, which only happens when the 回 children really sit
  // one level below the volume rather than at chapter level.
  test('a 回-level volume sits at depth 0 with its 回 children at depth 1', () => {
    const hui = byText('第一卷残编');
    assert.equal(hui.length, 1, `expected one 残编 parent:\n${shape()}`);
    assert.equal(hui[0].depth, 0, 'the parent of a 回 volume must be level 0');
    assert.deepEqual(childTexts(hui[0].node), ['第一回', '第二回'],
      `回 labels must be the children, stripped of the volume prefix:\n${shape()}`);
    for (const { depth } of byText('第一回').concat(byText('第二回'))) {
      assert.equal(depth, 1, 'the 回 children must sit one step under the volume');
    }
    const after = byText('第八十八章');
    assert.equal(after.length, 1, `第八十八章 must appear exactly once:\n${shape()}`);
    assert.equal(after[0].depth, 0,
      `a level-1 chapter after level-2 回 children must escape back to the top level, `
      + `which proves the 回 entries are level 2 and not level 1:\n${shape()}`);
    assert.notEqual(after[0].parent.text, '第一卷残编',
      `第八十八章 must not be adopted by the 回 volume:\n${shape()}`);
  });

  test('the outline is genuinely two levels deep and the template row survives', () => {
    assert.equal(Number(NAVMAP.dtbDepth), 2, `dtb:depth must be 2 for a volume/chapter outline, got ${NAVMAP.dtbDepth}\n${shape()}`);
    assert.ok(Math.max(...all.map((r) => r.depth)) === 1, `deepest node must be one step below a volume:\n${shape()}`);
    assert.equal(all.length, 21, `expected 7 volume parents + 13 chapter rows + References:\n${shape()}`);
    assert.deepEqual([...new Set(all.map((r) => r.node.order))].sort((x, y) => x - y),
      Array.from({ length: all.length }, (_, i) => i + 1),
      `playOrder must stay 1..N in depth-first order:\n${shape()}`);
    assert.equal(byText('References').length, 1, `the References row must survive exactly once:\n${shape()}`);
  });

  test('every navPoint link resolves to an anchor that exists in its chapter file', () => {
    const links = all.map((r) => r.node.src);
    for (const src of links) {
      assert.ok(src, 'a navPoint has no content src');
      const [file, id] = src.split('#');
      const name = file.startsWith('OEBPS/') ? file : `OEBPS/${file}`;
      assert.ok(parts[name], `${name} referenced by the TOC does not exist`);
      if (id) assert.match(parts[name], new RegExp(`id="${id}"`), `${src} points at a missing anchor`);
    }
  });
});
