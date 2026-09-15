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
  const r = spawnSync('python3',
    ['-c', 'import sys,xml.etree.ElementTree as E;E.fromstring(sys.stdin.buffer.read())'],
    { input: Buffer.from(xml, 'utf8') });
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
  const r = spawnSync('python3', ['-c', pyProgram], { input: Buffer.from(xml, 'utf8') });
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

  test('sibling chapters with no volume heading stay flat, without invented parents', async () => {
    const files = await build(['ibbs-forum-13chapters.html']);
    const ncx = files['OEBPS/toc.ncx'];
    assertWellFormed('OEBPS/toc.ncx', ncx);
    assert.equal(xmlNumber(ncx, NCX_PROBE('print(dep(r.find(N+"navMap")))')), 1,
      '13 same-level chapters must not be nested under each other');
    assert.equal(xmlNumber(ncx, NCX_PROBE('print(sum(1 for e in r.iter(N+"navPoint")))')), 14,
      'expected 13 chapter navPoints plus References');
    const depth = (ncx.match(/name="dtb:depth"\s+content="(\d+)"/) || [])[1];
    assert.equal(Number(depth), 1, 'a flat list is one level deep');
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

  test('a forum page holding 13 chapters yields 13 TOC entries', async () => {
    const files = await build(['ibbs-forum-13chapters.html']);
    const labels = textOf(files['OEBPS/toc.ncx'], 'text');
    const want = Array.from({ length: 13 }, (_, i) =>
      `第一卷太后篇第${['一','二','三','四','五','六','七','八','九','十','十一','十二','十三'][i]}章`);
    for (const w of want) {
      assert.ok(labels.some((l) => l.trim() === w), `missing TOC entry: ${w}`);
    }
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
